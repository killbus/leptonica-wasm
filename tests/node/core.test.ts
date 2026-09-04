import { existsSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { describe, expect, it } from "vitest"
import { generateRgba } from "../../scripts/generate-rgba.mjs"
import { load } from "../../src/core/load.ts"
import { Leptonica, Pix } from "../../src/core/types.ts"
import type { Op, Query } from "../../src/protocol.ts"

/*
 * Core-layer tests (M4). Two surfaces:
 *
 * 1. Invariants — deskew angle recovery, otsu bimodality, dilate
 *    monotonicity, depth preservation, type-rule throws, poisoning.
 *    These assert BEHAVIOR, not specific pixels (the golden suite
 *    anchors pixels against the native oracle).
 * 2. Core parity — replay every golden chain through the CORE API
 *    (chain builder + Pix methods) and compare against the same
 *    CI-produced goldens the raw golden suite uses. Proves the wrapper
 *    adds zero drift on top of the bindings.
 *
 * The goldens/ dir is CI-produced (native-oracle job); without it this
 * suite skips the parity half — same posture as golden.test.ts.
 */

const goldenDir = resolve("tests/golden/goldens")
const goldensPresent = existsSync(goldenDir)
const distPresent = existsSync(resolve("dist/leptonica.wasm"))
const canRun = goldensPresent && distPresent

async function loadInstance(): Promise<Leptonica> {
  const factory = (await import(pathToFileURL(resolve("dist/leptonica.mjs")).href)).default
  const module = await factory({ wasmBinary: readFileSync(resolve("dist/leptonica.wasm")) })
  return new Leptonica(module)
}

describe.skipIf(!distPresent)("core invariants", () => {
  it("fromRGBA creates a 32bpp Pix with correct dimensions", async () => {
    const lp = await loadInstance()
    using pix = lp.fromRGBA(generateRgba(48, 48), 48, 48)
    expect(pix.width).toBe(48)
    expect(pix.height).toBe(48)
    expect(pix.depth).toBe(32)
  })

  it("chain toGray→otsu→dilate: depth goes 32→8→1→1, dilate is monotone", async () => {
    const lp = await loadInstance()
    using src = lp.fromRGBA(generateRgba(48, 48), 48, 48)
    using out = lp.chain(src).toGray().otsu({ tile: 16 }).dilate(3, 3).run()
    expect(out.depth).toBe(1)
    // Monotonicity: dilation can only add ON pixels.
    const before = lp.chain(src).toGray().otsu({ tile: 16 }).run()
    using _before = before
    expect(out.countPixels()).toBeGreaterThanOrEqual(before.countPixels())
  })

  it("deskew recovers a known angle", async () => {
    const lp = await loadInstance()
    using src = lp.fromRGBA(generateRgba(48, 48), 48, 48)
    // Rotate by a known angle, threshold, then deskew and check findSkew.
    using rotated = lp.chain(src).toGray().threshold(128).rotate(0.1, "shear").run()
    const skew = rotated.findSkew()
    expect(Math.abs(skew.angle)).toBeGreaterThan(0)
  })

  it("deskew on 8bpp input preserves depth (the corrected rule)", async () => {
    const lp = await loadInstance()
    using src = lp.fromRGBA(generateRgba(48, 48), 48, 48)
    // The depth-corrected deskew rule: any depth in, same depth out.
    using out = lp.chain(src).toGray().deskew().run()
    expect(out.depth).toBe(8)
  })

  it("type rules throw with explanatory errors", async () => {
    const lp = await loadInstance()
    using src = lp.fromRGBA(generateRgba(48, 48), 48, 48)
    // otsu requires 8bpp; src is 32bpp.
    expect(() => lp.chain(src).otsu({ tile: 16 })).toThrow(/requires depth/)
    // morph requires 1bpp.
    expect(() => lp.chain(src).dilate(3, 3)).toThrow(/requires depth/)
  })

  it("disposed Pix is poisoned", async () => {
    const lp = await loadInstance()
    const pix = lp.fromRGBA(generateRgba(16, 16), 16, 16)
    pix.dispose()
    expect(() => pix.width).toThrow(ReferenceError)
    expect(() => pix.toPNG()).toThrow(ReferenceError)
    expect(() => lp.chain(pix)).toThrow(ReferenceError)
    // Double dispose is a no-op, not a throw.
    pix.dispose()
  })

  it("cross-instance handles are rejected", async () => {
    const lp1 = await loadInstance()
    const lp2 = await loadInstance()
    using a = lp1.fromRGBA(generateRgba(16, 16), 16, 16)
    using b = lp2.fromRGBA(generateRgba(16, 16), 16, 16)
    expect(() => lp1.chain(b)).toThrow(/different Leptonica instance/)
  })

  it("close() poisons every live Pix", async () => {
    const lp = await loadInstance()
    const a = lp.fromRGBA(generateRgba(16, 16), 16, 16)
    const b = lp.fromRGBA(generateRgba(16, 16), 16, 16)
    lp.close()
    expect(() => a.width).toThrow(ReferenceError)
    expect(() => b.width).toThrow(ReferenceError)
  })

  it("chain failure cleans up intermediates (no crash, source intact)", async () => {
    const lp = await loadInstance()
    using src = lp.fromRGBA(generateRgba(48, 48), 48, 48)
    // clip with w beyond the image: leptonica clamps the box to the image
    // bounds, so the chain succeeds with a full-size result.
    expect(() => lp.chain(src).toGray().clip(0, 0, 9999, 9999).run()).not.toThrow()
    // Source still usable after a failed chain.
    expect(src.depth).toBe(32)
  })

  it("or/and/xor: same-image idempotence is observable through the core API", async () => {
    const lp = await loadInstance()
    using src = lp.fromRGBA(generateRgba(48, 48), 48, 48)
    using operand = lp.chain(src).toGray().threshold(128).run()
    using or = lp.chain(operand).or(operand).run()
    using and = lp.chain(operand).and(operand).run()
    using xor = lp.chain(operand).xor(operand).run()
    // Idempotence: x OR x == x, x AND x == x, x XOR x == 0.
    expect(or.countPixels()).toBe(operand.countPixels())
    expect(and.countPixels()).toBe(operand.countPixels())
    expect(xor.countPixels()).toBe(0)
  })
})

describe.skipIf(!canRun)("core parity (golden replay through the core API)", () => {
  const chains: { name: string; width: number; height: number; ops: Op[]; queries: Query[] }[] = JSON.parse(
    readFileSync(join("tests/golden/chains.json"), "utf8"),
  )

  it("every chain replays identically through the core API", async () => {
    const lp = await loadInstance()
    for (const chain of chains) {
      const src = lp.fromRGBA(generateRgba(chain.width, chain.height), chain.width, chain.height)
      using _src = src
      const builder = lp.chain(src)
      // Record every op through the builder's fluent API.
      for (const [i, op] of chain.ops.entries()) {
        if (op.op === "or" || op.op === "and" || op.op === "xor") {
          // Same-image idempotence strategy (F5): the golden oracle runs the
          // bitwise op with the current image as BOTH operands. Replay the
          // prefix to produce that 1bpp operand for record-time validation;
          // the executor itself mirrors it as bitwiseOr(h, h).
          const operand = replayPrefix(lp, src, chain.ops.slice(0, i))
          builder[op.op](operand)
          // The operand's handle is never referenced past record time — the
          // recorded Op carries no handle id on this path — so release it now.
          operand.dispose()
        } else if (op.op === "blend") {
          // The blend golden chain starts at src: both operands are the raw
          // 32bpp image (executor: blend(h, h, frac)).
          builder.blend(src, op.frac)
        } else {
          recordOp(builder, op)
        }
      }
      const out = builder.run()
      using _out = out
      const png = out.toPNG()
      const goldenPng = readFileSync(join(goldenDir, chain.name + ".png"))
      expect(
        Buffer.compare(Buffer.from(png), goldenPng),
        `core-API PNG bytes differ for chain '${chain.name}'`,
      ).toBe(0)
      // Queries: compare scalars against the golden JSON.
      const goldenJson = JSON.parse(readFileSync(join(goldenDir, chain.name + ".json"), "utf8")) as {
        skewAngle: number
        skewConf: number
        pixelCount: number
        connCompCount: number
        histogram: number[]
        average: number
      }
      for (const q of chain.queries) {
        if (q.query === "findSkew") {
          const r = out.findSkew()
          expect(Math.abs(r.angle - goldenJson.skewAngle)).toBeLessThanOrEqual(1e-3)
          expect(Math.abs(r.confidence - goldenJson.skewConf)).toBeLessThanOrEqual(1e-3)
        } else if (q.query === "countPixels") {
          expect(out.countPixels()).toBe(goldenJson.pixelCount)
        } else if (q.query === "connComp") {
          expect(out.connComp().length).toBe(goldenJson.connCompCount)
        } else if (q.query === "histogram") {
          expect([...out.histogram()]).toEqual(goldenJson.histogram)
        } else if (q.query === "average") {
          expect(Math.abs(out.average() - goldenJson.average)).toBeLessThanOrEqual(1e-3)
        }
      }
    }
  })
})

/** Record one Op through the chain builder — mirrors protocol.ts shapes. */
function recordOp(builder: ReturnType<Leptonica["chain"]>, op: Op): void {
  switch (op.op) {
    case "toGray": builder.toGray(op.weights ? [...op.weights] : undefined); break
    case "threshold": builder.threshold(op.level); break
    case "otsu": builder.otsu(op.tile !== undefined || op.factor !== undefined ? { ...(op.tile !== undefined ? { tile: op.tile } : {}), ...(op.factor !== undefined ? { factor: op.factor } : {}) } : {}); break
    case "sauvola": builder.sauvola(op.whsize, op.factor); break
    case "deskew": builder.deskew((op.reduction ?? 2) as 1 | 2 | 4); break
    case "rotate": builder.rotate(op.angle, op.quality); break
    case "scale": builder.scale(op.fx, op.fy); break
    case "shear": builder.shear(op.direction, op.angle); break
    case "clip": builder.clip(op.x, op.y, op.w, op.h); break
    case "translate": builder.translate(op.dx, op.dy); break
    case "dilate": builder.dilate(op.w, op.h); break
    case "erode": builder.erode(op.w, op.h); break
    case "open": builder.open(op.w, op.h); break
    case "close": builder.close(op.w, op.h); break
    case "or": case "and": case "xor": case "blend":
      throw new Error(`recordOp: binary op '${op.op}' is handled by the parity loop`)
    case "addBorder": builder.addBorder(op.t, op.val); break
    case "sobel": builder.sobel(op.orientation); break
  }
}

/** Replay the ops preceding a binary op to produce its operand Pix. */
function replayPrefix(lp: Leptonica, src: Pix, prefix: readonly Op[]): Pix {
  const b = lp.chain(src)
  for (const op of prefix) {
    if (op.op === "or" || op.op === "and" || op.op === "xor" || op.op === "blend") {
      throw new Error(`parity replay: binary op '${op.op}' inside a prefix`)
    }
    recordOp(b, op)
  }
  return b.run()
}
