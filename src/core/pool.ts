/**
 * POOL — the reason the heap graph is flat during play.
 *
 * Anything that spawns per-frame (bullets, decals, particles, shards, damage numbers, word pops,
 * audio voices) comes from a `Pool`. Anything that needs a bounded history (perf samples, debug
 * log, combo timestamps) uses a `RingBuffer`. Entity ids come from `IdAllocator` and dense
 * iteration comes from `SparseSet`.
 *
 * Nothing in this file allocates during steady-state use.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Pool
// ─────────────────────────────────────────────────────────────────────────────

export interface PoolOptions<T> {
  /** Build a fresh instance. Called at most `max` times over the pool's life. */
  create: () => T;
  /** Return an instance to a neutral state. Called on release (and on prewarm). */
  reset?: (obj: T) => void;
  /** Prepare an instance for use. Called on acquire, after it leaves the free list. */
  activate?: (obj: T) => void;
  /** Instances built up front, before the first frame. */
  initial?: number;
  /** Hard ceiling. `acquire` returns null once this many are live. Default 4096. */
  max?: number;
  /** For diagnostics in the debug panel. */
  label?: string;
}

/**
 * Fixed-identity object pool. Objects are never discarded, only recycled, so references stay
 * stable and the GC never sees them.
 *
 * ```ts
 * const tracers = new Pool<Tracer>({ create: makeTracer, reset: t => t.mesh.visible = false, initial: 64 });
 * const t = tracers.acquire();
 * if (t) { ... }
 * tracers.release(t);
 * ```
 */
export class Pool<T> {
  readonly label: string;
  readonly max: number;

  private readonly _create: () => T;
  private readonly _reset: ((obj: T) => void) | null;
  private readonly _activate: ((obj: T) => void) | null;
  /** Every instance ever created, in creation order. */
  private readonly _created: T[] = [];
  /** Free stack — LIFO keeps recently-touched objects cache-warm. */
  private readonly _free: T[] = [];
  private _peak = 0;
  private _starved = 0;

  constructor(opts: PoolOptions<T>) {
    this._create = opts.create;
    this._reset = opts.reset ?? null;
    this._activate = opts.activate ?? null;
    this.max = opts.max ?? 4096;
    this.label = opts.label ?? 'pool';
    if (opts.initial) this.prewarm(opts.initial);
  }

  /** Instances currently checked out. */
  get live(): number { return this._created.length - this._free.length; }
  /** Instances that exist at all (live + free). */
  get size(): number { return this._created.length; }
  get free(): number { return this._free.length; }
  /** High-water mark of `live` — the number to size `initial` from. */
  get peak(): number { return this._peak; }
  /** How many times `acquire` hit the cap and returned null. Non-zero means retune. */
  get starved(): number { return this._starved; }

  /** Build `n` instances now so the first frame that needs them doesn't stutter. */
  prewarm(n: number): void {
    const target = Math.min(n, this.max);
    while (this._created.length < target) {
      const obj = this._create();
      if (this._reset) this._reset(obj);
      this._created.push(obj);
      this._free.push(obj);
    }
  }

  /** Take an instance, growing on demand. Returns null only at the capacity cap. */
  acquire(): T | null {
    let obj = this._free.pop();
    if (obj === undefined) {
      if (this._created.length >= this.max) { this._starved++; return null; }
      obj = this._create();
      this._created.push(obj);
    }
    if (this._activate) this._activate(obj);
    const live = this.live;
    if (live > this._peak) this._peak = live;
    return obj;
  }

  /**
   * Give an instance back. Releasing something twice corrupts the pool, so callers must null
   * their reference immediately after.
   */
  release(obj: T): void {
    if (this._reset) this._reset(obj);
    this._free.push(obj);
  }

  /** Recycle everything at once — round reset, arena teardown, game over. */
  releaseAll(): void {
    this._free.length = 0;
    for (let i = 0; i < this._created.length; i++) {
      const obj = this._created[i];
      if (this._reset) this._reset(obj);
      this._free.push(obj);
    }
  }

  /** Visit every instance ever created, live or not. Setup/teardown only, not a hot path. */
  forEachCreated(fn: (obj: T) => void): void {
    for (let i = 0; i < this._created.length; i++) fn(this._created[i]);
  }

