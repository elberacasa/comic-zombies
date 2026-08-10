/**
 * INPUT — raw devices in, `ActionName` edges out.
 *
 * Design rules:
 *  • Nothing outside this file ever looks at a KeyboardEvent. Systems ask for actions.
 *  • Edges are frame-coherent: events that arrive mid-frame are buffered and published by
 *    `beginFrame()`, so every system sees the exact same input state for the whole frame, and
 *    a tap that starts and ends between two frames is never swallowed.
 *  • Mouse look is RAW. `movementX/Y` straight from pointer lock, multiplied by a
 *    radians-per-pixel sensitivity, with no smoothing and no acceleration — an FPS lives or dies
 *    on this and any filtering here would be felt immediately.
 *  • Robust by default: losing focus, alt-tabbing or exiting pointer lock releases every key,
 *    so nobody comes back to a window with the sprint key stuck down.
 */

import type { ActionName, GameCtx, InputService, System } from '@/core/types';

// ─────────────────────────────────────────────────────────────────────────────
// Bindings
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `KeyboardEvent.code` → action. Physical keys, so WASD stays WASD on an AZERTY keyboard.
 * Mutable on purpose: a settings screen rebinds by writing here, then calling `input.clearAll()`.
 */
export const Keybinds: Record<string, ActionName> = {
  KeyW: 'forward',
  ArrowUp: 'forward',
  KeyS: 'back',
  ArrowDown: 'back',
  KeyA: 'left',
  ArrowLeft: 'left',
  KeyD: 'right',
  ArrowRight: 'right',

  Space: 'jump',
  ControlLeft: 'crouch',
  ControlRight: 'crouch',
  KeyC: 'crouch',
  ShiftLeft: 'sprint',
  ShiftRight: 'sprint',

  KeyR: 'reload',
  KeyF: 'interact',
  KeyE: 'interact',
  KeyQ: 'swap',
  KeyV: 'melee',
  KeyG: 'grenade',

  Escape: 'pause',
  Tab: 'scoreboard',
};

/** `MouseEvent.button` → action. 0 left, 1 middle, 2 right. */
export const MouseBinds: Record<number, ActionName> = {
  0: 'fire',
  1: 'melee',
  2: 'aim',
};

/** Keys the browser would otherwise steal even when we are not pointer-locked. */
const ALWAYS_PREVENT = new Set<string>(['Tab', 'Space']);

const ACTIONS: readonly ActionName[] = [
  'forward', 'back', 'left', 'right',
  'jump', 'crouch', 'sprint',
  'fire', 'aim', 'reload', 'interact',
  'swap', 'melee', 'grenade',
  'pause', 'scoreboard',
];

const ACTION_INDEX: Record<ActionName, number> = (() => {
  const m = {} as Record<ActionName, number>;
  for (let i = 0; i < ACTIONS.length; i++) m[ACTIONS[i]] = i;
  return m;
})();

const N = ACTIONS.length;

/** Radians of yaw per pixel of mouse travel. ~0.0022 is a common 800-DPI shooter feel. */
export const DEFAULT_SENSITIVITY = 0.0022;

export interface InputOptions {
  sensitivity?: number;
  invertY?: boolean;
  /** Ask the OS for unfiltered mouse deltas (no pointer acceleration). Chromium only. */
  rawMouse?: boolean;
  /** Treat losing pointer lock (Esc) as a press of `pause`. */
  pauseOnLockLost?: boolean;
}

type PointerLockFn = (options?: { unadjustedMovement?: boolean }) => Promise<void> | void;

function isEditableTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || !el.tagName) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable === true;
}

// ─────────────────────────────────────────────────────────────────────────────
// The service
// ─────────────────────────────────────────────────────────────────────────────

export class InputSystem implements InputService, System {
  readonly name = 'input';

  /** Radians per pixel. */
  sensitivity: number;
  invertY: boolean;
  /** Multiplier applied while aiming down sights — the weapon system writes this. */
  adsSensitivityMult = 1;
  /** When false, every action reads as released. Menus flip this. */
  enabled = true;
  pauseOnLockLost: boolean;

  readonly lookDelta = { x: 0, y: 0 };
  /** Unscaled pointer delta in pixels this frame — for cursor-driven UI. */
  readonly lookRaw = { x: 0, y: 0 };
  readonly moveAxis = { x: 0, y: 0 };

  /** Signed wheel notches this frame: +1 up, -1 down. Weapon swap direction. */
  wheel = 0;

  private readonly element: HTMLElement;
  private readonly rawMouse: boolean;

  private readonly _down = new Uint8Array(N);
  private readonly _pressed = new Uint8Array(N);
  private readonly _released = new Uint8Array(N);
  private readonly _pendPressed = new Uint8Array(N);
  private readonly _pendReleased = new Uint8Array(N);

  private _pendLookX = 0;
  private _pendLookY = 0;
  private _pendWheel = 0;
  private _locked = false;
  private _disposed = false;

