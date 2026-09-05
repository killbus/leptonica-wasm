/**
 * Core-layer types: the Leptonica instance and the Pix wrapper.
 *
 * The Pix wrapper owns exactly one PIX handle (embind class handle from
 * the curated build). Disposal is explicit — Symbol.dispose →
 * destroyPix + poison; FinalizationRegistry only warns (decision ④).
 */

/** Box from a connComp query. */
export interface Box {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** Result of a findSkew query. */
export interface SkewResult {
  /** Estimated deskew angle in DEGREES (pixFindSkew returns degrees; pixRotate takes radians — convert with deg * Math.PI / 180 before rotating). */
  readonly angle: number;
  /** Confidence score; pixDeskew ignores angles with confidence < 3.0. */
  readonly confidence: number;
}

import type { CuratedModule, PixHandle } from "leptonica-wasm/leptonica.mjs";
import { ChainBuilder } from "./chain.ts";

/**
 * A wrapped PIX handle. The wrapper is the only public way to touch the
 * handle; every method checks the poisoned flag first.
 */
export class Pix {
  /** @internal — the embind class handle. */
  readonly handle: PixHandle;
  /** @internal — owning instance (cross-instance guard). */
  readonly lp: Leptonica;
  #poisoned = false;

  /** @internal — poisoned flag read for cross-class checks. */
  isPoisoned(): boolean {
    return this.#poisoned;
  }

  constructor(handle: PixHandle, lp: Leptonica) {
    this.handle = handle;
    this.lp = lp;
  }

  /** Width in pixels. Throws if disposed. */
  get width(): number {
    this.#assertAlive("width");
    return this.lp.module.pixWidth(this.handle);
  }

  /** Height in pixels. Throws if disposed. */
  get height(): number {
    this.#assertAlive("height");
    return this.lp.module.pixHeight(this.handle);
  }

  /** Bit depth (1/2/4/8/16/24/32). Throws if disposed. */
  get depth(): number {
    this.#assertAlive("depth");
    return this.lp.module.pixDepth(this.handle);
  }

  /** Encode to PNG bytes (copied out of the wasm heap). */
  toPNG(): Uint8Array {
    this.#assertAlive("toPNG");
    const view = this.lp.module.toPNG(this.handle);
    if (view === null) throw new Error("toPNG: encoder failed");
    // Copy: typed_memory_view aliases the wasm heap; heap growth would
    // detach it. Extraction is a terminal operation on the bytes.
    return new Uint8Array(view);
  }

  /** Encode to JPEG bytes at the given quality (0-100). */
  toJPEG(quality: number): Uint8Array {
    this.#assertAlive("toJPEG");
    const view = this.lp.module.toJPEG(this.handle, quality);
    if (view === null) throw new Error("toJPEG: encoder failed");
    return new Uint8Array(view);
  }

  /** Extract RGBA bytes (32bpp only; copied out of the wasm heap). */
  toRGBA(): Uint8Array {
    this.#assertAlive("toRGBA");
    const view = this.lp.module.toRGBA(this.handle);
    if (view === null) throw new Error("toRGBA: requires 32bpp");
    return new Uint8Array(view);
  }

  /** Query: deskew angle estimate (1bpp only). */
  findSkew(): SkewResult {
    this.#assertAlive("findSkew");
    const r = this.lp.module.findSkew(this.handle);
    if (r === null) throw new Error("findSkew: requires 1bpp");
    return r;
  }

  /** Query: count of ON pixels (1bpp only). */
  countPixels(): number {
    this.#assertAlive("countPixels");
    const n = this.lp.module.countPixels(this.handle);
    if (n < 0) throw new Error("countPixels: requires 1bpp");
    return n;
  }

  /** Query: connected components, 8-connectivity (1bpp only). */
  connComp(): readonly Box[] {
    this.#assertAlive("connComp");
    const boxes = this.lp.module.connComp(this.handle);
    if (boxes === null) throw new Error("connComp: requires 1bpp");
    return boxes;
  }

  /** Query: 256-bin gray histogram (8bpp). */
  histogram(): readonly number[] {
    this.#assertAlive("histogram");
    const bins = this.lp.module.histogram(this.handle);
    if (bins === null) throw new Error("histogram: requires 8bpp");
    return bins;
  }

  /** Query: mean gray value (L_MEAN_ABSVAL). */
  average(): number {
    this.#assertAlive("average");
    const avg = this.lp.module.average(this.handle);
    if (avg === null) throw new Error("average: query failed");
    return avg;
  }

  /** Release the PIX handle. Idempotent; poisons the wrapper. */
  [Symbol.dispose](): void {
    this.dispose();
  }

