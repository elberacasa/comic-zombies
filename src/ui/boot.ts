/**
 * THE BOOT / PAUSE OVERLAY — the first frame of the comic.
 *
 * This is the only screen the player sees before the arena, so it carries the whole art
 * direction on its own: ink, paper, halftone, hard shadows, a cover-page title. It owns four
 * states and nothing else:
 *
 *   LOADING  — procedural assets are being built. The arena takes ~200ms of synchronous work;
 *              this state exists so the browser gets a paint in before that lands, otherwise
 *              the first thing the player sees is a frozen white tab.
 *   READY    — "CLICK TO DROP IN". The click is the user gesture that buys us pointer lock.
 *   PAUSED   — pointer lock lost (Esc, alt-tab) or P pressed. Semi-transparent so the arena
 *              stays visible behind it: a pause screen that hides the game feels like a crash.
 *   FAILED   — no WebGL2. A readable, in-voice apology instead of a black rectangle.
 *
 * It reuses the markup already in `index.html` (`#boot`, `#boot-cta`, `#boot-hint`) rather than
 * building its own, so the title is on screen before a single byte of JS has parsed.
 */

import { css } from '@/art/palette';

export interface BootOptions {
  /** Defaults to `#boot`. */
  element?: HTMLElement;
}

const STYLE_ID = 'cz-boot-style';