  /** Drop everything. `onDispose` gets each instance so GPU resources can be freed. */
  clear(onDispose?: (obj: T) => void): void {
    if (onDispose) for (let i = 0; i < this._created.length; i++) onDispose(this._created[i]);
    this._created.length = 0;
    this._free.length = 0;
    this._peak = 0;
    this._starved = 0;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// RingBuffer
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fixed-capacity FIFO that overwrites its oldest entry instead of growing.
 * Index 0 is the oldest live entry; `at(-1)` is the newest.
 */
export class RingBuffer<T> {
  readonly capacity: number;
  private readonly items: (T | undefined)[];
  private head = 0;
  private _length = 0;

  constructor(capacity: number) {
    this.capacity = Math.max(1, capacity | 0);
    this.items = new Array<T | undefined>(this.capacity);
  }

  get length(): number { return this._length; }
  get full(): boolean { return this._length === this.capacity; }

  /** Append. Returns the evicted entry when the buffer was full. */
  push(value: T): T | undefined {
    const idx = (this.head + this._length) % this.capacity;
    let evicted: T | undefined;
    if (this._length === this.capacity) {
      evicted = this.items[this.head];
      this.head = (this.head + 1) % this.capacity;
    } else {
      this._length++;
    }
    this.items[idx] = value;
    return evicted;
  }

  /** Remove and return the oldest entry. */
  shift(): T | undefined {
    if (this._length === 0) return undefined;
    const v = this.items[this.head];
    this.items[this.head] = undefined;
    this.head = (this.head + 1) % this.capacity;
    this._length--;
    return v;
  }

  /** 0 = oldest. Negative counts back from the newest: `at(-1)` is the last pushed. */
  at(i: number): T | undefined {
    const idx = i < 0 ? this._length + i : i;
    if (idx < 0 || idx >= this._length) return undefined;
    return this.items[(this.head + idx) % this.capacity];
  }

  get first(): T | undefined { return this.at(0); }
  get last(): T | undefined { return this.at(-1); }

  /** Oldest → newest. Allocation-free. */
  forEach(fn: (value: T, index: number) => void): void {
    for (let i = 0; i < this._length; i++) {
      const v = this.items[(this.head + i) % this.capacity];
      if (v !== undefined) fn(v, i);
    }
  }

  clear(): void {
    for (let i = 0; i < this.capacity; i++) this.items[i] = undefined;
    this.head = 0;
    this._length = 0;
  }
}

/**
 * Numeric rolling window with running stats. Drives the perf readout without allocating —
 * pushing is O(1) and `avg` is maintained incrementally.
 */
export class RollingAverage {
  private readonly samples: Float64Array;
  private idx = 0;
  private count = 0;
  private sum = 0;

  constructor(window = 60) {
    this.samples = new Float64Array(Math.max(1, window | 0));
  }

  push(v: number): void {
    const n = this.samples.length;
    if (this.count === n) this.sum -= this.samples[this.idx];
    else this.count++;
    this.samples[this.idx] = v;
    this.sum += v;
    this.idx = (this.idx + 1) % n;
  }

  get avg(): number { return this.count === 0 ? 0 : this.sum / this.count; }
  get length(): number { return this.count; }
  get last(): number { return this.count === 0 ? 0 : this.samples[(this.idx + this.samples.length - 1) % this.samples.length]; }

  /** Worst sample in the window — the number that actually matters for hitching. */
  get max(): number {
    let m = 0;
    for (let i = 0; i < this.count; i++) { const v = this.samples[i]; if (v > m) m = v; }
    return m;
  }

  get min(): number {
    if (this.count === 0) return 0;
    let m = Infinity;
    for (let i = 0; i < this.count; i++) { const v = this.samples[i]; if (v < m) m = v; }
    return m;
  }

  reset(): void {
    this.samples.fill(0);
    this.idx = 0;
    this.count = 0;
    this.sum = 0;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Entity ids
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Dense set of small integer ids. O(1) add/remove/has, and `dense` gives a packed array you can
 * iterate straight through — no holes, no branch per slot. Iteration order is unspecified and
 * changes on removal (swap-remove), so never assume it.
 */
export class SparseSet {
  private sparse: Int32Array;
  private _dense: Int32Array;
  private _size = 0;

  constructor(capacity = 256) {
    const c = Math.max(1, capacity | 0);
    this.sparse = new Int32Array(c).fill(-1);
    this._dense = new Int32Array(c);
  }

  get size(): number { return this._size; }
  /** Packed ids, valid for indices [0, size). Do not mutate. */
  get dense(): Int32Array { return this._dense; }
  get capacity(): number { return this.sparse.length; }

  has(id: number): boolean {
    if (id < 0 || id >= this.sparse.length) return false;
    const i = this.sparse[id];
    return i >= 0 && i < this._size && this._dense[i] === id;
  }

  add(id: number): boolean {
    if (id < 0) return false;
    this.ensure(id + 1);
    if (this.has(id)) return false;
    this._dense[this._size] = id;
    this.sparse[id] = this._size;
    this._size++;
    return true;
  }

  remove(id: number): boolean {
    if (!this.has(id)) return false;
    const i = this.sparse[id];
    const last = this._dense[this._size - 1];
    this._dense[i] = last;
    this.sparse[last] = i;
    this.sparse[id] = -1;
    this._size--;
    return true;
  }

  at(i: number): number { return this._dense[i]; }

  clear(): void {
    for (let i = 0; i < this._size; i++) this.sparse[this._dense[i]] = -1;
    this._size = 0;
  }

  private ensure(n: number): void {
    if (n <= this.sparse.length) return;
    let cap = this.sparse.length;
    while (cap < n) cap *= 2;
    const s = new Int32Array(cap).fill(-1);
    s.set(this.sparse);
    this.sparse = s;
    const d = new Int32Array(cap);
    d.set(this._dense);
    this._dense = d;
  }
}

/**
 * Hands out stable integer ids with a free list, so despawned entities recycle their slot and
 * arrays stay dense. Ids are also the index into any parallel component array.
 */
export class IdAllocator {
  readonly capacity: number;
  private readonly freed: number[] = [];
  private next = 0;
  private _live = 0;

  constructor(capacity = 4096) {
    this.capacity = Math.max(1, capacity | 0);
  }

  get live(): number { return this._live; }
  /** Highest id ever handed out + 1 — the length parallel arrays need. */
  get highWater(): number { return this.next; }

  /** Returns -1 when the capacity is exhausted. */
  alloc(): number {
    const recycled = this.freed.pop();
    if (recycled !== undefined) { this._live++; return recycled; }
    if (this.next >= this.capacity) return -1;
    this._live++;
    return this.next++;
  }

  release(id: number): void {
    if (id < 0 || id >= this.next) return;
    this.freed.push(id);
    this._live--;
  }

  reset(): void {
    this.freed.length = 0;
    this.next = 0;
    this._live = 0;
  }
}
