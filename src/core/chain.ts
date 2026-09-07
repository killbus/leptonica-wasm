import type { AreaSelection, BlendOp, BitwiseOp, Op } from "../protocol.ts";
import { OP_DEPTH_RULES, type Depth } from "../protocol.ts";
import { nativeHandleFor, nativeModuleFor, type Leptonica, type Pix } from "./types.ts";
import type { CuratedModule, PixHandle } from "leptonica-wasm/leptonica.mjs";

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
  #record(op: Op): this {
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
    return this;
  }

  toGray(weights?: readonly [number, number, number]): this {
    if (weights !== undefined) {
      const [r, g, b] = weights;
      if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) {
        throw new RangeError(`toGray: weights must be finite, got [${r}, ${g}, ${b}]`);
      }
    }
    return this.#record(
      weights ? { op: "toGray", weights: [...weights] } : { op: "toGray" },
    );
  }

  threshold(level: number): this {
    if (!Number.isFinite(level)) {
      throw new RangeError(`threshold: level must be finite, got ${level}`);
    }
    return this.#record({ op: "threshold", level });
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
    );
  }

  cleanBackgroundToWhite(gamma: number, black: number, white: number): this {
    if (!Number.isFinite(gamma) || gamma <= 0) {
      throw new RangeError(`cleanBackgroundToWhite: gamma must be finite and > 0, got ${gamma}`);
    }
    if (!isInt32(black) || !isInt32(white) || black >= white || white > 200) {
      throw new RangeError(`cleanBackgroundToWhite: require int32 black < white <= 200, got ${black}/${white}`);
    }
    return this.#record({ op: "cleanBackgroundToWhite", gamma, black, white });
  }

  sauvolaTiled(whsize: number, factor: number, nx: number, ny: number): this {
    if (!isInt32(whsize) || whsize < 2) {
      throw new RangeError(`sauvolaTiled: whsize must be an int32 >= 2, got ${whsize}`);
    }
    if (!Number.isFinite(factor) || factor < 0) {
      throw new RangeError(`sauvolaTiled: factor must be finite and >= 0, got ${factor}`);
    }
    if (!isInt32(nx) || nx < 1 || !isInt32(ny) || ny < 1) {
      throw new RangeError(`sauvolaTiled: nx and ny must be positive int32 values, got ${nx}x${ny}`);
    }
    return this.#record({ op: "sauvolaTiled", whsize, factor, nx, ny });
  }

  selectByArea(thresholdArea: number, connectivity: 4 | 8, relation: AreaSelection): this {
    if (!Number.isFinite(thresholdArea) || thresholdArea < 0 || !Number.isFinite(Math.fround(thresholdArea))) {
      throw new RangeError(`selectByArea: thresholdArea must be a finite non-negative float32, got ${thresholdArea}`);
    }
    if (connectivity !== 4 && connectivity !== 8) {
      throw new RangeError(`selectByArea: connectivity must be 4 or 8, got ${connectivity}`);
    }
    if (relation !== "lt" && relation !== "gt" && relation !== "lte" && relation !== "gte") {
      throw new RangeError(`selectByArea: relation must be lt, gt, lte, or gte, got ${relation}`);
    }
    return this.#record({ op: "selectByArea", thresholdArea, connectivity, relation });
  }

  maskOverColorPixels(thresholdDiff: number, minDistance: number): this {
    if (!isInt32(thresholdDiff) || thresholdDiff < 0 || thresholdDiff > 255) {
      throw new RangeError(`maskOverColorPixels: thresholdDiff must be an int32 in [0,255], got ${thresholdDiff}`);
    }
    if (!isInt32(minDistance) || minDistance < 1) {
      throw new RangeError(`maskOverColorPixels: minDistance must be a positive int32, got ${minDistance}`);
    }
    return this.#record({ op: "maskOverColorPixels", thresholdDiff, minDistance });
  }

  deskew(reduction: 1 | 2 | 4 = 2): this {
    if (reduction !== 1 && reduction !== 2 && reduction !== 4) {
      throw new RangeError(`deskew: reduction must be 1, 2, or 4, got ${reduction}`);
    }
    return this.#record({ op: "deskew", reduction });
  }

  rotate(angle: number, quality: "area" | "shear" = "area"): this {
    if (!Number.isFinite(angle)) {
      throw new RangeError(`rotate: angle must be finite (radians), got ${angle}`);
    }
    return this.#record({ op: "rotate", angle, quality });
  }

  scale(fx: number, fy?: number): this {
    if (!Number.isFinite(fx) || fx <= 0) {
      throw new RangeError(`scale: fx must be > 0, got ${fx}`);
    }
    if (fy !== undefined && (!Number.isFinite(fy) || fy <= 0)) {
      throw new RangeError(`scale: fy must be > 0, got ${fy}`);
    }
    return this.#record({ op: "scale", fx, ...(fy !== undefined ? { fy } : {}) });
  }

  shear(direction: "h" | "v", angle: number): this {
    if (!Number.isFinite(angle)) {
      throw new RangeError(`shear: angle must be finite (radians), got ${angle}`);
    }
    return this.#record({ op: "shear", direction, angle });
  }

  clip(x: number, y: number, w: number, h: number): this {
    if (!Number.isInteger(w) || w <= 0 || !Number.isInteger(h) || h <= 0) {
      throw new RangeError(`clip: w and h must be positive integers, got ${w}x${h}`);
    }
    return this.#record({ op: "clip", x, y, w, h });
  }

  translate(dx: number, dy: number): this {
    return this.#record({ op: "translate", dx, dy });
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
    return this.#record({ op: kind, w, h });
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
    // M4 review B1: record the real operand id so the executor (and the
    // M5 wire path) resolves the user's Pix, not the chain's current image.
    return this.#record({ ...op, other: this.#lp.registerOperand(other) });
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
    // Same as #bitwise: blend's second operand must survive into the executor.
    return this.#record({ op: "blend", other: this.#lp.registerOperand(other), frac } satisfies BlendOp);
  }

  addBorder(t: number, val = 0): this {
    if (!Number.isInteger(t) || t < 0) {
      throw new RangeError(`addBorder: t must be a non-negative integer, got ${t}`);
    }
    return this.#record({ op: "addBorder", t, val });
  }

  sobel(orientation: "all" | "h" | "v" = "all"): this {
    return this.#record({ op: "sobel", orientation });
  }

  /** Execute the recorded chain. Returns the final Pix (a new handle). */
  run(): Pix {
    // M4 review W7: the source was validated at record time; re-check at
    // run time — a dispose between chain(src) and run() is a use-after-free,
    // and the poisoning contract promises a ReferenceError, not silence.
    if (this.#src.isPoisoned()) {
      throw new ReferenceError("run: source Pix was disposed before run()");
    }
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
  const M = nativeModuleFor(lp);
  let current = src;
  /** Handles created mid-chain that must be destroyed before returning. */
  const intermediates: Pix[] = [];
  const track = (p: Pix): Pix => {
    intermediates.push(p);
    return p;
  };
  try {
    for (const op of ops) {
      const handle = applyOp(lp, M, current, op);
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

function applyOp(lp: Leptonica, M: CuratedModule, src: Pix, op: Op): PixHandle {
  return lp.callNative(`op:${op.op}`, () => {
    const h = nativeHandleFor(src);
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
    case "cleanBackgroundToWhite": return must(M.cleanBackgroundToWhite(h, op.gamma, op.black, op.white), "cleanBackgroundToWhite");
    case "sauvolaTiled": return must(M.sauvolaTiled(h, op.whsize, op.factor, op.nx, op.ny), "sauvolaTiled");
    case "selectByArea": return must(M.selectByArea(h, op.thresholdArea, op.connectivity, op.relation), "selectByArea");
    case "maskOverColorPixels": return must(M.maskOverColorPixels(h, op.thresholdDiff, op.minDistance), "maskOverColorPixels");
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
    case "or": {
      const other = lp.resolveOperand(op.other, "or");
      return must(M.bitwiseOr(h, nativeHandleFor(other)), "or");
    }
    case "and": {
      const other = lp.resolveOperand(op.other, "and");
      return must(M.bitwiseAnd(h, nativeHandleFor(other)), "and");
    }
    case "xor": {
      const other = lp.resolveOperand(op.other, "xor");
      return must(M.bitwiseXor(h, nativeHandleFor(other)), "xor");
    }
    case "blend": {
      const other = lp.resolveOperand(op.other, "blend");
      return must(M.blend(h, nativeHandleFor(other), op.frac), "blend");
    }
    case "addBorder": return must(M.addBorder(h, op.t, op.val ?? 0), "addBorder");
      case "sobel": return must(M.sobel(h, op.orientation ?? "all"), "sobel");
    }
  });
}

const INT32_MIN = -2_147_483_648;
const INT32_MAX = 2_147_483_647;

function isInt32(value: number): boolean {
  return Number.isInteger(value) && value >= INT32_MIN && value <= INT32_MAX;
}