function styleSheet(): string {
  const ink = css('INK');
  const paper = css('PAPER');
  const hot = css('HOT');
  const gold = css('GOLD');
  const electric = css('ELECTRIC');
  const nightA = css('NIGHT_A');
  const nightB = css('NIGHT_B');

  return `
#boot {
  transition: opacity .34s cubic-bezier(.4,0,.2,1);
  opacity: 1;
  /* A COVER PAGE, not a gradient. Value structure first: a hard two-tone ground with the
     title sitting in the light half. Everything below is pure CSS — no asset is introduced. */
  background: ${nightB};
  overflow: hidden;
}
#boot.cz-fading { opacity: 0; }
#boot.cz-gone { display: none !important; }
#boot > * { position: relative; z-index: 2; }

/* ── the printed page: speed lines, a jagged value split, two screens, a panel frame ── */
/* Specificity has to beat the "#boot > *" rule above, or the page joins the grid flow. */
#boot > .cz-page {
  position: absolute; inset: 0; z-index: 0; overflow: hidden; pointer-events: none;
}
.cz-page > i { position: absolute; inset: -14%; display: block; }

/* 1 · the ground. A hard diagonal split with a torn edge, so the page has a value
      structure instead of a smooth ramp. NIGHT_B over NIGHT_A over INK at the corners. */
.cz-page > i.cz-split {
  background:
    radial-gradient(ellipse at 50% 30%, ${css('NIGHT_B', 0)} 0 30%, ${css('INK', 0.5)} 100%),
    ${nightA};
  clip-path: polygon(0 52%, 13% 48%, 26% 53%, 40% 47%, 54% 52%, 67% 46%, 81% 51%, 100% 45%,
                     100% 100%, 0 100%);
}
.cz-page > i.cz-split-b {
  background: ${css('INK', 0.8)};
  clip-path: polygon(0 74%, 17% 70%, 33% 76%, 52% 69%, 70% 75%, 86% 70%, 100% 74%,
                     100% 100%, 0 100%);
}

/* 2 · speed lines bursting from behind the lockup, held off the centre by a mask and faded
      out before the corners — the same geometry the overlay pass draws (uOvSpeedInner). */
.cz-page > i.cz-burst {
  background:
    repeating-conic-gradient(from 0deg at 50% 34%,
      ${css('PAPER', 0.10)} 0deg .34deg, transparent .34deg 2.6deg),
    repeating-conic-gradient(from 1.3deg at 50% 34%,
      ${css('HOT', 0.11)} 0deg .22deg, transparent .22deg 9.3deg);
  -webkit-mask-image: radial-gradient(circle at 50% 34%,
    transparent 0 13%, #000 34%, ${css('INK', 0.45)} 62%, transparent 86%);
  mask-image: radial-gradient(circle at 50% 34%,
    transparent 0 13%, #000 34%, ${css('INK', 0.45)} 62%, transparent 86%);
}

/* 3 · TWO screens at the classic plate angles, coarser toward the corners the way a real
      page loses register at the edges. Rotating the element is what gives a true angle. */
.cz-page > i.cz-screen { inset: -45%; mix-blend-mode: multiply; }
.cz-page > i.cz-screen.a {
  transform: rotate(15deg);
  background-image: radial-gradient(circle at 50% 50%, ${css('INK', 0.5)} 1.15px, transparent 1.5px);
  background-size: 6px 6px;
  opacity: .5;
}
.cz-page > i.cz-screen.b {
  transform: rotate(75deg);
  background-image: radial-gradient(circle at 50% 50%, ${css('INK', 0.6)} 2.1px, transparent 2.6px);
  background-size: 11px 11px;
  opacity: .5;
  -webkit-mask-image: radial-gradient(circle at 50% 38%, transparent 0 24%, #000 74%);
  mask-image: radial-gradient(circle at 50% 38%, transparent 0 24%, #000 74%);
}

/* 4 · ink splats in the dead corners, so the composition has weight where the type is not. */
.cz-page > i.cz-splat {
  inset: 0;
  background:
    radial-gradient(circle at 7% 86%, ${css('INK', 0.9)} 0 6vmin, transparent 6.4vmin),
    radial-gradient(circle at 14% 76%, ${css('INK', 0.9)} 0 2.4vmin, transparent 2.7vmin),
    radial-gradient(circle at 2% 72%, ${css('INK', 0.9)} 0 1.5vmin, transparent 1.7vmin),
    radial-gradient(circle at 94% 11%, ${css('INK', 0.75)} 0 4.6vmin, transparent 5vmin),
    radial-gradient(circle at 86% 19%, ${css('INK', 0.75)} 0 1.8vmin, transparent 2vmin);
}

/* 5 · the panel frame — the same object as passes/vignette.ts uFrame: a thick INK border
      with a PAPER gutter inside it, off-square by a degree so nothing is sterile. */
.cz-page > i.cz-frame {
  inset: 1.6vmin;
  border: 1.5vmin solid ${ink};
  outline: .5vmin solid ${paper};
  outline-offset: -2vmin;
  box-shadow: 0 0 7vmin 2vmin ${css('INK', 0.9)};
  transform: rotate(1.1deg) scale(1.015);
}

/* PAUSED must not hide the arena: the ground and the splats drop out, the print stays. */
#boot.cz-paused .cz-split,
#boot.cz-paused .cz-split-b,
#boot.cz-paused .cz-splat { display: none; }
#boot.cz-paused .cz-burst { opacity: .35; }
#boot.cz-paused .cz-screen { opacity: .28; }

/* PAUSED: keep the arena visible behind a printed scrim. */
#boot.cz-paused {
  background: ${css('INK', 0.62)} !important;
  backdrop-filter: blur(2px) saturate(1.25);
  -webkit-backdrop-filter: blur(2px) saturate(1.25);
}
#boot.cz-paused h1 { font-size: clamp(2.4rem, 8vw, 6rem); }

#boot-cta { position: relative; }
#boot.cz-loading #boot-cta {
  animation: none; background: ${ink}; border-color: ${gold}; color: ${gold};
}
#boot.cz-failed #boot-cta {
  animation: none; background: ${hot}; border-color: ${paper}; color: ${paper};
}

/* The loading bar: hard ink segments wiping across a paper strip. No smooth gradients. */
.cz-loadbar {
  width: min(52vw, 460px); height: 16px;
  border: 4px solid ${paper}; background: ${ink};
  box-shadow: 6px 6px 0 ${css('INK', 0.7)};
  transform: rotate(-.9deg); overflow: hidden; position: relative;
  display: none;
}
#boot.cz-loading .cz-loadbar { display: block; }
.cz-loadbar::before {
  content: ''; position: absolute; inset: 0;
  background: repeating-linear-gradient(90deg,
    ${gold} 0 14px, transparent 14px 30px);
  animation: cz-load 900ms linear infinite;
}
@keyframes cz-load { to { transform: translateX(30px); } }

.cz-keys {
  display: grid; grid-template-columns: auto auto; gap: .25rem 1.1rem;
  background: ${paper}; color: ${ink};
  border: 5px solid ${ink}; box-shadow: 8px 8px 0 ${css('INK', 0.85)};
  padding: .7rem 1.3rem .8rem; transform: rotate(.8deg);
  font-size: .95rem; letter-spacing: .1em; text-align: left;
  margin-top: .4rem;
}
.cz-keys b { color: ${css('INK')}; background: ${electric}; padding: 0 .4rem;
  border: 2px solid ${ink}; display: inline-block; min-width: 2.6em; text-align: center; }
.cz-keys span { opacity: .78; }
#boot.cz-failed .cz-keys, #boot.cz-loading .cz-keys { display: none; }

.cz-fail {
  max-width: 46ch; font-size: 1.05rem; line-height: 1.55; letter-spacing: .04em;
  background: ${paper}; color: ${ink}; border: 5px solid ${ink};
  box-shadow: 9px 9px 0 ${css('INK', 0.85)}; padding: 1rem 1.3rem;
  transform: rotate(-1.1deg); display: none;
}
#boot.cz-failed .cz-fail { display: block; }
`;
}

