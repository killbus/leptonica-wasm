import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { generateRgba, generateSlantRgba } from '../../scripts/generate-rgba.mjs'
import type { Op, Query } from '../../src/protocol.ts'

/*
 * Golden-chain comparison (M4): the native oracle (cpp/oracle.c, same
 * versions.json pins, host toolchain) replays each chain and produces the
 * goldens; the wasm side must agree — PNG bytes identical, scalars within
 * tolerance. This is the anti-self-confirmation anchor (design §7.1).
 *
 * Red→green discipline (PRD R4): the red commit is archived in CI — run
 * 33918549378 shows this suite failing on the placeholder before the
 * chain bindings landed. This file is the green side of that pair.
 *
 * The goldens/ dir is CI-produced (downloaded from the native-oracle job);
 * on a dev machine without it the suite skips — same posture as the raw
 * layer tests. CI guards against the vacuous skip separately (the
 * "Goldens present" step in ci.yml).
 */

const goldenDir = resolve('tests/golden/goldens')
const goldensPresent = existsSync(goldenDir)
const distPresent = existsSync(resolve('dist/leptonica.wasm'))

// M4 review B3: the slant chains' goldens are produced by the CI
// native-oracle job; a dev machine can hold a stale goldens artifact
// that predates them. Restrict this suite to the chains whose goldens
// actually exist rather than failing ENOENT on chains the fixture dir
// never carried (CI's guard step pins the full set).
const allChains: { name: string; width: number; height: number; input?: string; ops: Op[]; queries: Query[] }[] = JSON.parse(
  readFileSync(join('tests/golden/chains.json'), 'utf8'),
)
const chains = allChains.filter(
  (c) => existsSync(join(goldenDir, c.name + '.png')) && existsSync(join(goldenDir, c.name + '.json')),
)

/** Minimal chain state — mirrors oracle.c's Chain struct. */
interface ChainResult {
  png: Uint8Array
  skewAngle: number
  skewConf: number
  pixelCount: number
  connCompCount: number
  histogram: number[]
  averageValue: number
}

const SKEW_TOL = 1e-3 // degrees — wasm/native float paths can differ in ulps
const CONF_TOL = 1e-3

/**
 * Replay a chain through the wasm bindings. Each op maps 1:1 to the same
 * leptonica call the oracle makes (cpp/oracle.c applyOp ↔ this switch).
 * Returns the final PNG plus query results so both comparison surfaces
 * (bytes + scalars) come from one replay.
 */
async function playChain(w: number, h: number, ops: readonly Op[], queries: readonly Query[], input?: string): Promise<ChainResult> {
  const jsPath = resolve('dist/leptonica.mjs')
  const wasmPath = resolve('dist/leptonica.wasm')
  const factory = (await import(pathToFileURL(jsPath).href)).default
  const L = await factory({ wasmBinary: readFileSync(wasmPath) })

  const gen = input === 'slant' ? generateSlantRgba : generateRgba
  let pix: unknown = L.fromRGBA(gen(w, h), w, h)
  if (pix === null) throw new Error('fromRGBA returned null')

  const mustPix = (next: unknown, op: string): void => {
    if (next === null || next === undefined) throw new Error(`op ${op} returned null`)
    pix = next
  }

  for (const op of ops) {
    switch (op.op) {
      case 'toGray':
        mustPix(op.weights ? L.toGrayWeighted(pix, ...op.weights) : L.toGray(pix), 'toGray')
        break
      case 'threshold': mustPix(L.threshold(pix, op.level), 'threshold'); break
      case 'otsu': mustPix(L.otsu(pix, op.tile ?? 16, op.factor ?? 0.1), 'otsu'); break
      case 'sauvola': mustPix(L.sauvola(pix, op.whsize, op.factor ?? 0.34), 'sauvola'); break
      case 'deskew': mustPix(L.deskew(pix, op.reduction ?? 2), 'deskew'); break
      case 'rotate': mustPix(L.rotate(pix, op.angle, op.quality ?? 'area'), 'rotate'); break
      case 'scale': mustPix(L.scale(pix, op.fx, op.fy ?? op.fx), 'scale'); break
      case 'shear': mustPix(L.shear(pix, op.direction, op.angle), 'shear'); break
      case 'clip': mustPix(L.clip(pix, op.x, op.y, op.w, op.h), 'clip'); break
      case 'translate': mustPix(L.translate(pix, op.dx, op.dy), 'translate'); break
      case 'dilate': mustPix(L.morphDilate(pix, op.w, op.h), 'dilate'); break
      case 'erode': mustPix(L.morphErode(pix, op.w, op.h), 'erode'); break
      case 'open': mustPix(L.morphOpen(pix, op.w, op.h), 'open'); break
      case 'close': mustPix(L.morphClose(pix, op.w, op.h), 'close'); break
      case 'or': mustPix(L.bitwiseOr(pix, pix), 'or'); break // same-image idempotence (F5)
      case 'and': mustPix(L.bitwiseAnd(pix, pix), 'and'); break
      case 'xor': mustPix(L.bitwiseXor(pix, pix), 'xor'); break
      case 'blend': mustPix(L.blend(pix, pix, op.frac), 'blend'); break
      case 'addBorder': mustPix(L.addBorder(pix, op.t, op.val ?? 0), 'addBorder'); break
      case 'sobel': mustPix(L.sobel(pix, op.orientation ?? 'all'), 'sobel'); break
    }
  }

  const png = new Uint8Array(L.toPNG(pix))
  let skewAngle = 0
  let skewConf = 0
  let pixelCount = 0
  let connCompCount = 0
  let histogram: number[] = []
  let averageValue = 0
  for (const q of queries) {
    if (q.query === 'findSkew') {
      const r = L.findSkew(pix)
      if (r === null) throw new Error('findSkew returned null')
      skewAngle = r.angle as number
      skewConf = r.confidence as number
    } else if (q.query === 'countPixels') {
      const n = L.countPixels(pix)
      if (n < 0) throw new Error('countPixels failed')
      pixelCount = n
    } else if (q.query === 'connComp') {
      const boxes = L.connComp(pix)
      if (boxes === null) throw new Error('connComp returned null')
      connCompCount = boxes.length as number
    } else if (q.query === 'histogram') {
      const bins = L.histogram(pix)
      if (bins === null) throw new Error('histogram returned null')
      histogram = bins as number[]
      if (histogram.length !== 256) throw new Error(`histogram length ${histogram.length} != 256`)
    } else if (q.query === 'average') {
      const avg = L.average(pix)
      if (avg === null) throw new Error('average returned null')
      averageValue = avg as number
    }
  }
  return { png, skewAngle, skewConf, pixelCount, connCompCount, histogram, averageValue }
}

