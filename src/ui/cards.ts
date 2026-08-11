/**
 * THE CARDS — the boon draw and the run summary. ART_DIRECTION §7, GAME_BIBLE §5 and §7.
 *
 * Two full-screen comic beats live here, and they are the only two moments in the game where the
 * player stops shooting and *reads*:
 *
 *   THE DRAW      three cards dealt onto the page between rounds. The player makes this decision
 *                 20+ times a run, so it has to be readable in under a second and picked in two.
 *   THE BACK COVER  the run summary on death, and the restart.
 *
 * ───────────────────────────────────────────────────────────────────────────────────────────
 * RARITY IS READ FROM THE TREATMENT, NOT FROM THE WORD.
 *
 * `ACID` and `HOT` are reserved for enemies (ART §9) and may not be spent on UI, so rarity is
 * carried on FOUR independent channels, any one of which is enough on its own:
 *
 *   | rarity     | ribbon    | ink border | halftone pitch | extra              |
 *   | common     | BONE      | 5 px       | 5.4 px         | —                  |
 *   | rare       | ELECTRIC  | 6 px       | 4.4 px         | —                  |
 *   | epic       | RUST      | 8 px       | 3.6 px         | corner burst       |
 *   | legendary  | GOLD      | 10 px      | 3.0 px         | GOLD card + speed lines |
 *
 * Squint at the three cards and the legendary is still obviously the legendary.
 * ───────────────────────────────────────────────────────────────────────────────────────────
 *
 * INPUT UNDER POINTER LOCK. The game holds pointer lock for its whole session (main.ts derives
 * pause from it), so there is no OS cursor to click a card with and DOM `:hover` never fires.
 * The draw therefore ships its own cursor: it parks the look sensitivity at 0 for exactly as long
 * as the cards are up, drives a drawn comic cursor from raw `movementX/Y`, and hit-tests the
 * cards itself. Keyboard `1 / 2 / 3` always works and is the fast path. When the page is NOT
 * pointer-locked (an automated browser, or a paused tab) real mouse coordinates are used instead,
 * so the same code is drivable by a script.
 */

import type { BoonDef, BoonRarity, GameCtx, System } from '@/core/types';
import { css } from '@/art/palette';
import type { PaletteToken } from '@/art/palette';
import { ROUND } from '@/game/tuning';

import { FALLBACK_ICON, iconSvg, isIconId } from '@/ui/icons';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The seams this module needs that are not on a frozen interface.
//
// Both are NAMED, TYPED interfaces satisfied by passing the real object in from `main.ts`, never
// an untyped structural probe: a rename then breaks the build instead of silently degrading.
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** The finished-run numbers. `RoundSystem` satisfies this; `RoundService` cannot (no points). */
export interface RunSummarySource {
  readonly lastRun: {
    readonly round: number;
    readonly kills: number;
    readonly bestCombo: number;
    readonly timeSurvived: number;
    readonly points: number;
  };
  readonly bestRound: number;
  readonly totalKills: number;
  /** The best points total ever banked. Until M4 gives points a sink, this IS the chase. */
  readonly bestPoints: number;
}

/** The HUD's modal latch — while a card layer is up, the HUD suppresses its own title cards. */
export interface ModalTarget {
  setModal(on: boolean): void;
}