export type BootState = 'loading' | 'ready' | 'paused' | 'hidden' | 'failed';

export class BootOverlay {
  readonly el: HTMLElement;

  private readonly h1: HTMLElement | null;
  private readonly cta: HTMLElement | null;
  private readonly hint: HTMLElement | null;
  private readonly bar: HTMLDivElement;
  private readonly keys: HTMLDivElement;
  private readonly fail: HTMLDivElement;
  private readonly page: HTMLDivElement;
  private readonly titleHtml: string;

  private _state: BootState = 'loading';
  private started = false;

  /** Fired on the click that starts (or resumes) the game. A real user gesture. */
  onStart: (() => void) | null = null;

  constructor(opts: BootOptions = {}) {
    const el = opts.element ?? document.getElementById('boot');
    if (!el) throw new Error('[boot] #boot element missing from index.html');
    this.el = el;

    if (!document.getElementById(STYLE_ID)) {
      const style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = styleSheet();
      document.head.appendChild(style);
    }

    this.h1 = el.querySelector('h1');
    this.cta = document.getElementById('boot-cta');
    this.hint = document.getElementById('boot-hint');
    this.titleHtml = this.h1?.innerHTML ?? 'COMIC<span>ZOMBIES</span>';

    // The cover page's furniture. Absolutely positioned, so it never joins the grid flow that
    // centres the lockup, and inserted FIRST so the type always reads on top of it.
    this.page = document.createElement('div');
    this.page.className = 'cz-page';
    this.page.innerHTML =
      '<i class="cz-split"></i><i class="cz-split-b"></i><i class="cz-burst"></i>' +
      '<i class="cz-splat"></i><i class="cz-screen a"></i><i class="cz-screen b"></i>' +
      '<i class="cz-frame"></i>';
    el.prepend(this.page);

    this.bar = document.createElement('div');
    this.bar.className = 'cz-loadbar';

    this.keys = document.createElement('div');
    this.keys.className = 'cz-keys';
    // Gunplay sits directly under movement, and the two keys of the M3 loop — the boon draw and
    // the restart — under that. The debug spawn keys stay, but they are a footnote now: the
    // round director puts the horde in the street on its own.
    this.keys.innerHTML = [
      ['WASD', 'MOVE'], ['SHIFT', 'SPRINT'], ['SPACE', 'JUMP'],
      ['CTRL', 'TAP SLIDE / HOLD DIVE'],
      ['LMB', 'FIRE'], ['RMB', 'AIM'],
      ['R', 'RELOAD — TAP AGAIN IN THE GOLD ZONE'],
      ['1 2 3', 'TAKE A BOON BETWEEN ROUNDS'],
      ['SPACE', 'RUN IT BACK, ON THE BACK COVER'],
      ['N / M', 'SPAWN 1 / 10 ZOMBIES'], ['K', 'KILL THEM ALL'],
      ['P', 'PAUSE'], ['`', 'DEBUG'],
      ['F1-F4', 'QUALITY'], ['F5', 'A/B THE INK'], ['F7', 'MOTION COMFORT'],
      ['F8', 'NAV GRAPH — SEE WHERE THEY ARE HEADED'],
    ].map(([k, v]) => `<b>${k}</b><span>${v}</span>`).join('');

    this.fail = document.createElement('div');
    this.fail.className = 'cz-fail';

    // Insert after the CTA so the reading order stays: title → call to action → detail.
    if (this.cta && this.cta.parentElement === el) {
      this.cta.insertAdjacentElement('afterend', this.bar);
      this.bar.insertAdjacentElement('afterend', this.fail);
    } else {
      el.append(this.bar, this.fail);
    }
    el.appendChild(this.keys);

    el.addEventListener('click', this.onClick);
    this.setLoading('WAKING THE PRESSES');
  }

