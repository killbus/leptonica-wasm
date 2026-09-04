/*
 * Golden-chain runner: drives the native oracle binary over every chain in
 * tests/golden/chains.json and writes goldens/<name>.{png,json}. Chain
 * inputs (.rgba/.chain.json) land in a scratch dir outside goldens/ so
 * the goldens artifact stays outputs-only (run 33918364134: the artifact
 * count check double-counted the .chain.json files as golden JSONs).
 *
 * Runs inside the native-oracle CI job (zero-build discipline: never on a
 * dev machine — it needs the oracle binary, which only CI builds).
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generateRgba } from "./generate-rgba.mjs";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const oracleBin = process.argv[2];
if (!oracleBin) {
  console.error("usage: node scripts/run-oracle.mjs <path-to-oracle-binary> [outDir]");
  process.exit(2);
}

const chains = JSON.parse(readFileSync(join(repoRoot, "tests", "golden", "chains.json"), "utf8"));
// Optional <outDir> relocates the goldens (e.g. a dedicated artifact
// staging dir); transient per-chain inputs always land in tmp/ (gitignored).
const outDir = process.argv[3] ? resolve(process.argv[3]) : join(repoRoot, "tests", "golden", "goldens");
const workDir = join(repoRoot, "tmp", "golden-chains");
mkdirSync(outDir, { recursive: true });
mkdirSync(workDir, { recursive: true });

for (const chain of chains) {
  const rgba = generateRgba(chain.width, chain.height);
  // Per-chain files carry the run's transient inputs (.rgba/.chain.json);
  // only the two outputs per chain are needed in the goldens dir.
  const rgbaPath = join(workDir, chain.name + ".rgba");
  const chainPath = join(workDir, chain.name + ".chain.json");
  const pngPath = join(outDir, chain.name + ".png");
  const jsonPath = join(outDir, chain.name + ".json");
  // chain.json for the oracle: strip "name", keep width/height/ops/queries.
  const { name: _name, ...spec } = chain;
  writeFileSync(chainPath, JSON.stringify(spec));
  writeFileSync(rgbaPath, rgba);
  const res = spawnSync(oracleBin, [chainPath, rgbaPath, pngPath, jsonPath], { cwd: repoRoot });
  if (res.status !== 0) {
    console.error(`oracle failed for chain '${chain.name}' (exit ${res.status}):`);
    if (res.stdout) console.error(res.stdout.toString());
    if (res.stderr) console.error(res.stderr.toString());
    process.exit(1);
  }
  console.log(`golden ${chain.name}: png ${pngPath} + json ${jsonPath}`);
}
console.log(`${chains.length} goldens written to ${outDir}`);
