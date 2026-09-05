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
 * Fixtures install with pnpm, like the root package (2026-09-05 the
 * whole repo moved to pnpm; the fixtures were pnpm-first since M5 —
 * npm's file: symlink handling mangles nested layouts, pnpm resolves
 * package-relative paths per spec).
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
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

// CI=true: pnpm refuses to purge a foreign node_modules without a TTY
// confirmation (the fixtures were installed by a different manager or
// pnpm major at some point); non-interactive runs need the override.
const env = { ...process.env, CI: "true" };
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

// Layout assertion (review M5 B2): build-only fixtures cannot execute
// a browser bundle in Node, but the runtime wasm dependency is still
// statically verifiable — the emscripten loader keeps
// new URL("leptonica.wasm", import.meta.url) as a literal inside the
// worker chunk. Two shapes survive bundling, depending on the tool:
//  - untouched literal: new URL("leptonica.wasm", import.meta.url) —
//    the wasm is a sibling of the emitted file (esbuild, webpack)
//  - rewritten asset URL: new URL("<hashed>.wasm", self.location.href)
//    or import.meta.url — vite rewrites to its /assets/ output
// Assert the file each emitted URL points at actually exists: this is
// what caught the esbuild fixture shipping without the wasm binary
// (a false green at build level).
const layoutDirs = [
  ["vite", join(matrixDir, "vite", "dist")],
  ["webpack5", join(matrixDir, "webpack5", "dist")],
  ["esbuild", join(matrixDir, "esbuild", "dist")],
];
for (const [name, dir] of layoutDirs) {
  const files = readdirSync(dir, { recursive: true })
    .map((f) => join(dir, String(f)))
    .filter((f) => /worker|main/.test(basename(f)) && /\.(mjs|js)$/.test(f));
  let asserted = false;
  for (const file of files) {
    const src = readFileSync(file, "utf8");
    const matches = [
      ...src.matchAll(/new URL\("([^"\s]*\.wasm)",\s*import\.meta\.url\)/g),
      ...src.matchAll(/new URL\("([^"\s]*\.wasm)",\s*self\.location\.href\)/g),
    ];
    for (const m of matches) {
      // import.meta.url shapes resolve against the emitting file's
      // directory; self.location.href shapes are absolute from the
      // server root (vite /assets/ output).
      const url = m[1];
      const target = url.startsWith("/") ? join(matrixDir, name, "dist", url.slice(1)) : join(dirname(file), url);
      if (!existsSync(target)) {
        console.error(`bundler-matrix layout: ${name} emits ${file} referencing ${m[1]}, but ${target} is missing`);
        process.exit(1);
      }
      asserted = true;
    }
  }
  if (!asserted) {
    console.error(`bundler-matrix layout: ${name} emitted no wasm URL pattern in any artifact — assertion cannot run`);
    process.exit(1);
  }
  console.log(`${name}: wasm layout ok`);
}
console.log("bundler-matrix: all fixtures green");
