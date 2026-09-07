import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function run(command, args) {
  const result = spawnSync(command, args, { cwd: repoRoot, stdio: "inherit", env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function capture(command, args) {
  const result = spawnSync(command, args, { cwd: repoRoot, encoding: "utf8", env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

function gitDirty() {
  return capture("git", ["status", "--porcelain", "--untracked-files=normal"]).length > 0;
}

run(process.execPath, ["scripts/build.mjs"]);
run(process.execPath, ["scripts/build.mjs", "--full-abi"]);
run(process.execPath, ["scripts/gen-types.mjs"]);
run(process.execPath, ["scripts/check-exports.mjs", "dist"]);
run(process.execPath, ["scripts/check-exports.mjs", "--curated-methods", "dist"]);
run(process.execPath, ["scripts/smoke.mjs", "dist"]);
run(process.execPath, ["scripts/check-exports.mjs", "--full-abi", "dist/full-abi"]);
run(process.execPath, ["scripts/smoke.mjs", "--full-abi", "dist/full-abi"]);

// Build timing varies by runner and is useful to CI diagnostics, not to
// consumers. Keep it out of the content-addressed distributable so the same
// source and toolchain can produce the same package file set.
rmSync(join(repoRoot, "dist", "build-report.json"), { force: true });
rmSync(join(repoRoot, "dist", "full-abi", "build-report.json"), { force: true });

const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
const sourceCommit = (process.env.LEPTONICA_WASM_SOURCE_COMMIT || capture("git", ["rev-parse", "HEAD"])).toLowerCase();
if (!/^[0-9a-f]{40}$/.test(sourceCommit)) throw new Error(`invalid source commit: ${sourceCommit}`);
const provenance = {
  schemaVersion: 1,
  packageName: pkg.name,
  packageVersion: pkg.version,
  sourceCommit,
  sourceTreeDirty: gitDirty(),
  dependencyPins: JSON.parse(readFileSync(join(repoRoot, "vendor", "versions.json"), "utf8")),
};
writeFileSync(join(repoRoot, "dist", "package-provenance.json"), JSON.stringify(provenance, null, 2) + "\n");

run(process.execPath, ["scripts/check-package-contract.mjs", "--package-root", repoRoot]);
run(process.execPath, ["scripts/gen-hash-manifest.mjs"]);
run(process.execPath, ["scripts/check-package-contract.mjs", "--package-root", repoRoot, "--manifest"]);
