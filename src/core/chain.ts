import type { BlendOp, BitwiseOp, Op } from "../protocol.ts";
import { OP_DEPTH_RULES, type Depth } from "../protocol.ts";
import type { Leptonica, Pix } from "./types.ts";
import type { PixHandle } from "leptonica-wasm/leptonica.mjs";

/**
 * Chain builder (design §5.1: builder IS the protocol).
 *
 * Each method records one Op — the same tagged-union shape the worker
 * sends over the wire and the native oracle parses. Depth is validated
 * at RECORD time (the builder tracks a depth cursor from the source
 * Pix), so an invalid chain throws before any wasm work happens.
 *
 * run() replays the recorded ops through the executor; the source Pix is
 * never consumed, intermediates are destroyed in the run() call stack,
 * and the failure path cleans up the same way.
 */
export class ChainBuilder {
  readonly #lp: Leptonica;
  readonly #src: Pix;
  readonly #ops: Op[] = [];
  /** Depth cursor — starts at the source Pix's depth. */
  #depth: Depth;

  constructor(lp: Leptonica, src: Pix) {
    this.#lp = lp;
    this.#src = src;
    this.#depth = src.depth as Depth;
  }

  /** Record and validate one op; returns the builder (fluent). */
  #record(op: Op, produces: Depth | undefined): this {
    const rule = OP_DEPTH_RULES[op.op];
    if (rule.requires !== null && !rule.requires.includes(this.#depth)) {
      throw new TypeError(
        `op ${op.op} requires depth [${rule.requires.join("|")}]bpp, cursor is ${this.#depth}bpp`,
      );
    }
    this.#ops.push(op);
    if (rule.produces !== undefined) {
      this.#depth = typeof rule.produces === "function" ? rule.produces(this.#depth) : rule.produces;
    }
    void produces;
    return this;
  }

  toGray(weights?: readonly [number, number, number]): this {
    return this.#record(
      weights ? { op: "toGray", weights: [...weights] } : { op: "toGray" },
      8,
    );
  }

  threshold(level: number): this {
    return this.#record({ op: "threshold", level }, 1);
  }

  otsu(opts: { tile?: number; factor?: number } = {}): this {
    if (opts.tile !== undefined && (!Number.isInteger(opts.tile) || opts.tile < 16)) {
      throw new RangeError(`otsu: tile must be an integer >= 16, got ${opts.tile}`);
    }
    if (opts.factor !== undefined && !Number.isFinite(opts.factor)) {
      throw new RangeError(`otsu: factor must be finite, got ${opts.factor}`);
    }
    return this.#record(
      { op: "otsu", ...(opts.tile !== undefined ? { tile: opts.tile } : {}), ...(opts.factor !== undefined ? { factor: opts.factor } : {}) },
      1,
    );
  }

  sauvola(whsize: number, factor?: number): this {
    if (!Number.isInteger(whsize) || whsize < 2) {
      throw new RangeError(`sauvola: whsize must be an integer >= 2, got ${whsize}`);
    }
    if (factor !== undefined && (!Number.isFinite(factor) || factor < 0)) {
      throw new RangeError(`sauvola: factor must be >= 0, got ${factor}`);
    }
    return this.#record(
      { op: "sauvola", whsize, ...(factor !== undefined ? { factor } : {}) },
      1,
    );
  }

  deskew(reduction: 1 | 2 | 4 = 2): this {
    return this.#record({ op: "deskew", reduction }, undefined);
  }

  rotate(angle: number, quality: "area" | "shear" = "area"): this {
    return this.#record({ op: "rotate", angle, quality }, undefined);
  }

  scale(fx: number, fy?: number): this {
    if (!Number.isFinite(fx) || fx <= 0) {
      throw new RangeError(`scale: fx must be > 0, got ${fx}`);
    }
    if (fy !== undefined && (!Number.isFinite(fy) || fy <= 0)) {
      throw new RangeError(`scale: fy must be > 0, got ${fy}`);
    }
    return this.#record({ op: "scale", fx, ...(fy !== undefined ? { fy } : {}) }, undefined);
  }

  shear(direction: "h" | "v", angle: number): this {
    return this.#record({ op: "shear", direction, angle }, undefined);
  }

  clip(x: number, y: number, w: number, h: number): this {
    if (!Number.isInteger(w) || w <= 0 || !Number.isInteger(h) || h <= 0) {
      throw new RangeError(`clip: w and h must be positive integers, got ${w}x${h}`);
    }
    return this.#record({ op: "clip", x, y, w, h }, undefined);
  }

  translate(dx: number, dy: number): this {
    return this.#record({ op: "translate", dx, dy }, undefined);
  }

  dilate(w: number, h: number): this {
    return this.#morph("dilate", w, h);
  }

  erode(w: number, h: number): this {
    return this.#morph("erode", w, h);
  }

  open(w: number, h: number): this {
    return this.#morph("open", w, h);
  }

  close(w: number, h: number): this {
    return this.#morph("close", w, h);
  }

  #morph(kind: "dilate" | "erode" | "open" | "close", w: number, h: number): this {
    if (!Number.isInteger(w) || w <= 0 || !Number.isInteger(h) || h <= 0) {
      throw new RangeError(`${kind}: sel dimensions must be positive integers, got ${w}x${h}`);
    }
    return this.#record({ op: kind, w, h }, 1);
  }

  or(other: Pix): this {
    return this.#bitwise({ op: "or", other: 0 }, other, "or");
  }

  and(other: Pix): this {
    return this.#bitwise({ op: "and", other: 0 }, other, "and");
  }

  xor(other: Pix): this {
    return this.#bitwise({ op: "xor", other: 0 }, other, "xor");
  }

  #bitwise(op: BitwiseOp, other: Pix, name: string): this {
    this.#lp.assertOwns(other, name);
    if (other.isPoisoned()) throw new ReferenceError(`${name}: other Pix is disposed`);
    if (other.depth !== 1) {
      throw new TypeError(`${name}: other Pix must be 1bpp, got ${other.depth}bpp`);
    }
    return this.#record(op, 1);
  }

  blend(other: Pix, frac: number): this {
    if (!Number.isFinite(frac) || frac < 0 || frac > 1) {
      throw new RangeError(`blend: frac must be in [0,1], got ${frac}`);
    }
    this.#lp.assertOwns(other, "blend");
    if (other.isPoisoned()) throw new ReferenceError("blend: other Pix is disposed");
    if (other.depth !== 32) {
      throw new TypeError(`blend: other Pix must be 32bpp, got ${other.depth}bpp`);
    }
    return this.#record({ op: "blend", other: 0, frac } satisfies BlendOp, 32);
  }

  addBorder(t: number, val = 0): this {
    if (!Number.isInteger(t) || t < 0) {
      throw new RangeError(`addBorder: t must be a non-negative integer, got ${t}`);
    }
    return this.#record({ op: "addBorder", t, val }, undefined);
  }

  sobel(orientation: "all" | "h" | "v" = "all"): this {
    return this.#record({ op: "sobel", orientation }, 8);
  }

  /** Execute the recorded chain. Returns the final Pix (a new handle). */
  run(): Pix {
    return runChain(this.#lp, this.#src, this.#ops);
  }

  /** @internal — recorded ops, for the worker wire path. */
  get ops(): readonly Op[] {
    return this.#ops;
  }
}