export interface CardsOptions {
  /** Defaults to `#ui`, then `document.body`. */
  container?: HTMLElement;
  run?: RunSummarySource;
  hud?: ModalTarget;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Rarity treatment. One table, four channels.
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface Treatment {
  /** The ribbon flat, and the mis-registered plate behind the glyph. */
  readonly accent: PaletteToken;
  /** The card stock. Legendary prints on GOLD; everything else on PAPER. */
  readonly paper: PaletteToken;
  /** Ribbon text colour. */
  readonly ribbonText: PaletteToken;
  readonly border: number;
  readonly halftone: number;
  readonly burst: boolean;
  readonly lines: boolean;
  /**
   * RARITY IS THE SILHOUETTE, NOT A BANNER. Three cards at the same size, the same stock and the
   * same tilt read as three of the same thing no matter what colour the 20 px ribbon on top is —
   * and the pool's whole design (GLASS CANNON, INK PACT, WILD DRAW, PANEL BREAK) lands or dies
   * in the one second the player has to read the table. So the tier changes how big the card is,
   * how far off square it sits, and how hard it lands.
   */
  readonly scale: number;
  /** Multiplier on the slot's resting tilt. A legendary is visibly more thrown down. */
  readonly tilt: number;
  /** Accent bleeding into the stock, 0 = none. Print misregistration, not a glow. */
  readonly bleed: number;
}

/**
 * NOTE ON HUE. Epic wants to shout and the loudest ink we own is `HOT` — but `HOT` and `ACID`
 * are RESERVED for enemies and damage (ART §1, §9) and that reservation is a standing regression
 * test, not a preference. So the epic tier shouts with `RUST` plus SIZE, TILT, BORDER WEIGHT,
 * BLEED and a denser screen. Five channels beat one hue, and the reserved channel stays reserved.
 */
const TREATMENT: Record<BoonRarity, Treatment> = {
  common: { accent: 'BONE', paper: 'PAPER', ribbonText: 'INK', border: 5, halftone: 5.4, burst: false, lines: false, scale: 0.93, tilt: 1, bleed: 0 },
  rare: { accent: 'ELECTRIC', paper: 'PAPER', ribbonText: 'INK', border: 6, halftone: 4.4, burst: false, lines: false, scale: 1, tilt: 1.12, bleed: 0.1 },
  epic: { accent: 'RUST', paper: 'PAPER', ribbonText: 'PAPER', border: 9, halftone: 3.6, burst: true, lines: false, scale: 1.08, tilt: 1.38, bleed: 0.26 },
  legendary: { accent: 'RUST', paper: 'GOLD', ribbonText: 'INK', border: 12, halftone: 3.0, burst: true, lines: true, scale: 1.16, tilt: 1.62, bleed: 0.34 },
};

/** Resting transform for a slot, given its rarity treatment. One definition, four call sites. */
function restTilt(index: number, t: Treatment): number {
  return (CARD_TILT[index] ?? 0) * t.tilt;
}

/** Deal-in stagger, in ms. Three cards land in ~0.5s — fast enough to never feel like a wait. */
const DEAL_STAGGER = 92;
const DEAL_DURATION = 400;
/** The resting tilt of each card. Nothing on this page is square to the page. */
const CARD_TILT = [-4.2, 1.4, 4.6] as const;
/** Virtual-cursor gain: screen px per raw mouse px while the draw is open. */
const CURSOR_GAIN = 1;
/** How long the chosen card holds on screen before the layer clears. */
const PICK_HOLD = 0.42;

const FONT = 'Impact, Haettenschweiler, "Arial Narrow Bold", "Arial Black", sans-serif';

// ─────────────────────────────────────────────────────────────────────────────────────────────

function div(cls: string): HTMLDivElement {
  const d = document.createElement('div');
  d.className = cls;
  return d;
}

function styleSheet(): string {
  const ink = css('INK');
  const paper = css('PAPER');
  const gold = css('GOLD');
  const electric = css('ELECTRIC');
  const rust = css('RUST');
  const shadow = css('INK', 0.95);

  return `
.cz-cards {
  position: absolute; inset: 0; pointer-events: none; overflow: hidden;
  font-family: ${FONT}; color: ${ink};
  user-select: none; -webkit-user-select: none;
  visibility: hidden;
}
.cz-cards[data-on="1"] { visibility: visible; pointer-events: auto; }

/* The gutter. Everything that is not the cards recedes — this is the page turning. */
.cz-cards-scrim {
  position: absolute; inset: 0;
  background: radial-gradient(ellipse at 50% 50%,
    ${css('INK', 0.52)} 0%, ${css('INK', 0.76)} 48%, ${css('INK', 0.94)} 100%);
  opacity: 0;
  transition: opacity .18s steps(3, end);
}
.cz-cards[data-on="1"] .cz-cards-scrim { opacity: 1; }
.cz-cards[data-on="1"] .cz-cards-burst { opacity: .55; }

/* Static burst behind the whole draw. A printed flourish: it never animates once it lands. */
.cz-cards-burst {
  position: absolute; left: 50%; top: 50%; width: 200vmax; height: 200vmax;
  margin: -100vmax 0 0 -100vmax; opacity: 0;
  background: repeating-conic-gradient(from 2deg at 50% 50%,
    ${css('PAPER', 0.13)} 0deg .42deg, transparent .42deg 3.4deg);
  -webkit-mask-image: radial-gradient(circle at 50% 50%, transparent 12%, #000 46%, transparent 88%);
  mask-image: radial-gradient(circle at 50% 50%, transparent 12%, #000 46%, transparent 88%);
}

.cz-cards-head {
  position: absolute; left: 50%; top: 8%; transform: translateX(-50%) rotate(-1.8deg);
  background: ${ink}; color: ${paper}; border: 5px solid ${paper};
  box-shadow: 9px 9px 0 ${shadow};
  padding: .3rem 1.8rem .45rem; letter-spacing: .2em; white-space: nowrap;
  font-size: clamp(1.1rem, 2.4vw, 2rem);
}
.cz-cards-head b { color: ${gold}; }

/* ── the row ───────────────────────────────────────────────────────────────── */
.cz-row {
  position: absolute; left: 50%; top: 52%; transform: translate(-50%, -50%);
  display: flex; align-items: center; gap: clamp(12px, 2.2vw, 30px);
}

.cz-card {
  position: relative; width: clamp(180px, 17vw, 250px); height: clamp(268px, 25vw, 360px);
  display: flex; flex-direction: column; align-items: center;
  padding: 0 0 .9rem;
  cursor: none;
  /* overflow is VISIBLE on purpose: the legendary's speed-line halo has to spill past the card
     edge (that is what makes it a halo), and the 1/2/3 key tab hangs off the bottom border. The
     halftone screen is inset 0 so it never needed clipping. */
  overflow: visible;
}
.cz-card > * { position: relative; z-index: 2; }
/* The halftone screen. Pitch is a rarity channel — denser ink for a rarer card. */
.cz-card::after {
  content: ''; position: absolute; inset: 0; z-index: 1; pointer-events: none;
  mix-blend-mode: multiply;
  background-image: var(--tone-image);
  background-size: var(--tone-size);
}

.cz-card-ribbon {
  width: 100%; text-align: center; letter-spacing: .26em;
  /* The ribbon is the card's top edge, so it has to be clipped back to it by hand now that the
     card itself does not clip. */
  overflow: hidden;
  font-size: clamp(.62rem, .95vw, .82rem);
  padding: .3rem 0 .34rem;
  border-bottom: 4px solid ${ink};
}
.cz-glyph { width: clamp(58px, 6vw, 86px); height: clamp(58px, 6vw, 86px); display: block; }
.cz-card-art { margin: clamp(.5rem, 1.4vh, 1.1rem) 0 .3rem; }
.cz-card-name {
  text-align: center; line-height: .92; letter-spacing: .01em;
  font-size: clamp(1.15rem, 1.7vw, 1.65rem); padding: 0 .5rem;
  text-shadow: 2px 2px 0 ${css('INK', 0.16)};
}
/* The accent bleeding down into the stock — print misregistration, not a glow. Rarity channel. */
.cz-card-bleed {
  content: ''; position: absolute; left: 0; right: 0; top: 0; height: 62%;
  z-index: 1; pointer-events: none; mix-blend-mode: multiply;
}
.cz-card-desc {
  text-align: center; padding: .3rem .8rem .2rem; margin-top: auto;
  font-family: ${FONT}; letter-spacing: .045em; line-height: 1.16;
  font-size: clamp(.74rem, 1.02vw, .96rem);
}
/* Stack count. Deliberately the quietest mark on the card — it is inventory, not rarity — and
   parked in the top-left gutter, out of the title block entirely. It cannot live at the bottom:
   the 1/2/3 key tab hangs off the bottom edge and would print straight through it, and the
   top-RIGHT corner is taken by the epic/legendary torn burst. */
.cz-card-stack {
  position: absolute; left: .5rem; top: 2rem; z-index: 3;
  letter-spacing: .16em; font-size: .54rem; opacity: .45;
}
.cz-card-stack span { opacity: .62; }
.cz-card-key {
  position: absolute; left: 50%; bottom: -20px; transform: translateX(-50%) rotate(-3deg);
  z-index: 3;
  background: ${ink}; color: ${paper}; border: 4px solid ${paper};
  box-shadow: 5px 5px 0 ${css('INK', 0.8)};
  width: 40px; height: 40px; display: grid; place-items: center;
  font-size: 1.35rem; line-height: 1;
}
/* Epic and legendary get a torn corner burst — a shape cue, not only a colour cue. */
.cz-card-burst {
  position: absolute; right: -14px; top: -14px; width: 78px; height: 78px; z-index: 3;
  clip-path: polygon(50% 0,61% 33%,95% 26%,72% 51%,100% 68%,66% 72%,72% 100%,45% 78%,
                     22% 97%,26% 66%,0 58%,28% 44%,8% 18%,40% 27%);
}
/* Legendary only: a static speed-line halo behind the card. */
.cz-card-lines {
  position: absolute; left: 50%; top: 50%; width: 380px; height: 380px;
  margin: -190px 0 0 -190px; z-index: 0; pointer-events: none;
  background: repeating-conic-gradient(from 0deg at 50% 50%,
    ${css('GOLD', 0.5)} 0deg .55deg, transparent .55deg 4.2deg);
  -webkit-mask-image: radial-gradient(circle at 50% 50%, transparent 30%, #000 52%, transparent 76%);
  mask-image: radial-gradient(circle at 50% 50%, transparent 30%, #000 52%, transparent 76%);
}

/* ── the drain bar: how long the page waits for you ─────────────────────────── */
.cz-cards-timer {
  position: absolute; left: 50%; bottom: 11%; transform: translateX(-50%) rotate(-.7deg);
  width: min(46vw, 520px); height: 14px;
  border: 4px solid ${paper}; background: ${css('INK', 0.85)}; overflow: hidden;
}
.cz-cards-timer i {
  position: absolute; inset: 0; display: block; transform-origin: 0 50%;
  background: repeating-linear-gradient(90deg, ${gold} 0 10px, ${css('GOLD', 0.55)} 10px 20px);
}
.cz-cards-hint {
  position: absolute; left: 50%; bottom: 6.5%; transform: translateX(-50%);
  color: ${paper}; letter-spacing: .22em; font-size: clamp(.7rem, 1.1vw, .95rem);
  opacity: .78; white-space: nowrap;
}
.cz-cards-hint b { color: ${electric}; }

/* ── the drawn cursor ───────────────────────────────────────────────────────── */
.cz-cursor {
  position: absolute; left: 0; top: 0; width: 34px; height: 34px; z-index: 9;
  margin: -3px 0 0 -3px; pointer-events: none; display: none;
}
.cz-cards[data-cursor="1"] .cz-cursor { display: block; }
.cz-cursor path { fill: ${paper}; stroke: ${ink}; stroke-width: 5; stroke-linejoin: round; }

/* ── THE BACK COVER ─────────────────────────────────────────────────────────── */
.cz-over {
  position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%) rotate(-1.4deg);
  width: min(86vw, 780px); max-height: 88vh;
  background: ${paper}; border: 9px solid ${ink}; box-shadow: 18px 18px 0 ${ink};
  padding: 0 0 1.1rem; overflow: hidden;
}
.cz-over > * { position: relative; z-index: 2; }
.cz-over::after {
  content: ''; position: absolute; inset: 0; z-index: 1; pointer-events: none;
  background-image: radial-gradient(circle at 50% 50%, ${css('INK', 0.24)} 1.1px, transparent 1.35px);
  background-size: 5px 5px; mix-blend-mode: multiply;
}
.cz-over-head {
  background: ${ink}; color: ${paper}; text-align: center;
  padding: .35rem 1rem .55rem; letter-spacing: .1em;
  font-size: clamp(2.2rem, 6vw, 4.4rem); line-height: .96;
  text-shadow: 4px 4px 0 ${rust};
}
.cz-over-sub {
  text-align: center; letter-spacing: .24em; padding: .5rem 1rem .2rem;
  font-size: clamp(.72rem, 1.2vw, .95rem); opacity: .75;
}
.cz-over-grid {
  display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px;
  padding: .7rem clamp(.8rem, 2vw, 1.6rem) .3rem;
}
.cz-stat {
  background: ${paper}; border: 5px solid ${ink}; box-shadow: 6px 6px 0 ${css('INK', 0.85)};
  padding: .3rem .5rem .45rem; text-align: center;
}
.cz-stat b { display: block; font-size: clamp(1.5rem, 3.4vw, 2.5rem); line-height: 1; }
.cz-stat span { display: block; letter-spacing: .2em; font-size: .66rem; opacity: .7; padding-top: .22rem; }
.cz-stat[data-best="1"] { background: ${gold}; }
.cz-stat em {
  display: block; font-style: normal; letter-spacing: .16em;
  font-size: .68rem; padding-top: .14rem; color: ${css('INK', 0.72)};
}
.cz-over-deck {
  display: flex; flex-wrap: wrap; justify-content: center; gap: 7px;
  padding: .55rem clamp(.8rem, 2vw, 1.6rem) 0;
}
.cz-over-deck .cz-chip { transform: none; }
.cz-over-deck:empty { display: none; }
.cz-over-decklab {
  text-align: center; letter-spacing: .24em; font-size: .66rem; opacity: .6;
  padding-top: .55rem;
}
.cz-over-seed {
  text-align: center; letter-spacing: .2em; font-size: .6rem; opacity: .42;
  padding-top: .75rem;
}
.cz-over-cta {
  margin: .55rem auto 0; width: fit-content;
  background: ${ink}; color: ${paper}; border: 5px solid ${gold};
  box-shadow: 7px 7px 0 ${css('INK', 0.8)};
  padding: .35rem 1.5rem .5rem; letter-spacing: .18em;
  font-size: clamp(.95rem, 1.6vw, 1.3rem);
}
.cz-over-cta b { color: ${gold}; }

/* .cz-chip — the small boon token — is defined ONCE, in ui/hud.ts, because the HUD's deck
   strip and this summary draw the identical object and two copies would drift. The HUD is always
   registered alongside this system (both are wired in main.ts §5), so the rule is always there.
   Only the summary's override lives here: the deck grid does its own rotation. */
`;
}

/** The drawn cursor: an ink-outlined comic arrow, not an OS pointer. */
const CURSOR_SVG =
  '<svg viewBox="0 0 34 34"><path d="M3 1 L3 27 L10 21 L15 32 L21 29 L16 19 L26 18 Z"/></svg>';

// ─────────────────────────────────────────────────────────────────────────────────────────────

interface CardView {
  el: HTMLDivElement;
  def: BoonDef | null;
  /** Cached hit rect, refreshed when the row lands and on resize. */
  x: number; y: number; w: number; h: number;
}

export class CardsSystem implements System {
  readonly name = 'cards';