  constructor(element: HTMLElement, opts: InputOptions = {}) {
    this.element = element;
    this.sensitivity = opts.sensitivity ?? DEFAULT_SENSITIVITY;
    this.invertY = opts.invertY ?? false;
    this.rawMouse = opts.rawMouse ?? true;
    this.pauseOnLockLost = opts.pauseOnLockLost ?? true;
    this.attach();
  }

  init(_ctx: GameCtx): void { /* listeners are live from construction */ }

  // ── queries ────────────────────────────────────────────────────────────────

  down(a: ActionName): boolean { return this.enabled && this._down[ACTION_INDEX[a]] === 1; }
  pressed(a: ActionName): boolean { return this.enabled && this._pressed[ACTION_INDEX[a]] === 1; }
  released(a: ActionName): boolean { return this.enabled && this._released[ACTION_INDEX[a]] === 1; }

  get pointerLocked(): boolean { return this._locked; }

  /** Any action pressed this frame — "press any key to start". */
  anyPressed(): boolean {
    for (let i = 0; i < N; i++) if (this._pressed[i] === 1) return true;
    return false;
  }

  // ── frame lifecycle (driven by GameLoop) ───────────────────────────────────

  /** Publish everything buffered since the last frame. Call before any system reads input. */
  beginFrame(): void {
    for (let i = 0; i < N; i++) {
      this._pressed[i] = this._pendPressed[i];
      this._released[i] = this._pendReleased[i];
      this._pendPressed[i] = 0;
      this._pendReleased[i] = 0;
    }

    const s = this.sensitivity * this.adsSensitivityMult;
    this.lookRaw.x = this._pendLookX;
    this.lookRaw.y = this._pendLookY;
    this.lookDelta.x = this._pendLookX * s;
    this.lookDelta.y = this._pendLookY * s * (this.invertY ? -1 : 1);
    this._pendLookX = 0;
    this._pendLookY = 0;

    this.wheel = this._pendWheel;
    this._pendWheel = 0;

    this.updateMoveAxis();
  }

  /** Drop this frame's edges so late readers (render, debug) never see stale input. */
  endFrame(): void {
    this._pressed.fill(0);
    this._released.fill(0);
    this.lookDelta.x = 0;
    this.lookDelta.y = 0;
    this.lookRaw.x = 0;
    this.lookRaw.y = 0;
    this.wheel = 0;
  }

  // ── pointer lock ───────────────────────────────────────────────────────────

  requestPointerLock(): void {
    if (this._locked || this._disposed) return;
    const fn = this.element.requestPointerLock as unknown as PointerLockFn;
    try {
      const res = this.rawMouse
        ? fn.call(this.element, { unadjustedMovement: true })
        : fn.call(this.element);
      if (res && typeof (res as Promise<void>).catch === 'function') {
        (res as Promise<void>).catch(() => {
          // Raw mouse rejected (unsupported / not user-gesture): fall back to the plain request.
          try {
            const retry = (this.element.requestPointerLock as unknown as PointerLockFn)
              .call(this.element);
            // THE FALLBACK RETURNS A PROMISE TOO, and Chrome rejects it with SecurityError /
            // WrongDocumentError often enough that leaving it bare shows up as an unhandled
            // rejection in the console — which is indistinguishable from a real error to anyone
            // reading the log. A failed lock is a non-event: the next click retries.
            if (retry && typeof (retry as Promise<void>).catch === 'function') {
              (retry as Promise<void>).catch(() => { /* the user will click again */ });
            }
          } catch { /* the user will click again */ }
        });
      }
    } catch { /* ignore — a later click will retry */ }
  }

  exitPointerLock(): void {
    if (document.pointerLockElement === this.element) document.exitPointerLock();
  }

  /** Release everything. Called on blur, on lock loss, and by menus. */
  clearAll(): void {
    for (let i = 0; i < N; i++) {
      if (this._down[i] === 1) this._pendReleased[i] = 1;
      this._down[i] = 0;
    }
    this._pendLookX = 0;
    this._pendLookY = 0;
    this._pendWheel = 0;
    this.moveAxis.x = 0;
    this.moveAxis.y = 0;
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    this.detach();
  }

  // ── internals ──────────────────────────────────────────────────────────────

  /** +x is strafe right, +y is forward. Diagonals are normalised so they are never faster. */
  private updateMoveAxis(): void {
    if (!this.enabled) { this.moveAxis.x = 0; this.moveAxis.y = 0; return; }
    let x = 0;
    let y = 0;
    if (this._down[ACTION_INDEX.right] === 1) x += 1;
    if (this._down[ACTION_INDEX.left] === 1) x -= 1;
    if (this._down[ACTION_INDEX.forward] === 1) y += 1;
    if (this._down[ACTION_INDEX.back] === 1) y -= 1;
    const l2 = x * x + y * y;
    if (l2 > 1) {
      const inv = 1 / Math.sqrt(l2);
      x *= inv;
      y *= inv;
    }
    this.moveAxis.x = x;
    this.moveAxis.y = y;
  }