/**
 * The chain executor. Mirrors the op→call mapping in tests (golden
 * parity) and the native oracle (cpp/oracle.c applyOp); the intermediate
 * Pix handles are destroyed within this call stack on BOTH success and
 * failure paths (design §5.2 run-failure cleanup).
 */
export function runChain(lp: Leptonica, src: Pix, ops: readonly Op[]): Pix {
  const M = lp.module;
  let current = src;
  /** Handles created mid-chain that must be destroyed before returning. */
  const intermediates: Pix[] = [];
  const track = (p: Pix): Pix => {
    intermediates.push(p);
    return p;
  };
  try {
    for (const op of ops) {
      const handle = applyOp(M, current, op);
      const next = lp.adopt(handle);
      track(next);
      current = next;
    }
    // Adopt the final handle: hand ownership to the caller's Pix wrapper.
    const result = current;
    for (const p of intermediates) {
      if (p !== result) p.dispose();
    }
    return result;
  } catch (err) {
    for (const p of intermediates) p.dispose();
    throw err;
  }
}

function applyOp(M: import("./types.ts").Leptonica["module"], src: Pix, op: Op): PixHandle {
  const h = src.handle;
  const must = (next: unknown, name: string): PixHandle => {
    if (next === null || next === undefined) {
      throw new Error(`op ${name} returned null`);
    }
    return next as PixHandle;
  };
  switch (op.op) {
    case "toGray":
      return must(op.weights ? M.toGrayWeighted(h, ...op.weights) : M.toGray(h), "toGray");
    case "threshold": return must(M.threshold(h, op.level), "threshold");
    case "otsu": return must(M.otsu(h, op.tile ?? 16, op.factor ?? 0.1), "otsu");
    case "sauvola": return must(M.sauvola(h, op.whsize, op.factor ?? 0.34), "sauvola");
    case "deskew": return must(M.deskew(h, op.reduction ?? 2), "deskew");
    case "rotate": return must(M.rotate(h, op.angle, op.quality ?? "area"), "rotate");
    case "scale": return must(M.scale(h, op.fx, op.fy ?? op.fx), "scale");
    case "shear": return must(M.shear(h, op.direction, op.angle), "shear");
    case "clip": return must(M.clip(h, op.x, op.y, op.w, op.h), "clip");
    case "translate": return must(M.translate(h, op.dx, op.dy), "translate");
    case "dilate": return must(M.morphDilate(h, op.w, op.h), "dilate");
    case "erode": return must(M.morphErode(h, op.w, op.h), "erode");
    case "open": return must(M.morphOpen(h, op.w, op.h), "open");
    case "close": return must(M.morphClose(h, op.w, op.h), "close");
    case "or": return must(M.bitwiseOr(h, h), "or");
    case "and": return must(M.bitwiseAnd(h, h), "and");
    case "xor": return must(M.bitwiseXor(h, h), "xor");
    case "blend": return must(M.blend(h, h, op.frac), "blend");
    case "addBorder": return must(M.addBorder(h, op.t, op.val ?? 0), "addBorder");
    case "sobel": return must(M.sobel(h, op.orientation ?? "all"), "sobel");
  }
}
