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
 * The mutation sites (M4 review N7: rotate rather than a single site):
 *   1. threshold level+1 — binarization boundary drift
 *   2. otsu factor — threshold scaling drift (F-C7: blend frac was
 *      invisible because blend(x,x) is an identity for any frac; otsu
 *      factor carries the same "scalar silently mis-forwarded" risk)
 *   3. rotate angle — geometric parameter drift
 * Each site is mutated in turn; the suite must go red for every one.
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

// M4 review B3: the slant chains' goldens are produced by the CI
// native-oracle job. On a dev machine the goldens dir can be a stale
// artifact that predates them — the ENOENT is environmental, not a
// regression signal, and would poison every site's restore phase.
// Restrict the suite to the chains whose goldens actually exist.
const chainsJsonPath = resolve(repoRoot, 'tests/golden/chains.json');
const goldensDir = resolve(repoRoot, 'tests/golden/goldens');
const chains = JSON.parse(readFileSync(chainsJsonPath, 'utf8'));
const missing = chains.filter(
  (c) => !existsSync(resolve(goldensDir, c.name + '.png')) || !existsSync(resolve(goldensDir, c.name + '.json')),
);
if (missing.length > 0) {
  console.log(
    'mutation-smoke: ' + missing.length + ' chain(s) missing goldens (' +
      missing.map((c) => c.name).join(', ') +
      ') — restricted to chains with goldens present (CI native-oracle regenerates them)',
  );
}

// Mutation sites: [name, from, to] — each must be present exactly once.
const SITES = [
  {
    name: 'threshold level +1',
    from: "case 'threshold': mustPix(L.threshold(pix, op.level), 'threshold'); break",
    to: "case 'threshold': mustPix(L.threshold(pix, op.level + 1), 'threshold'); break",
  },
  {
    name: 'otsu factor 0.1 → 0.2',
    from: "case 'otsu': mustPix(L.otsu(pix, op.tile ?? 16, op.factor ?? 0.1), 'otsu'); break",
    to: "case 'otsu': mustPix(L.otsu(pix, op.tile ?? 16, op.factor ?? 0.2), 'otsu'); break",
  },
  {
    name: 'rotate angle ×2',
    from: "case 'rotate': mustPix(L.rotate(pix, op.angle, op.quality ?? 'area'), 'rotate'); break",
    to: "case 'rotate': mustPix(L.rotate(pix, op.angle * 2, op.quality ?? 'area'), 'rotate'); break",
  },
];
for (const site of SITES) {
  if (!original.includes(site.from)) {
    fail('mutation anchor not found in golden.test.ts — the line to mutate changed:\n  ' + site.from);
  }
}

for (const site of SITES) {
  try {
    // Phase 1: mutate — the suite MUST fail.
    writeFileSync(goldenTestPath, original.replace(site.from, site.to));
    const red = spawnSync('npx', ['vitest', 'run', 'tests/node/golden.test.ts'], { cwd: repoRoot, encoding: 'utf8' });
    if (red.status === 0) {
      fail('MUTANT SURVIVED (' + site.name + '): the golden suite passed with a mutated mapping — the suite is not catching parameter drift');
    }
    console.log('mutant killed: ' + site.name);

    // Phase 2: restore — the suite MUST pass again.
    writeFileSync(goldenTestPath, original);
    const green = spawnSync('npx', ['vitest', 'run', 'tests/node/golden.test.ts'], { cwd: repoRoot, encoding: 'utf8' });
    if (green.status !== 0) {
      fail('restore failed (' + site.name + ') — the golden suite stayed red after reverting the mutation');
    }
    console.log('restored: golden suite green again (' + site.name + ')');
  } finally {
    // Belt and suspenders: never leave the mutant in the tree, even on failure paths.
    writeFileSync(goldenTestPath, original);
  }
}
console.log('mutation-smoke OK (' + SITES.length + ' sites, red -> green cycle each)');
