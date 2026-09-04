import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Op, Query } from '../../src/protocol.ts'

/*
 * Golden-chain comparison (M4): the native oracle (cpp/oracle.c, same
 * versions.json pins, host toolchain) replays each chain and produces the
 * goldens; the wasm side must agree — PNG bytes identical, scalars within
 * tolerance. This is the anti-self-confirmation anchor (design §7.1).
 *
 * Test-first discipline: these assertions are written BEFORE the chain
 * bindings exist. They are expected to fail until the embind layer
 * implements the operator surface (red → green, PRD R4).
 */

const goldenDir = resolve('tests/golden/goldens')
const goldensPresent = existsSync(goldenDir)

describe.skipIf(!goldensPresent)('golden chains (oracle comparison)', () => {
  it('wasm chain output matches oracle goldens', async () => {
    // Placeholder until the chain player + bindings land: this file is the
    // red-first test target. The comparison harness (playChain + compare)
    // arrives with the bindings change in the same milestone.
    expect.fail('golden comparison harness not implemented yet — red-first placeholder')
  })
})
