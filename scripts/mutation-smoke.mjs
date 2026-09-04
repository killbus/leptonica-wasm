/*
 * Mutation smoke (M4; M2 review F5 backfill).
 *
 * Proves the golden suite catches a broken parameter mapping: mutate one
 * binding, run the golden suite, and require it to FAIL. Then restore and
 * require it to pass. M2's version of this was a one-off manual
 * procedure (paper evidence); this script persists it.
 *
 * Usage (CI only — needs a build):
 *   node scripts/mutation-smoke.mjs
 *
 * The mutation: pass level+1 instead of level for threshold in the
 * golden test's own replay path. Every threshold chain's golden PNG must
 * then differ — a pixel-exact comparison that cannot pass by accident.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const goldenTestPath = resolve(repoRoot, 'tests/node/golden.test.ts');
const wasmPath = resolve(repoRoot, 'dist/leptonica.wasm');

function fail(msg) {
  console.error('mutation-smoke: ' + msg);
  process.exit(1);
}

if (!existsSync(wasmPath)) {
  fail('dist/leptonica.wasm missing — this script needs a CI build (zero-build discipline)');
}

const original = readFileSync(goldenTestPath, 'utf8');

// The mutation site: threshold's level mapping. The original passes
// op.level; the mutant passes op.level + 1 — a classic off-by-one in
// parameter translation that pixel-exact goldens must catch.
const MUTATION_FROM = "case 'threshold': mustPix(L.threshold(pix, op.level), 'threshold'); break;";
const MUTATION_TO = "case 'threshold': mustPix(L.threshold(pix, op.level + 1), 'threshold'); break;";
if (!original.includes(MUTATION_FROM)) {
  fail('mutation anchor not found in golden.test.ts — the line to mutate changed:\n  ' + MUTATION_FROM);
}

try {
  // Phase 1: mutate — the suite MUST fail.
  writeFileSync(goldenTestPath, original.replace(MUTATION_FROM, MUTATION_TO));
  const red = spawnSync('npx', ['vitest', 'run', 'tests/node/golden.test.ts'], { cwd: repoRoot, encoding: 'utf8' });
  if (red.status === 0) {
    fail('MUTANT SURVIVED: the golden suite passed with a mutated threshold mapping — the suite is not catching parameter drift');
  }
  console.log('mutant killed: golden suite went red on the mutated threshold level (+1)');

  // Phase 2: restore — the suite MUST pass again.
  writeFileSync(goldenTestPath, original);
  const green = spawnSync('npx', ['vitest', 'run', 'tests/node/golden.test.ts'], { cwd: repoRoot, encoding: 'utf8' });
  if (green.status !== 0) {
    fail('restore failed — the golden suite stayed red after reverting the mutation');
  }
  console.log('restored: golden suite green again');
  console.log('mutation-smoke OK (red -> green cycle verified)');
} finally {
  // Belt and suspenders: never leave the mutant in the tree, even on failure paths.
  writeFileSync(goldenTestPath, original);
}