  private ctx: GameCtx | null = null;
  private readonly container: HTMLElement;
  private readonly styleEl: HTMLStyleElement;
  private readonly root: HTMLDivElement;
  private readonly scrim: HTMLDivElement;
  private readonly burst: HTMLDivElement;
  private readonly head: HTMLDivElement;
  private readonly row: HTMLDivElement;
  private readonly timerBar: HTMLDivElement;
  private readonly timerFill: HTMLElement;
  private readonly hint: HTMLDivElement;
  private readonly cursor: HTMLDivElement;
  private readonly over: HTMLDivElement;

  private readonly cards: CardView[] = [];
  private readonly offs: (() => void)[] = [];

  private run: RunSummarySource | null;
  private hud: ModalTarget | null;

  /** Set by `main.ts`: what actually puts a living player back in the world. */
  onRestart: (() => void) | null = null;

  private mode: 'off' | 'draw' | 'summary' = 'off';
  /** `performance.now()` when the back cover went up — SPACE is also JUMP (see `gameOverHold`). */
  private summaryAt = 0;
  private picked = false;
  /** Which slot the player actually took — set BEFORE `choose`, which re-enters synchronously. */
  private pickIndex = -1;
  private pickTimer = 0;
  private drawTimer = 0;
  private lastFillWritten = -1;

