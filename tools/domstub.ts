/**
 * HEADLESS DOM SHIM — just enough `document.createElement('canvas')` for the arena's
 * procedural texture pass to run under node. Nothing here is ever rendered: the harness
 * only ever queries the COLLISION world, so every 2D drawing call can be a no-op.
 */

interface Stub2D { [k: string]: unknown }

function makeContext(w: number, h: number): Stub2D {
  const grad = { addColorStop(): void {} };
  const ctx: Stub2D = {
    canvas: null,
    measureText: (s: string) => ({
      width: String(s).length * 8,
      actualBoundingBoxLeft: 0,
      actualBoundingBoxRight: String(s).length * 8,
      actualBoundingBoxAscent: 8,
      actualBoundingBoxDescent: 2,
    }),
    createLinearGradient: () => grad,
    createRadialGradient: () => grad,
    createConicGradient: () => grad,
    createPattern: () => null,
    getImageData: (_x: number, _y: number, gw: number, gh: number) => ({
      data: new Uint8ClampedArray(Math.max(1, gw | 0) * Math.max(1, gh | 0) * 4),
      width: gw | 0, height: gh | 0,
    }),
    createImageData: (gw: number, gh: number) => ({
      data: new Uint8ClampedArray(Math.max(1, gw | 0) * Math.max(1, gh | 0) * 4),
      width: gw | 0, height: gh | 0,
    }),
  };
  // Everything else on a 2D context is a drawing command or a settable style. A Proxy
  // returns a no-op for any method we did not name and swallows every style write.
  return new Proxy(ctx, {
    get(t, k) {
      if (k in t) return (t as Record<string | symbol, unknown>)[k];
      if (k === 'width') return w;
      if (k === 'height') return h;
      return () => undefined;
    },
    set(t, k, v) { (t as Record<string | symbol, unknown>)[k as string] = v; return true; },
  }) as Stub2D;
}

function makeCanvas(): unknown {
  const c: Record<string, unknown> = { width: 1, height: 1, nodeType: 1, tagName: 'CANVAS' };
  c.getContext = (kind: string) => (kind === '2d' ? makeContext(c.width as number, c.height as number) : null);
  c.toDataURL = () => '';
  c.addEventListener = () => undefined;
  c.removeEventListener = () => undefined;
  c.style = {};
  return c;
}

/**
 * Install the shim. Idempotent; safe to call before any project import.
 * MUST run before `@/world/arena` is evaluated — the entry points import this module first
 * and then `await import(...)` everything else, which is what guarantees the ordering.
 */
export function installDomStub(): void {
  const g = globalThis as Record<string, unknown>;
  if (g.document) return;
  g.document = {
    createElement: (tag: string) => (tag === 'canvas' ? makeCanvas() : { style: {}, appendChild() {} }),
    createElementNS: () => ({ style: {} }),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    body: { appendChild: () => undefined, style: {} },
  };
  // Systems bind debug keys to `window`. globalThis is not an EventTarget in node.
  if (typeof g.addEventListener !== 'function') g.addEventListener = () => undefined;
  if (typeof g.removeEventListener !== 'function') g.removeEventListener = () => undefined;
  g.window = g.window ?? g;
  g.self = g.self ?? g;
  if (!g.navigator) g.navigator = { userAgent: 'node' };
  g.requestAnimationFrame = g.requestAnimationFrame ?? ((f: () => void) => setTimeout(f, 16));
  g.cancelAnimationFrame = g.cancelAnimationFrame ?? ((h: number) => clearTimeout(h));
}