describe.skipIf(!goldensPresent || !distPresent)('golden chains (oracle comparison)', () => {
  // M4 review W5: it.each so the first failure does not short-circuit the
  // remaining chains — a red run reports every failing chain at once.
  it.each(chains)('$name', async (chain) => {
    const goldenPng = readFileSync(join(goldenDir, chain.name + '.png'))
    const goldenJson = JSON.parse(readFileSync(join(goldenDir, chain.name + '.json'), 'utf8')) as {
      skewAngle: number
      skewConf: number
      pixelCount: number
      connCompCount: number
      histogram: number[]
      average: number
    }
    const got = await playChain(chain.width, chain.height, chain.ops, chain.queries, chain.input)
    // PNG: byte-identical. Both sides use the same zlib/libpng pins and
    // deterministic encoders; if this ever fails on a filter-chunk
    // boundary (stream vs memory write path), the fallback is
    // pixel-level comparison — recorded as a design adjudication, not
    // silently loosened here.
    expect(
      Buffer.compare(Buffer.from(got.png), goldenPng),
      `PNG bytes differ for chain '${chain.name}'`,
    ).toBe(0)
    // Scalars: floats within tolerance, counts exact.
    expect(Math.abs(got.skewAngle - goldenJson.skewAngle)).toBeLessThanOrEqual(SKEW_TOL)
    expect(Math.abs(got.skewConf - goldenJson.skewConf)).toBeLessThanOrEqual(CONF_TOL)
    expect(got.pixelCount).toBe(goldenJson.pixelCount)
    expect(got.connCompCount).toBe(goldenJson.connCompCount)
    // Query-scoped assertions: the oracle JSON always carries all scalar
    // fields (zero-initialized), but the wasm side only populates the
    // fields a chain's queries select. Compare only what the chain asked
    // for — a chain without the histogram query has [] here, not the
    // oracle's 256 zeros.
    const queryKinds = new Set(chain.queries.map((q) => q.query))
    // Full-bin equality: every one of the 256 bins must match exactly —
    // a summed-only check would pass with compensating bin errors.
    if (queryKinds.has('histogram')) {
      expect(got.histogram).toEqual(goldenJson.histogram)
    }
    if (queryKinds.has('average')) {
      expect(Math.abs(got.averageValue - goldenJson.average)).toBeLessThanOrEqual(CONF_TOL)
    }
  })

  // Vacuous-skip guard (in-suite copy of the CI step): an empty
  // chains.json would otherwise produce zero passing it.each cases.
  it('chains.json is non-empty', () => {
    expect(chains.length).toBeGreaterThan(0)
  })
})
