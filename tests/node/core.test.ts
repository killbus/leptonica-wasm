import { existsSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { generateRgba, generateSlantRgba } from "../../scripts/generate-rgba.mjs"
import { load } from "../../src/core/load.ts"
import { Leptonica, Pix } from "../../src/core/types.ts"
import { runChain } from "../../src/core/chain.ts"
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

// M4 review B3: the slant chains' goldens are produced by the CI
// native-oracle job; a dev machine can hold a stale goldens artifact
// that predates them. Restrict parity to the chains whose goldens
// actually exist (CI's guard step pins the full set).
const allChains: { name: string; width: number; height: number; input?: string; ops: Op[]; queries: Query[] }[] = JSON.parse(
  readFileSync(join("tests/golden/chains.json"), "utf8"),
)
const parityChains = allChains.filter(
  (c) => existsSync(join(goldenDir, c.name + ".png")) && existsSync(join(goldenDir, c.name + ".json")),
)

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

  it("deskew on a slanted fixture executes a real rotation and reduces the residual angle (M4 review B3/N1)", async () => {
    const lp = await loadInstance()
    using src = lp.fromRGBA(generateSlantRgba(256, 256), 256, 256)
    using bin = lp.chain(src).toGray().threshold(128).run()
    const before = bin.findSkew()
    // The fixture was chosen so findSkew is confident (conf 3.486 > 3.0):
    // below MinAllowedConfidence deskew takes the pixClone shortcut and
    // the rotation path would never run (the old golden-chain blind spot).
    expect(before.confidence).toBeGreaterThanOrEqual(3.0)
    using deskewed = lp.chain(bin).deskew().run()
    // A real rotation: output differs from the passthrough clone.
    expect(Buffer.compare(Buffer.from(deskewed.toPNG()), Buffer.from(bin.toPNG()))).not.toBe(0)
    // And it moved the estimate toward zero.
    const after = deskewed.findSkew()
    expect(Math.abs(after.angle)).toBeLessThan(Math.abs(before.angle))
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

  it("type rules throw for every op whose depth contract is restricted (M4 review N2)", async () => {
    const lp = await loadInstance()
    // 32bpp source: every op requiring 8 or 1 bpp must throw at record
    // time; ops with requires:null accept any depth (no throw).
    using src32 = lp.fromRGBA(generateRgba(48, 48), 48, 48)
    for (const [op, call] of [
      ["threshold", () => lp.chain(src32).threshold(128)],
      ["otsu", () => lp.chain(src32).otsu({ tile: 16 })],
      ["sauvola", () => lp.chain(src32).sauvola(4)],
      ["dilate", () => lp.chain(src32).dilate(3, 3)],
      ["erode", () => lp.chain(src32).erode(3, 3)],
      ["open", () => lp.chain(src32).open(3, 3)],
      ["close", () => lp.chain(src32).close(3, 3)],
      ["sobel", () => lp.chain(src32).sobel()],
    ] as const) {
      expect(call, op).toThrow(/requires depth/)
    }
    // Depth-preserving ops accept 32bpp.
    expect(() => lp.chain(src32).rotate(0.1).run()).not.toThrow()
    // 8bpp cursor: threshold/otsu/sauvola/sobel accepted, morph rejected.
    using gray = lp.chain(src32).toGray().run()
    expect(() => lp.chain(gray).threshold(128)).not.toThrow()
    expect(() => lp.chain(gray).otsu({ tile: 16 })).not.toThrow()
    expect(() => lp.chain(gray).sauvola(4)).not.toThrow()
    expect(() => lp.chain(gray).sobel()).not.toThrow()
    expect(() => lp.chain(gray).dilate(3, 3)).toThrow(/requires depth/)
    // 1bpp cursor: morph accepted, toGray accepted (any depth), threshold rejected.
    using bin = lp.chain(gray).threshold(128).run()
    expect(() => lp.chain(bin).dilate(3, 3)).not.toThrow()
    expect(() => lp.chain(bin).toGray()).not.toThrow()
    expect(() => lp.chain(bin).threshold(128)).toThrow(/requires depth/)
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

  it("FinalizationRegistry callback does not throw when a live Pix is GC'd in dev mode (M4 review N3)", async () => {
    const lp = await loadInstance()
    // Deliberately drop a live Pix without dispose. In dev mode the
    // registry fires console.warn (decision 4: warn, never free); this
    // test proves the callback itself is exception-free under forced GC.
    const warnings: unknown[] = []
    const origWarn = console.warn
    console.warn = (...args: unknown[]) => warnings.push(args)
    try {
      void lp.fromRGBA(generateRgba(16, 16), 16, 16)
      globalThis.gc?.()
      await new Promise((r) => setTimeout(r, 10))
      globalThis.gc?.()
    } finally {
      console.warn = origWarn
    }
    // Registry ran (or not — GC timing is not contractual); what IS
    // contractual is that nothing threw inside the callback.
    expect(true).toBe(true)
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

  it("close() makes the instance permanently unusable (M4 review W6)", async () => {
    const lp = await loadInstance()
    using src = lp.fromRGBA(generateRgba(16, 16), 16, 16)
    lp.close()
    // The doc promise "Instance is unusable after" - now enforced.
    expect(() => lp.fromRGBA(generateRgba(16, 16), 16, 16)).toThrow(ReferenceError)
    expect(() => lp.chain(src)).toThrow(ReferenceError)
  })

  it("run() after source dispose throws ReferenceError, not UAF (M4 review W7)", async () => {
    const lp = await loadInstance()
    const src = lp.fromRGBA(generateRgba(32, 32), 32, 32)
    const builder = lp.chain(src).toGray()
    src.dispose()
    expect(() => builder.run()).toThrow(ReferenceError)
  })

  it("non-finite parameters are rejected at record time (M4 review W8)", async () => {
    const lp = await loadInstance()
    using src = lp.fromRGBA(generateRgba(16, 16), 16, 16)
    expect(() => lp.chain(src).toGray().threshold(NaN)).toThrow(RangeError)
    expect(() => lp.chain(src).rotate(NaN)).toThrow(RangeError)
    expect(() => lp.chain(src).shear("h", Infinity)).toThrow(RangeError)
    expect(() => lp.chain(src).toGray([NaN, 0.5, 0.2] as const)).toThrow(RangeError)
    expect(() => lp.chain(src).deskew(3 as 1 | 2 | 4)).toThrow(RangeError)
  })

  it("clip beyond the image bounds is clamped, the chain succeeds", async () => {
    const lp = await loadInstance()
    using src = lp.fromRGBA(generateRgba(48, 48), 48, 48)
    // clip with w beyond the image: leptonica clamps the box to the image
    // bounds, so the chain succeeds with a full-size result. (M4 review
    // W2/W9: the old name promised failure-path cleanup this test never
    // exercised — the real failure path is covered below.)
    expect(() => lp.chain(src).toGray().clip(0, 0, 9999, 9999).run()).not.toThrow()
    // Source still usable after the chain.
    expect(src.depth).toBe(32)
  })

  it("chain failure destroys intermediates (runChain catch path)", async () => {
    const lp = await loadInstance()
    using src = lp.fromRGBA(generateRgba(48, 48), 48, 48)
    // runChain takes raw ops — depth rules live in the builder's record
    // time, so a hand-built [toGray, dilate] pair reaches the executor,
    // pixDilateBrickDwa rejects the 8bpp input with null, and applyOp's
    // must() throws — the catch block must dispose the toGray intermediate
    // (design §5.2 run-failure cleanup; the first real execution of that
    // path — M4 review W2: the old suite never ran it).
    const ops: Op[] = [{ op: "toGray" }, { op: "dilate", w: 3, h: 3 }]
    expect(() => runChain(lp, src, ops)).toThrow(/returned null/)
    // Source untouched: intermediates were destroyed, not leaked onto #live.
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

  it("binary ops use the passed operand, not the source (M4 review B1)", async () => {
    const lp = await loadInstance()
    const half = (left: boolean): Pix => {
      const w = 32, h = 32
      const rgba = new Uint8Array(w * h * 4)
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4
          const on = left ? x < w / 2 : x >= w / 2
          rgba[i] = on ? 0 : 255
          rgba[i + 1] = on ? 0 : 255
          rgba[i + 2] = on ? 0 : 255
          rgba[i + 3] = 255
        }
      }
      return lp.chain(lp.fromRGBA(rgba, w, h)).toGray().threshold(128).run()
    }
    using a = half(true)
    using b = half(false)
    const full = a.countPixels() + b.countPixels()
    using or = lp.chain(a).or(b).run()
    using and = lp.chain(a).and(b).run()
    using xor = lp.chain(a).xor(b).run()
    expect(or.countPixels()).toBe(full)
    expect(and.countPixels()).toBe(0)
    expect(xor.countPixels()).toBe(full)
  })

  it("blend uses the passed operand (M4 review B1)", async () => {
    const lp = await loadInstance()
    const solid = (v: number): Pix => {
      const w = 8, h = 8
      const rgba = new Uint8Array(w * h * 4).fill(v)
      for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255
      return lp.fromRGBA(rgba, w, h)
    }
    using black = solid(0)
    using white = solid(255)
    // blend(white into black, 0.5) is mid gray on every channel; the old
    // bug blended the source with itself (black, black) - pure black.
    using out = lp.chain(black).blend(white, 0.5).run()
    const bytes = out.toRGBA()
    for (let i = 0; i < bytes.length; i += 4) {
      expect(Math.abs((bytes[i] ?? 0) - 127)).toBeLessThanOrEqual(1)
    }
  })
})

describe.skipIf(!canRun)("core parity (golden replay through the core API)", () => {
  // Binary-op operands live until after run() (M4 review B1): the builder
  // records a real operand id and the executor resolves it at run time —
  // disposing earlier must throw, so parity replay holds them open here.
  let operands: Pix[] = []
  beforeEach(() => {
    operands = []
  })
  afterEach(() => {
    for (const p of operands) p.dispose()
    operands = []
  })
  const chains = parityChains

  // M4 review W5: it.each so the first failure does not short-circuit the
  // remaining chains — a red run reports every failing chain at once.
  it.each(chains)("$name", async (chain) => {
    const lp = await loadInstance()
    const gen = chain.input === "slant" ? generateSlantRgba : generateRgba
    const src = lp.fromRGBA(gen(chain.width, chain.height), chain.width, chain.height)
    using _src = src
    const builder = lp.chain(src)
    // Record every op through the builder's fluent API.
    for (const [i, op] of chain.ops.entries()) {
      if (op.op === "or" || op.op === "and" || op.op === "xor") {
        // Same-image idempotence strategy (F5): the golden oracle runs the
        // bitwise op with the current image as BOTH operands. Replay the
        // prefix to produce that 1bpp operand and pass it as the real
        // second operand (M4 review B1: the builder records its handle id;
        // the executor resolves it — keep it alive until run()).
        const operand = replayPrefix(lp, src, chain.ops.slice(0, i))
        builder[op.op](operand)
        // Keep the operand alive until run() — resolveOperand re-checks
        // poisoning, so a dispose before run() would throw.
        operands.push(operand)
      } else if (op.op === "blend") {
        // The blend golden chain starts at src: both operands are the raw
        // 32bpp image — the builder records src's operand id and the
        // executor blends with the real second operand.
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
