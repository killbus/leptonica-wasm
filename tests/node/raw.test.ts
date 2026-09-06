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
    const { raw, memory } = await loadRaw({ wasmBinary: readFileSync(wasmPath) })
    expect(typeof raw._pixCreate).toBe('function')
    const create = raw._pixCreate as RawFunction
    const pix = create(1, 1, 32)
    expect(pix).toBeGreaterThan(0)
    // pixDestroy takes PIX** (it nulls the caller's slot), not PIX*:
    // stage the pointer in a heap slot and pass the slot address, matching
    // the C signature in allheaders.h. Passing the pix pointer directly is
    // silent UB — the struct gets treated as a pointer slot (bogus free,
    // clobbered width field).
    const destroy = raw._pixDestroy as RawVoidFunction
    const slot = raw._malloc(4)
    new Int32Array(memory.buffer, slot, 1)[0] = pix
    destroy(slot)
    raw._free(slot)
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

  it('rejects instead of hanging when the wasm bytes are invalid', async () => {
    // loadRaw races the factory promise against a failure side-channel:
    // Emscripten's instantiateWasm callback has no error channel, so without
    // the race a failed instantiation would leave the promise pending
    // forever. This test fails by timeout if that regression returns.
    const garbage = new Uint8Array(8)
    await expect(loadRaw({ wasmBinary: garbage })).rejects.toThrow()
  })

  it('exposes a broad raw symbol surface', async () => {
    const { raw } = await loadRaw({ wasmBinary: readFileSync(wasmPath) })
    for (const name of ['_pixCreate', '_pixGetWidth', '_pixClone', '_pixDestroy', '_malloc', '_free'] as const) {
      expect(typeof raw[name], name).toBe('function')
    }
  })
})