  get state(): BootState { return this._state; }

  // ── states ─────────────────────────────────────────────────────────────────

  setLoading(status: string): void {
    this._state = 'loading';
    this.el.classList.remove('cz-gone', 'cz-fading', 'cz-paused', 'cz-failed');
    this.el.classList.add('cz-loading');
    this.setTitle(this.titleHtml);
    if (this.cta) this.cta.textContent = `${status}…`;
    if (this.hint) this.hint.textContent = 'DRAWING EVERY PIXEL FROM CODE — NO ASSETS, NO DOWNLOADS';
  }

  ready(): void {
    this._state = 'ready';
    this.started = false;
    this.el.classList.remove('cz-gone', 'cz-fading', 'cz-paused', 'cz-failed', 'cz-loading');
    this.setTitle(this.titleHtml);
    if (this.cta) this.cta.textContent = 'CLICK TO DROP IN';
    if (this.hint) this.hint.textContent = 'BUILD 005 · M3.5 THEY CLIMB — NOWHERE IS SAFE NOW';
  }

  paused(reason = 'PAUSED'): void {
    this._state = 'paused';
    this.el.classList.remove('cz-gone', 'cz-fading', 'cz-failed', 'cz-loading');
    this.el.classList.add('cz-paused');
    this.setTitle(`${reason}<span>&nbsp;</span>`);
    if (this.cta) this.cta.textContent = 'CLICK TO RESUME';
    if (this.hint) this.hint.textContent = 'ESC RELEASES THE MOUSE · P PAUSES';
  }

  /** Fade out and stop taking clicks. */
  hide(): void {
    if (this._state === 'hidden') return;
    this._state = 'hidden';
    this.el.classList.add('cz-fading');
    window.setTimeout(() => {
      if (this._state === 'hidden') this.el.classList.add('cz-gone');
    }, 360);
  }

  /** Terminal state: no WebGL2, or the renderer threw during construction. */
  failed(title: string, message: string): void {
    this._state = 'failed';
    this.el.classList.remove('cz-gone', 'cz-fading', 'cz-paused', 'cz-loading');
    this.el.classList.add('cz-failed');
    this.el.style.cursor = 'default';
    this.setTitle(`${title}<span>&nbsp;</span>`);
    if (this.cta) this.cta.textContent = 'CANNOT DRAW THIS PAGE';
    if (this.hint) this.hint.textContent = '';
    this.fail.textContent = message;
  }

  dispose(): void {
    this.el.removeEventListener('click', this.onClick);
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private setTitle(html: string): void {
    if (this.h1) this.h1.innerHTML = html;
  }

  private readonly onClick = (): void => {
    if (this._state !== 'ready' && this._state !== 'paused') return;
    if (this.started && this._state === 'ready') return;
    this.started = true;
    this.onStart?.();
  };
}

export function createBoot(opts?: BootOptions): BootOverlay {
  return new BootOverlay(opts);
}

/** WebGL2 capability probe. Cheap, disposable, and never throws. */
export function webgl2Supported(): boolean {
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2');
    if (!gl) return false;
    const lose = gl.getExtension('WEBGL_lose_context');
    lose?.loseContext();
    return true;
  } catch {
    return false;
  }
}