  /** Explicit disposal — same as Symbol.dispose. */
  dispose(): void {
    if (this.#poisoned) return;
    this.#poisoned = true;
    this.lp.module.destroyPix(this.handle);
    this.lp.unregister(this);
  }

  /** @internal — poison without destroying (owner is closing everything). */
  poisonForClose(): void {
    this.#poisoned = true;
  }

  #assertAlive(what: string): void {
    if (this.#poisoned) {
      throw new ReferenceError(`Pix is disposed (call: ${what})`);
    }
  }

  /** Dev-mode detection shared with the registry guard (decision ④). */
  static isDev(): boolean {
    const proc = globalThis as { process?: { env?: Record<string, string> } };
    return (
      proc.process !== undefined && proc.process.env?.NODE_ENV === "development"
    );
  }
}

/**
 * A loaded leptonica instance — one wasm module instantiation with its
 * own heap. Handles are instance-scoped.
 */
export class Leptonica {
  /** @internal */
  readonly module: CuratedModule;
  /** @internal — live wrappers, for close() and leak warnings. */
  readonly #live = new Set<Pix>();
  readonly #registry: FinalizationRegistry<{ pix: Pix }> | null;
  /** @internal — binary-op operand table (M4 review B1): op.other ids. */
  readonly #operands = new Map<number, Pix>();
  #nextOperandId = 1;
  /** @internal — closed flag: close() poisons the arena permanently. */
  #closed = false;

  constructor(module: CuratedModule) {
    this.module = module;
    // Decision ④: FinalizationRegistry only WARNS (dev mode); explicit
    // dispose is the contract. typeof process guard keeps browsers clean.
    // M4 review N3: register() requires target !== holdings — a Pix used
    // as both throws synchronously in dev mode, which is exactly when the
    // registry exists. The Set already holds the wrapper strongly, so a
    // unique object as holdings costs nothing and keeps the held value
    // meaningful for the leak warning.
    this.#registry =
      Pix.isDev()
        ? new FinalizationRegistry<{ pix: Pix }>((holder) => {
            if (this.#live.has(holder.pix)) {
              console.warn("leptonica-wasm: Pix was garbage-collected without dispose()");
            }
          })
        : null;
  }

  /**
   * Create a 32bpp Pix from RGBA bytes. The data is copied into the wasm
   * heap; the input is not retained.
   */
  fromRGBA(data: Uint8Array | ArrayBufferView, w: number, h: number): Pix {
    this.#assertOpen("fromRGBA");
    if (!Number.isInteger(w) || !Number.isInteger(h) || w <= 0 || h <= 0) {
      throw new RangeError(`fromRGBA: bad dimensions ${w}x${h}`);
    }
    const len = data.byteLength;
    if (len !== w * h * 4) {
      throw new RangeError(`fromRGBA: expected ${w * h * 4} bytes, got ${len}`);
    }
    const handle = this.module.fromRGBA(data, w, h);
    if (handle === null) throw new Error("fromRGBA: allocation failed");
    return this.adopt(handle);
  }

  /** Start a chain on a source Pix. The source is not consumed by run(). */
  chain(src: Pix): ChainBuilder {
    this.#assertOpen("chain");
    this.assertOwns(src, "chain");
    if (src.isPoisoned()) throw new ReferenceError("chain: source Pix is disposed");
    return new ChainBuilder(this, src);
  }

  /** Destroy every live Pix and poison the arena. Instance is unusable after. */
  close(): void {
    this.#closed = true;
    for (const pix of this.#live) {
      pix.poisonForClose();
      this.module.destroyPix(pix.handle);
    }
    this.#live.clear();
    this.#operands.clear();
  }

  /** @internal */
  adopt(handle: PixHandle): Pix {
    this.#assertOpen("adopt");
    const pix = new Pix(handle, this);
    this.#live.add(pix);
    this.#registry?.register(pix, { pix }, pix);
    return pix;
  }

  /** @internal */
  unregister(pix: Pix): void {
    this.#live.delete(pix);
    this.#registry?.unregister(pix);
  }

  /** @internal — register a binary-op operand; returns its wire id. */
  registerOperand(pix: Pix): number {
    const id = this.#nextOperandId++;
    this.#operands.set(id, pix);
    return id;
  }

  /** @internal — resolve a binary-op operand id (recorded in an Op). */
  resolveOperand(id: number, what: string): Pix {
    const pix = this.#operands.get(id);
    if (pix === undefined) {
      throw new ReferenceError(`${what}: operand ${id} is not registered on this instance`);
    }
    if (pix.isPoisoned()) {
      throw new ReferenceError(`${what}: operand Pix was disposed before run()`);
    }
    return pix;
  }

  /** @internal */
  assertOwns(pix: Pix, what: string): void {
    if (pix.lp !== this) {
      throw new TypeError(`${what}: Pix belongs to a different Leptonica instance`);
    }
  }

  #assertOpen(what: string): void {
    if (this.#closed) {
      throw new ReferenceError(`Leptonica instance is closed (call: ${what})`);
    }
  }
}
