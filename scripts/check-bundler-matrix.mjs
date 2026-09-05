/**
 * Bundler-matrix fixture runner (M5). Every fixture builds/runs the
 * SAME shared entry (tests/bundler-matrix/main.mjs) through a different
 * consumption style — the assertion is that the worker session works
 * from each style, not that four different programs work.
 *
 * Guarded preconditions (fail loud before a bundler reports a confusing
 * downstream error):
 *  - every fixture main.mjs is a shell importing the shared entry
 *  - each fixture has a check script
 *
 * Fixtures install with pnpm (npm's file: symlink handling mangles
 * nested layouts; pnpm resolves package-relative paths per spec). The
 * root package keeps npm per the M0 pin decision — this script only
 * governs fixtures.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const matrixDir = join(root, "tests", "bundler-matrix");
const fixtures = ["node-esm", "vite", "webpack5", "esbuild"];

const SHELL = 'import "../main.mjs";';
let failed = false;

for (const name of fixtures) {
  const dir = join(matrixDir, name);
  const shell = readFileSync(join(dir, "main.mjs"), "utf8");
  if (!shell.includes(SHELL) || shell.split("\n").filter((l) => l.trim() && !l.trim().startsWith("//")).length !== 1) {
    console.error(`check-bundler-matrix: ${name}/main.mjs is not the shared-entry shell — a fixture that runs its own program defeats the matrix's purpose`);
    failed = true;
  }
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  if (typeof pkg.scripts?.check !== "string") {
    console.error(`check-bundler-matrix: ${name} has no check script`);
    failed = true;
  }
}
if (failed) process.exit(1);

// The packageManager pin at the repo root refuses pnpm here; the
// fixtures are deliberately pnpm-managed (see header). The env var
// disables that guard for the fixture installs only.
const env = { ...process.env, npm_config_package_manager_strict: "false" };
{
  const install = spawnSync("pnpm", ["install", "--frozen-lockfile"], { cwd: matrixDir, encoding: "utf8", env, stdio: "pipe" });
  if (install.status !== 0) {
    console.error(`bundler-matrix: pnpm install failed\n${install.stdout}\n${install.stderr}`);
    process.exit(1);
  }
}

for (const name of fixtures) {
  const dir = join(matrixDir, name);
  const check = spawnSync("pnpm", ["--config.verify-deps-before-run=false", "run", "check"], { cwd: dir, encoding: "utf8", env, stdio: "pipe" });
  if (check.status !== 0) {
    console.error(`${name}: check failed\n${check.stdout}\n${check.stderr}`);
    process.exit(1);
  }
  console.log(`${name}: ok`);
}
console.log("bundler-matrix: all fixtures green");
