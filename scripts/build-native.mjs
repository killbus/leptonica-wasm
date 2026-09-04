/*
 * Native oracle build (M4, design §7.2 test matrix).
 *
 * Builds the four versions.json-pinned deps with the host toolchain
 * (cmake + ninja, no emcmake) into tmp/build-native/, then compiles
 * cpp/oracle.c against the native libleptonica.a. The oracle harness is the
 * correctness anchor: same pins, different toolchain than the wasm build.
 *
 * CI is the only build execution site (execution-discipline rule 1) — this
 * script runs inside a workflow job, never on a dev machine.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const depsRoot = join(repoRoot, "tmp", "deps");
const buildRoot = join(repoRoot, "tmp", "build-native");
const installRoot = join(buildRoot, "install");
const versions = JSON.parse(readFileSync(join(repoRoot, "vendor", "versions.json"), "utf8"));

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, { stdio: "inherit", cwd: repoRoot, ...opts });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} failed with exit code ${result.status}`);
  }
}

function ghSlug(repo) {
  return repo.replace(/\.git$/, "").replace(/^https:\/\/github\.com\//, "");
}

function ensureSource(name, pin) {
  const srcDir = join(depsRoot, name);
  const marker = join(srcDir, ".pin-commit");
  if (existsSync(marker) && readFileSync(marker, "utf8").trim() === pin.commit && existsSync(join(srcDir, "CMakeLists.txt"))) {
    return;
  }
  // Remove any stale source tree first (same as build.mjs, M1 review
  // build-eng N1 posture): without this, a pin bump re-extracts the new
  // archive over an old tree and files removed upstream would linger.
  rmSync(srcDir, { recursive: true, force: true });
  mkdirSync(srcDir, { recursive: true });
  mkdirSync(join(repoRoot, "tmp", "downloads"), { recursive: true });
  const archive = join(join(repoRoot, "tmp", "downloads"), `${name}-${pin.commit}.tar.gz`);
  // Download to a .part first, then rename into place (same atomicity as
  // build.mjs): a truncated archive must not persist under the final name.
  const partial = `${archive}.part`;
  run("curl", [
    "-fsSL",
    "--retry",
    "3",
    "-o",
    partial,
    `https://codeload.github.com/${ghSlug(pin.repo)}/tar.gz/${pin.commit}`,
  ]);
  if (!existsSync(partial)) throw new Error(`curl did not produce ${partial}`);
  renameSync(partial, archive);
  run("tar", ["-xzf", archive, "--strip-components=1", "-C", srcDir]);
  writeFileSync(marker, pin.commit + "\n");
}

const depConfigs = [
  {
    name: "zlib",
    extra: ["-DZLIB_BUILD_SHARED=OFF", "-DZLIB_BUILD_TESTING=OFF"],
  },
  {
    name: "libpng",
    extra: [
      "-DPNG_SHARED=OFF",
      "-DPNG_STATIC=ON",
      "-DPNG_TESTS=OFF",
      "-DPNG_TOOLS=OFF",
      `-DZLIB_LIBRARY=${join(installRoot, "lib", "libz.a")}`,
      `-DZLIB_INCLUDE_DIR=${join(installRoot, "include")}`,
    ],
  },
  {
    name: "libjpeg-turbo",
    extra: ["-DWITH_SIMD=OFF", "-DENABLE_SHARED=OFF"],
  },
  {
    name: "leptonica",
    extra: [
      "-DENABLE_WEBP=OFF",
      "-DENABLE_OPENJPEG=OFF",
      "-DENABLE_GIF=OFF",
      "-DENABLE_TIFF=OFF",
      `-DPNG_LIBRARY=${join(installRoot, "lib", "libpng16.a")}`,
      `-DPNG_PNG_INCLUDE_DIR=${join(installRoot, "include")}`,
      `-DZLIB_LIBRARY=${join(installRoot, "lib", "libz.a")}`,
      `-DZLIB_INCLUDE_DIR=${join(installRoot, "include")}`,
      `-DJPEG_LIBRARY=${join(installRoot, "lib", "libjpeg.a")}`,
      `-DJPEG_INCLUDE_DIR=${join(installRoot, "include")}`,
    ],
  },
];

function buildDep(dep, jobs, pin) {
  const buildDir = join(buildRoot, dep.name);
  const doneMarker = join(buildDir, ".done");
  const doneKey = JSON.stringify([pin.commit, dep.extra]);
  if (existsSync(doneMarker) && readFileSync(doneMarker, "utf8") === doneKey) return;
  const srcDir = join(depsRoot, dep.name);
  mkdirSync(buildDir, { recursive: true });
  run("cmake", ["-G", "Ninja", "-DCMAKE_BUILD_TYPE=Release", `-DCMAKE_INSTALL_PREFIX=${installRoot}`, ...dep.extra, srcDir], { cwd: buildDir });
  run("ninja", ["install", ...(jobs > 0 ? [`-j${jobs}`] : [])], { cwd: buildDir });
  writeFileSync(doneMarker, doneKey);
}

function buildOracle(jobs) {
  const outDir = join(buildRoot, "oracle");
  mkdirSync(outDir, { recursive: true });
  run(
    "cc",
    [
      "cpp/oracle.c",
      "-o",
      join(outDir, "oracle"),
      `-I${join(installRoot, "include", "leptonica")}`,
      `-I${join(installRoot, "include")}`,
      `-L${join(installRoot, "lib")}`,
      "-lleptonica",
      "-lpng16",
      "-ljpeg",
      "-lz",
      "-lm",
    ],
  );
  return join(outDir, "oracle");
}

function parseArgs(argv) {
  const opts = { jobs: 0 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--jobs" && i + 1 < argv.length) {
      const v = Number(argv[i + 1]);
      if (!Number.isInteger(v) || v < 1) {
        console.error("usage: node build-native.mjs [--jobs <n>]");
        process.exit(2);
      }
      opts.jobs = v;
      i++;
    } else {
      console.error("usage: node build-native.mjs [--jobs <n>]");
      process.exit(2);
    }
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));

for (const dep of depConfigs) {
  ensureSource(dep.name, versions[dep.name]);
}
for (const dep of depConfigs) {
  buildDep(dep, opts.jobs, versions[dep.name]);
}
const oracle = buildOracle(opts.jobs);
console.log(`native oracle build OK: ${oracle}`);