  private setDown(idx: number): void {
    if (this._down[idx] === 1) return;
    this._down[idx] = 1;
    this._pendPressed[idx] = 1;
  }

  private setUp(idx: number): void {
    if (this._down[idx] === 0) return;
    this._down[idx] = 0;
    this._pendReleased[idx] = 1;
  }

  /**
   * A press edge with no matching hold — wheel swap, lock-loss pause. Deliberately does not
   * emit a `released` edge, because nothing was ever held down.
   */
  private pulse(a: ActionName): void {
    this._pendPressed[ACTION_INDEX[a]] = 1;
  }

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (e.repeat || isEditableTarget(e.target)) return;
    const action = Keybinds[e.code];
    if (action === undefined) return;
    if (!e.metaKey && !e.altKey && (this._locked || ALWAYS_PREVENT.has(e.code))) e.preventDefault();
    this.setDown(ACTION_INDEX[action]);
  };

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    const action = Keybinds[e.code];
    if (action === undefined) return;
    if (!e.metaKey && !e.altKey && (this._locked || ALWAYS_PREVENT.has(e.code))) e.preventDefault();
    this.setUp(ACTION_INDEX[action]);
  };

  private readonly onMouseDown = (e: MouseEvent): void => {
    if (!this._locked) {
      // First click captures the mouse instead of firing a shot into the menu.
      //
      // `instanceof Node` is load-bearing, not defensive noise: a `MouseEvent` dispatched on
      // `window` (which is what a UI layer's own synthetic click, or a test harness, produces)
      // has `window` as its target, and `Node.contains(window)` THROWS. The old `as Node | null`
      // cast asserted something the DOM does not guarantee and turned that into an uncaught
      // TypeError inside a listener.
      const t: EventTarget | null = e.target;
      if (t instanceof Node && (t === this.element || t === document.body || this.element.contains(t))) {
        this.requestPointerLock();
      }
      return;
    }
    const action = MouseBinds[e.button];
    if (action === undefined) return;
    e.preventDefault();
    this.setDown(ACTION_INDEX[action]);
  };

  private readonly onMouseUp = (e: MouseEvent): void => {
    const action = MouseBinds[e.button];
    if (action === undefined) return;
    this.setUp(ACTION_INDEX[action]);
  };

  private readonly onMouseMove = (e: MouseEvent): void => {
    if (!this._locked) return;
    // Accumulate: a 240Hz mouse fires several of these per rendered frame and every one counts.
    this._pendLookX += e.movementX;
    this._pendLookY += e.movementY;
  };

  private readonly onWheel = (e: WheelEvent): void => {
    if (!this._locked) return;
    e.preventDefault();
    if (e.deltaY === 0) return;
    this._pendWheel += e.deltaY > 0 ? -1 : 1;
    this.pulse('swap');
  };

  private readonly onContextMenu = (e: Event): void => { e.preventDefault(); };

  private readonly onBlur = (): void => { this.clearAll(); };

  private readonly onPointerLockChange = (): void => {
    const locked = document.pointerLockElement === this.element;
    const lost = this._locked && !locked;
    this._locked = locked;
    if (lost) {
      this.clearAll();
      if (this.pauseOnLockLost) this.pulse('pause');
    }
  };

  private readonly onCanvasClick = (): void => {
    if (!this._locked) this.requestPointerLock();
  };

  private attach(): void {
    window.addEventListener('keydown', this.onKeyDown, { passive: false });
    window.addEventListener('keyup', this.onKeyUp, { passive: false });
    window.addEventListener('mousedown', this.onMouseDown, { passive: false });
    window.addEventListener('mouseup', this.onMouseUp);
    window.addEventListener('mousemove', this.onMouseMove);
    window.addEventListener('wheel', this.onWheel, { passive: false });
    window.addEventListener('blur', this.onBlur);
    this.element.addEventListener('click', this.onCanvasClick);
    this.element.addEventListener('contextmenu', this.onContextMenu);
    document.addEventListener('pointerlockchange', this.onPointerLockChange);
    document.addEventListener('pointerlockerror', this.onPointerLockChange);
  }

  private detach(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('mousedown', this.onMouseDown);
    window.removeEventListener('mouseup', this.onMouseUp);
    window.removeEventListener('mousemove', this.onMouseMove);
    window.removeEventListener('wheel', this.onWheel);
    window.removeEventListener('blur', this.onBlur);
    this.element.removeEventListener('click', this.onCanvasClick);
    this.element.removeEventListener('contextmenu', this.onContextMenu);
    document.removeEventListener('pointerlockchange', this.onPointerLockChange);
    document.removeEventListener('pointerlockerror', this.onPointerLockChange);
  }
}

export function createInput(element: HTMLElement, opts?: InputOptions): InputSystem {
  return new InputSystem(element, opts);
}
