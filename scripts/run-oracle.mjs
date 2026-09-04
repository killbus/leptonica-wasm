/*
 * Golden-chain runner: drives the native oracle binary over every chain in
 * tests/golden/chains.json and writes goldens/<name>.{png,json}.
 *
 * Runs inside the native-oracle CI job (zero-build discipline: never on a
 * dev machine — it needs the oracle binary, which only CI builds).
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateRgba } from "./generate-rgba.mjs";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const oracleBin = process.argv[2];
if (!oracleBin) {
  console.error("usage: node scripts/run-oracle.mjs <path-to-oracle-binary>");
  process.exit(2);
}

const chains = JSON.parse(readFileSync(join(repoRoot, "tests", "golden", "chains.json"), "utf8"));
const outDir = join(repoRoot, "tests", "golden", "goldens");
mkdirSync(outDir, { recursive: true });

for (const chain of chains) {
  const rgba = generateRgba(chain.width, chain.height);
  const rgbaPath = join(outDir, chain.name + ".rgba");
  const chainPath = join(outDir, chain.name + ".chain.json");
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
