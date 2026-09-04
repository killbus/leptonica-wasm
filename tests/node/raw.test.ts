import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadRaw, type RawFunction, type RawVoidFunction } from '../../src/raw/index.ts'

// The full-abi artifacts are build output (dist/ is gitignored, zero-build
// discipline on dev machines). In CI this test runs after the build step;
// locally without a build it skips rather than fails.
const fullAbiDir = resolve('dist/full-abi')
const wasmPath = join(fullAbiDir, 'leptonica.wasm')
const artifactsPresent = existsSync(wasmPath)

describe.skipIf(!artifactsPresent)('raw layer', () => {
  it('instantiates and calls _pixCreate', async () => {
    const { raw } = await loadRaw({ wasmBinary: readFileSync(wasmPath) })
    expect(typeof raw._pixCreate).toBe('function')
    const create = raw._pixCreate as RawFunction
    const pix = create(1, 1, 32)
    expect(pix).toBeGreaterThan(0)
    const destroy = raw._pixDestroy as RawVoidFunction
    destroy(pix)
  })

  it('malloc/free round-trips through heap views', async () => {
    const { raw, memory } = await loadRaw({ wasmBinary: readFileSync(wasmPath) })
    const ptr = raw._malloc(16)
    expect(ptr).toBeGreaterThan(0)
    const view = new Uint8Array(memory.buffer, ptr, 16)
    view[0] = 42
    expect(view[0]).toBe(42)
    raw._free(ptr)
  })

  it('exposes a broad raw symbol surface', async () => {
    const { raw } = await loadRaw({ wasmBinary: readFileSync(wasmPath) })
    for (const name of ['_pixCreate', '_pixGetWidth', '_pixClone', '_pixDestroy', '_malloc', '_free'] as const) {
      expect(typeof raw[name], name).toBe('function')
    }
  })
})