  // cursor
  private cx = 0;
  private cy = 0;
  private hover = -1;
  private savedSensitivity = -1;

  /**
   * The best round as it stood when this run STARTED. The director commits its meta before it
   * emits `game:over`, so `run.bestRound` already includes the run being summarised — comparing
   * against it would never once say "NEW BEST". This is the honest baseline.
   */
  private prevBestRound = 0;
  /** Same trick for points — the meta already folded this run in by the time we draw. */
  private prevBestPoints = 0;

  constructor(opts: CardsOptions = {}) {
    this.run = opts.run ?? null;
    this.hud = opts.hud ?? null;
    this.container =
      opts.container ??
      (document.getElementById('ui') as HTMLElement | null) ??
      document.body;

    this.styleEl = document.createElement('style');
    this.styleEl.id = 'cz-cards-style';
    this.styleEl.textContent = styleSheet();
    document.head.appendChild(this.styleEl);

    this.root = div('cz-cards');
    this.root.dataset.on = '0';

    this.scrim = div('cz-cards-scrim');
    this.burst = div('cz-cards-burst');
    this.head = div('cz-cards-head');
    this.row = div('cz-row');
    this.timerBar = div('cz-cards-timer');
    this.timerFill = document.createElement('i');
    this.timerBar.appendChild(this.timerFill);
    this.hint = div('cz-cards-hint');
    this.cursor = div('cz-cursor');
    this.cursor.innerHTML = CURSOR_SVG;
    this.over = div('cz-over');

    for (let i = 0; i < 3; i++) {
      const el = div('cz-card');
      el.dataset.slot = String(i);
      this.row.appendChild(el);
      this.cards.push({ el, def: null, x: 0, y: 0, w: 0, h: 0 });
    }

    this.root.append(this.scrim, this.burst, this.head, this.row, this.timerBar, this.hint, this.over, this.cursor);
    this.container.appendChild(this.root);
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════
  // System
  // ═══════════════════════════════════════════════════════════════════════════════════════

  init(ctx: GameCtx): void {
    this.ctx = ctx;
    const on = ctx.events.on.bind(ctx.events);

    this.snapshotMeta();

    this.offs.push(
      on('boon:offer', (p) => this.openDraw(p.choices)),
      on('boon:chosen', () => { if (this.mode === 'draw') this.confirmPick(); }),
      // A round starting for any reason (the draw timed out, a skipToRound from the console)
      // tears the layer down — the cards must never survive into gameplay.
      on('round:start', () => { if (this.mode === 'draw') this.closeDraw(); }),
      on('game:over', () => this.openSummary()),
      on('game:started', () => this.snapshotMeta()),
    );

    window.addEventListener('keydown', this.onKey, { passive: false });
    window.addEventListener('mousemove', this.onMouseMove, { passive: true });
    window.addEventListener('mousedown', this.onMouseDown, { passive: false });
    window.addEventListener('resize', this.onResize);

    ctx.debug.watch('cards', () => (this.mode === 'off' ? '—' : this.mode));
  }

  /**
   * Presentation only, and it does nothing at all unless a layer is open — the whole system is
   * two field reads on an idle frame (ART §4.1).
   */
  update(dt: number, ctx: GameCtx): void {
    if (this.mode === 'off') return;

    if (this.mode === 'draw') {
      if (this.picked) {
        this.pickTimer -= dt;
        if (this.pickTimer <= 0) this.closeDraw();
        return;
      }
      this.drawTimer -= dt;
      const frac = Math.max(0, Math.min(1, this.drawTimer / ROUND.boonDrawTimeout));
      // Sub-percent bar movement is invisible and costs a style recalc every frame.
      if (Math.abs(frac - this.lastFillWritten) >= 0.004) {
        this.lastFillWritten = frac;
        this.timerFill.style.transform = `scaleX(${frac.toFixed(3)})`;
      }
      void ctx;
    }
  }

  dispose(): void {
    for (const off of this.offs) off();
    this.offs.length = 0;
    window.removeEventListener('keydown', this.onKey);
    window.removeEventListener('mousemove', this.onMouseMove);
    window.removeEventListener('mousedown', this.onMouseDown);
    window.removeEventListener('resize', this.onResize);
    this.restoreLook();
    this.root.remove();
    this.styleEl.remove();
    this.ctx = null;
  }

  /** True while either layer owns the screen. `main.ts` reads it to gate the input state. */
  get modal(): boolean { return this.mode !== 'off'; }

  // ═══════════════════════════════════════════════════════════════════════════════════════
  // THE DRAW
  // ═══════════════════════════════════════════════════════════════════════════════════════

  private openDraw(choices: readonly BoonDef[]): void {
    if (choices.length === 0 || this.mode === 'summary') return;
    const ctx = this.ctx;
    if (!ctx) return;

    this.mode = 'draw';
    this.picked = false;
    this.pickIndex = -1;
    this.drawTimer = ROUND.boonDrawTimeout;
    this.lastFillWritten = -1;
    this.timerFill.style.transform = 'scaleX(1)';
    this.hover = -1;

    this.head.innerHTML = `THE PAGE TURNS — <b>TAKE ONE</b>`;
    this.hint.innerHTML = 'PRESS <b>1</b> <b>2</b> <b>3</b> &nbsp;·&nbsp; OR AIM AND CLICK';
    this.over.style.display = 'none';
    this.timerBar.style.display = '';
    this.hint.style.display = '';
    this.head.style.display = '';
    this.row.style.display = '';

    for (let i = 0; i < this.cards.length; i++) {
      const card = this.cards[i]!;
      const def = i < choices.length ? choices[i]! : null;
      card.def = def;
      if (!def) { card.el.style.display = 'none'; continue; }
      card.el.style.display = '';
      this.paintCard(card, def, i, ctx);
    }

    this.show(true);
    this.freezeLook();
    this.centreCursor();
    ctx.renderer.panelFrame(1);
    this.hud?.setModal(true);
    this.dealIn();
  }

  private paintCard(card: CardView, def: BoonDef, index: number, ctx: GameCtx): void {
    const t = TREATMENT[def.rarity] ?? TREATMENT.common;
    const iconId = isIconId(def.icon) ? def.icon : FALLBACK_ICON;
    const owned = ctx.boons.stacksOf(def.id);

    const el = card.el;
    el.style.background = css(t.paper);
    el.style.border = `${t.border}px solid ${css('INK')}`;
    el.style.boxShadow = `12px 12px 0 ${css('INK', 0.95)}`;
    // Size and tilt ARE the rarity read (see `Treatment`). Both live on the element's transform,
    // so every animation below composes against the same resting pose.
    el.style.transform = `rotate(${restTilt(index, t).toFixed(2)}deg) scale(${t.scale})`;
    this.applyTone(el, t.halftone);

    el.innerHTML =
      (t.lines ? '<div class="cz-card-lines"></div>' : '') +
      (t.bleed > 0
        ? `<div class="cz-card-bleed" style="background:linear-gradient(${css(t.accent, t.bleed)},` +
          `${css(t.accent, 0)} 62%)"></div>`
        : '') +
      (t.burst ? `<div class="cz-card-burst" style="background:${css(t.accent)}"></div>` : '') +
      `<div class="cz-card-ribbon" style="background:${css(t.accent)};color:${css(t.ribbonText)}">${def.rarity.toUpperCase()}</div>` +
      `<div class="cz-card-art">${iconSvg(iconId, t.accent, t.paper)}</div>` +
      `<div class="cz-card-name">${escapeHtml(def.name.toUpperCase())}</div>` +
      `<div class="cz-card-desc">${escapeHtml(def.description)}</div>` +
      // THE STACK COUNT IS NOT A RARITY CUE and must never be mistaken for one. It used to be a
      // row of diamond pips directly under the name — the loudest mark on the card — and
      // `maxStacks` correlates INVERSELY with rarity, so TRIGGER FINGER (common) wore five pips
      // while RED INK (rare) wore four. The rarest card on the table was the quietest. It is now
      // a small lettered footer that says what it actually means.
      `<div class="cz-card-stack">STACK ${owned}<span>/${def.maxStacks}</span></div>` +
      `<div class="cz-card-key">${index + 1}</div>`;
  }

  /** The `::after` screen cannot take an inline style, so the tile is written as a CSS var. */
  private applyTone(el: HTMLElement, pitch: number): void {
    el.style.setProperty(
      '--tone-image',
      `radial-gradient(circle at 50% 50%, ${css('INK', 0.26)} ${(pitch * 0.22).toFixed(2)}px, transparent ${(pitch * 0.27).toFixed(2)}px)`,
    );
    el.style.setProperty('--tone-size', `${pitch}px ${pitch}px`);
  }

  /** Cards fly in from below the page, overshoot, hold a frame, settle. ART §8. */
  private dealIn(): void {
    for (let i = 0; i < this.cards.length; i++) {
      const card = this.cards[i]!;
      if (!card.def) continue;
      const t = TREATMENT[card.def.rarity] ?? TREATMENT.common;
      const rot = restTilt(i, t);
      const k = t.scale;
      // The rarer the card, the harder it lands: a legendary overshoots further and holds the
      // overshoot frame longer. ART §8 — fast in, overshoot, HOLD, settle.
      const over = 1 + (k - 1) + 0.06 * t.tilt;
      card.el.getAnimations().forEach((a) => a.cancel());
      card.el.animate(
        [
          { transform: `translateY(78vh) rotate(${rot - 26}deg) scale(${(k * 0.8).toFixed(3)})`, opacity: 0, offset: 0 },
          { transform: `translateY(-14px) rotate(${rot + 2.5}deg) scale(${over.toFixed(3)})`, opacity: 1, offset: 0.62 },
          { transform: `translateY(-14px) rotate(${rot + 2.5}deg) scale(${over.toFixed(3)})`, opacity: 1, offset: 0.72 },
          { transform: `translateY(0) rotate(${rot}deg) scale(${k})`, opacity: 1, offset: 1 },
        ],
        {
          duration: DEAL_DURATION,
          delay: i * DEAL_STAGGER,
          easing: 'cubic-bezier(.16,1,.3,1)',
          fill: 'both',
        },
      );
    }
    this.head.getAnimations().forEach((a) => a.cancel());
    this.head.animate(
      [
        { transform: 'translateX(-50%) rotate(-1.8deg) scale(1.4)', opacity: 0 },
        { transform: 'translateX(-50%) rotate(-1.8deg) scale(1)', opacity: 1, offset: 0.4 },
        { transform: 'translateX(-50%) rotate(-1.8deg) scale(1)', opacity: 1 },
      ],
      { duration: 300, easing: 'cubic-bezier(.16,1,.3,1)', fill: 'both' },
    );
  }

  private pick(index: number): void {
    if (this.mode !== 'draw' || this.picked) return;
    const card = this.cards[index];
    const ctx = this.ctx;
    if (!card || !card.def || !ctx) return;
    // `choose` emits `boon:chosen` SYNCHRONOUSLY, which re-enters `confirmPick` — so the slot has
    // to be recorded first or the animation would play on whatever the cursor happened to be over.
    this.pickIndex = index;
    ctx.boons.choose(card.def.id);
    // A def that was not on offer is ignored by the service and nothing re-entered; do not
    // leave the layer latched on a pick that never happened.
    if (!this.picked) this.pickIndex = -1;
  }

  private confirmPick(): void {
    if (this.picked) return;
    this.picked = true;
    this.pickTimer = PICK_HOLD;
    // HAND THE PAGE BACK ON THE PICK, NOT ON THE TEARDOWN. Taking a card clears
    // `pendingChoice`, so the director starts the next round on its very next fixed step —
    // while these cards are still flying off. The HUD is registered ahead of this system, so it
    // sees that `round:start` first, and if the modal latch were still set the ROUND N title
    // card would be silently swallowed. Measured: it was, for every round after the first.
    this.hud?.setModal(false);

    const chosen = this.pickIndex >= 0 ? this.pickIndex : this.hover;
    for (let i = 0; i < this.cards.length; i++) {
      const card = this.cards[i]!;
      if (!card.def) continue;
      const t = TREATMENT[card.def.rarity] ?? TREATMENT.common;
      const rot = restTilt(i, t);
      const k = t.scale;
      card.el.getAnimations().forEach((a) => a.cancel());
      if (i === chosen) {
        card.el.animate(
          [
            { transform: `rotate(${rot}deg) scale(${k})`, opacity: 1 },
            { transform: `rotate(${rot * 0.2}deg) scale(${(k * 1.24).toFixed(3)})`, opacity: 1, offset: 0.34 },
            { transform: `rotate(${rot * 0.2}deg) scale(${(k * 1.24).toFixed(3)})`, opacity: 1, offset: 0.5 },
            { transform: `rotate(${rot * 0.2}deg) scale(${(k * 0.5).toFixed(3)})`, opacity: 0 },
          ],
          { duration: PICK_HOLD * 1000, easing: 'cubic-bezier(.2,.9,.25,1)', fill: 'forwards' },
        );
      } else {
        card.el.animate(
          [
            { transform: `rotate(${rot}deg) scale(${k})`, opacity: 1 },
            { transform: `translateY(64vh) rotate(${rot + 22}deg) scale(${(k * 0.86).toFixed(3)})`, opacity: 0 },
          ],
          { duration: PICK_HOLD * 900, easing: 'cubic-bezier(.6,0,.9,.4)', fill: 'forwards' },
        );
      }
    }
    this.ctx?.events.emit('fx:flash', { intensity: 0.34 });
  }

  private closeDraw(): void {
    if (this.mode !== 'draw') return;
    this.mode = 'off';
    this.picked = false;
    this.pickIndex = -1;
    this.show(false);
    this.restoreLook();
    this.hud?.setModal(false);
    this.ctx?.renderer.panelFrame(0);
    for (const c of this.cards) c.el.getAnimations().forEach((a) => a.cancel());
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════
  // THE BACK COVER
  // ═══════════════════════════════════════════════════════════════════════════════════════

  private openSummary(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    // A death during a draw takes the page straight to the back cover.
    if (this.mode === 'draw') this.closeDraw();
    this.mode = 'summary';
    this.summaryAt = performance.now();

    const r = this.run;
    const run = r?.lastRun ?? { round: ctx.rounds.round, kills: 0, bestCombo: 0, timeSurvived: 0, points: 0 };
    const newBestRound = r ? run.round > this.prevBestRound : false;
    const bestRound = r ? Math.max(r.bestRound, run.round) : run.round;
    // POINTS has no sink until M4's wall-buys, so the only thing it can compete with is itself.
    // The meta blob already carries `bestPoints`; this is what makes it visible.
    const bestPoints = r ? Math.max(r.bestPoints, run.points) : run.points;
    const newBestPoints = r ? run.points > this.prevBestPoints : false;
    const totalKills = r ? r.totalKills : run.kills;

    const mins = Math.floor(run.timeSurvived / 60);
    const secs = Math.floor(run.timeSurvived % 60);

    const deck: string[] = [];
    const owned = ctx.boons.owned;
    for (let i = 0; i < owned.length; i++) {
      const d = owned[i]!.def;
      const t = TREATMENT[d.rarity] ?? TREATMENT.common;
      const iconId = isIconId(d.icon) ? d.icon : FALLBACK_ICON;
      deck.push(
        `<div class="cz-chip" title="${escapeHtml(d.name)}" style="background:${css(t.paper)}">` +
        iconSvg(iconId, t.accent, t.paper) +
        (owned[i]!.stacks > 1 ? `<i>×${owned[i]!.stacks}</i>` : '') +
        '</div>',
      );
    }

    const stat = (value: string, label: string, note = '', best = false): string =>
      `<div class="cz-stat"${best ? ' data-best="1"' : ''}><b>${value}</b><span>${label}</span>` +
      (note ? `<em>${note}</em>` : '') + '</div>';

    this.over.innerHTML =
      '<div class="cz-over-head">INKED OUT</div>' +
      '<div class="cz-over-sub">THE HORDE GOT THE LAST PANEL</div>' +
      '<div class="cz-over-grid">' +
      stat(String(run.round), 'ROUNDS SURVIVED', newBestRound ? 'NEW BEST!' : `BEST ${bestRound}`, newBestRound) +
      stat(String(run.kills), 'KILLS', `${totalKills} ALL TIME`) +
      stat(String(run.bestCombo), 'LONGEST CHAIN', 'KILLS UNBROKEN') +
      stat(
        run.points.toLocaleString('en-US'), 'POINTS EARNED',
        newBestPoints ? 'NEW BEST!' : `BEST ${bestPoints.toLocaleString('en-US')}`,
        newBestPoints,
      ) +
      stat(`${mins}:${String(secs).padStart(2, '0')}`, 'TIME SURVIVED') +
      stat(String(owned.length), 'BOONS TAKEN') +
      '</div>' +
      (deck.length > 0 ? '<div class="cz-over-decklab">THE DECK YOU BUILT</div>' : '') +
      `<div class="cz-over-deck">${deck.join('')}</div>` +
      `<div class="cz-over-seed">SEED 0x${(ctx.rng.seed >>> 0).toString(16).padStart(8, '0')}</div>` +
      '<div class="cz-over-cta">PRESS <b>SPACE</b> — RUN IT BACK</div>';

    this.over.style.display = '';
    this.head.style.display = 'none';
    this.row.style.display = 'none';
    this.timerBar.style.display = 'none';
    this.hint.style.display = 'none';

    this.show(true);
    this.root.dataset.cursor = '0';
    this.hud?.setModal(true);
    ctx.renderer.panelFrame(1);

    this.over.getAnimations().forEach((a) => a.cancel());
    this.over.animate(
      [
        { transform: 'translate(-50%,-50%) rotate(-1.4deg) scale(2.2)', opacity: 0, offset: 0 },
        { transform: 'translate(-50%,-50%) rotate(-1.4deg) scale(.94)', opacity: 1, offset: 0.2 },
        { transform: 'translate(-50%,-50%) rotate(-1.4deg) scale(.94)', opacity: 1, offset: 0.28 },
        { transform: 'translate(-50%,-50%) rotate(-1.4deg) scale(1.04)', opacity: 1, offset: 0.5 },
        { transform: 'translate(-50%,-50%) rotate(-1.4deg) scale(1)', opacity: 1, offset: 1 },
      ],
      { duration: 620, easing: 'cubic-bezier(.16,1,.3,1)', fill: 'both' },
    );
  }

  /** The restart. Closing the cover is what puts a living player back in the world. */
  private closeSummary(): void {
    if (this.mode !== 'summary') return;
    this.mode = 'off';
    this.show(false);
    this.hud?.setModal(false);
    this.ctx?.renderer.panelFrame(0);
    this.ctx?.events.emit('fx:sound', { id: 'ui_click', volume: 0.9 });
    this.onRestart?.();
    // The director's own meta is committed by now, so this is the baseline the NEXT run beats.
    this.snapshotMeta();
  }

  private snapshotMeta(): void {
    if (!this.run) return;
    this.prevBestRound = this.run.bestRound;
    this.prevBestPoints = this.run.bestPoints;
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════
  // Input
  // ═══════════════════════════════════════════════════════════════════════════════════════

  private readonly onKey = (e: KeyboardEvent): void => {
    if (this.mode === 'off' || e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;

    if (this.mode === 'summary') {
      if (e.code === 'Space' || e.code === 'Enter' || e.code === 'NumpadEnter') {
        e.preventDefault();
        // SPACE is JUMP. Dying with the jump key going must not blow past the back cover before
        // the player has read a number off it. `gameOverHold` is 0.35 s — a keypress in flight,
        // not a wait; the restart itself is now instant (`director.ts::tickGameOver`).
        if (performance.now() - this.summaryAt < ROUND.gameOverHold * 1000) return;
        this.closeSummary();
      }
      return;
    }
    if (this.picked) return;
    const idx =
      e.code === 'Digit1' || e.code === 'Numpad1' ? 0 :
      e.code === 'Digit2' || e.code === 'Numpad2' ? 1 :
      e.code === 'Digit3' || e.code === 'Numpad3' ? 2 : -1;
    if (idx < 0) return;
    e.preventDefault();
    this.pick(idx);
  };

  private readonly onMouseMove = (e: MouseEvent): void => {
    if (this.mode !== 'draw' || this.picked) return;
    if (document.pointerLockElement) {
      this.cx += e.movementX * CURSOR_GAIN;
      this.cy += e.movementY * CURSOR_GAIN;
    } else {
      this.cx = e.clientX;
      this.cy = e.clientY;
    }
    this.cx = Math.max(0, Math.min(window.innerWidth, this.cx));
    this.cy = Math.max(0, Math.min(window.innerHeight, this.cy));
    this.cursor.style.transform = `translate(${this.cx.toFixed(0)}px, ${this.cy.toFixed(0)}px)`;
    this.updateHover();
  };

  private readonly onMouseDown = (e: MouseEvent): void => {
    if (this.mode === 'summary') { e.preventDefault(); this.closeSummary(); return; }
    if (this.mode !== 'draw' || this.picked) return;
    if (!document.pointerLockElement) { this.cx = e.clientX; this.cy = e.clientY; this.updateHover(); }
    if (this.hover < 0) return;
    e.preventDefault();
    this.pick(this.hover);
  };

  private readonly onResize = (): void => { this.measureRow(); };

  private measureRow(): void {
    for (const c of this.cards) {
      if (!c.def) continue;
      const r = c.el.getBoundingClientRect();
      c.x = r.left; c.y = r.top; c.w = r.width; c.h = r.height;
    }
  }

  /**
   * MEASURE EVERY TIME, never cache.
   *
   * The first version measured the row once, on a timer after the deal animation. That is wrong
   * in two ways that both shipped as a dead hit-test: the timer can land while the WAAPI deal is
   * still mid-flight (the cards are 78vh below their resting place at offset 0), and a tab that
   * is backgrounded during the draw does not advance the document timeline at all, so the
   * "settled" rect is nowhere near where the cards are drawn. Three `getBoundingClientRect`
   * calls on a three-element row cost nothing — the only other thing touching the DOM during a
   * draw is a `transform` on the timer bar, which does not invalidate layout.
   */
  private updateHover(): void {
    this.measureRow();

    let found = -1;
    for (let i = 0; i < this.cards.length; i++) {
      const c = this.cards[i]!;
      if (!c.def || c.w === 0) continue;
      if (this.cx >= c.x && this.cx <= c.x + c.w && this.cy >= c.y && this.cy <= c.y + c.h) { found = i; break; }
    }
    if (found === this.hover) return;
    const prev = this.hover;
    this.hover = found;
    if (prev >= 0) this.setHover(prev, false);
    if (found >= 0) {
      this.setHover(found, true);
      this.ctx?.events.emit('fx:sound', { id: 'ui_click', volume: 0.35, pitch: 1.4 });
    }
  }

  /** Hover is a LIFT and a heavier shadow — the card comes off the page toward you. */
  private setHover(index: number, on: boolean): void {
    const card = this.cards[index];
    if (!card || !card.def) return;
    card.el.getAnimations().forEach((a) => a.cancel());
    const t = TREATMENT[card.def.rarity] ?? TREATMENT.common;
    const rot = restTilt(index, t);
    const k = t.scale;
    const lift = (k * 1.075).toFixed(3);
    card.el.style.boxShadow = on
      ? `20px 20px 0 ${css('INK')}, 0 0 0 4px ${css(t.accent)}`
      : `12px 12px 0 ${css('INK', 0.95)}`;
    card.el.animate(
      on
        ? [
          { transform: `translateY(0) rotate(${rot}deg) scale(${k})` },
          { transform: `translateY(-16px) rotate(${rot * 0.45}deg) scale(${lift})` },
        ]
        : [
          { transform: `translateY(-16px) rotate(${rot * 0.45}deg) scale(${lift})` },
          { transform: `translateY(0) rotate(${rot}deg) scale(${k})` },
        ],
      { duration: 140, easing: 'cubic-bezier(.2,.9,.25,1)', fill: 'forwards' },
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════

  private show(on: boolean): void {
    this.root.dataset.on = on ? '1' : '0';
    this.root.dataset.cursor = on && this.mode === 'draw' ? '1' : '0';
  }

  private centreCursor(): void {
    this.cx = window.innerWidth * 0.5;
    this.cy = window.innerHeight * 0.5;
    this.cursor.style.transform = `translate(${this.cx.toFixed(0)}px, ${this.cy.toFixed(0)}px)`;
  }

  /**
   * Park the look while the page is turned. Movement still works — the player may keep walking —
   * but the camera holds still so the drawn cursor is the only thing the mouse is doing.
   */
  private freezeLook(): void {
    const ctx = this.ctx;
    if (!ctx || this.savedSensitivity >= 0) return;
    this.savedSensitivity = ctx.input.sensitivity;
    ctx.input.sensitivity = 0;
  }

  private restoreLook(): void {
    const ctx = this.ctx;
    if (!ctx || this.savedSensitivity < 0) return;
    ctx.input.sensitivity = this.savedSensitivity;
    this.savedSensitivity = -1;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;');
}

export function createCards(opts?: CardsOptions): CardsSystem {
  return new CardsSystem(opts);
}
