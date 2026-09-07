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
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertEnvironmentVariablesUnset,
  dependencyBuildIdentitySha256,
  dependencySourceSetSha256,
  commandVersion,
  readDependencyBuildCache,
  withDependencyBuildLock,
  writeDependencyBuildCache,
} from "./dependency-cache.mjs";
import { prepareSourceTreeFromArchive, resolveSourcePatchSet } from "./source-patches.mjs";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const depsRoot = join(repoRoot, "tmp", "deps");
const downloadsRoot = join(repoRoot, "tmp", "downloads");
const buildRoot = join(repoRoot, "tmp", "build-native");
const versions = JSON.parse(readFileSync(join(repoRoot, "vendor", "versions.json"), "utf8"));
const nativeToolchainConfigure = [
  "-DCMAKE_C_COMPILER=cc",
  "-DCMAKE_CXX_COMPILER=c++",
  "-DCMAKE_AR=ar",
  "-DCMAKE_RANLIB=ranlib",
];

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
  const source = resolveSourcePatchSet(name, pin, repoRoot);
  const srcDir = join(depsRoot, `${name}-${source.sourceIdentitySha256}`);
  const archive = join(downloadsRoot, `${name}-${pin.commit}.tar.gz`);
  prepareSourceTreeFromArchive({
    source,
    sourceDir: srcDir,
    archive,
    download(candidate) {
      mkdirSync(downloadsRoot, { recursive: true });
      run("curl", [
        "-fsSL",
        "--retry",
        "3",
        "-o",
        candidate,
        `https://codeload.github.com/${ghSlug(pin.repo)}/tar.gz/${pin.commit}`,
      ]);
    },
    extract(archiveToExtract, stagingDir) {
      run("tar", ["-xzf", archiveToExtract, "--strip-components=1", "-C", stagingDir]);
    },
  });
  return Object.freeze({ ...source, sourceDir: srcDir });
}

function createDepConfigs(installRoot) {
  return [
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
}

function buildDep(dep, jobs, source, dependencyBuildRoot, installRoot) {
  const buildDir = join(dependencyBuildRoot, dep.name);
  const srcDir = source.sourceDir;
  mkdirSync(buildDir, { recursive: true });
  run("cmake", [
    "-G",
    "Ninja",
    "-DCMAKE_BUILD_TYPE=Release",
    `-DCMAKE_INSTALL_PREFIX=${installRoot}`,
    ...nativeToolchainConfigure,
    ...dep.extra,
    srcDir,
  ], { cwd: buildDir });
  run("ninja", ["install", ...(jobs > 0 ? [`-j${jobs}`] : [])], { cwd: buildDir });
}

function createDependencyBuildInput(depConfigs, dependencySources) {
  return {
    schemaVersion: 1,
    platform: process.platform,
    architecture: process.arch,
    toolchain: {
      ccVersion: commandVersion("cc"),
      cxxVersion: commandVersion("c++"),
      arVersion: commandVersion("ar"),
      ranlibVersion: commandVersion("ranlib"),
      cmakeVersion: commandVersion("cmake"),
      ninjaVersion: commandVersion("ninja"),
    },
    environment: Object.fromEntries([
      "CFLAGS",
      "CXXFLAGS",
      "CPPFLAGS",
      "LDFLAGS",
    ].map((name) => [name, process.env[name] ?? null])),
    dependencies: depConfigs.map((dep) => ({
      name: dep.name,
      sourceIdentitySha256: dependencySources.get(dep.name).sourceIdentitySha256,
      configure: [...nativeToolchainConfigure, ...dep.extra],
    })),
  };
}

function buildDependencies(depConfigs, dependencySources, jobs, dependencyBuildRoot, installRoot, buildIdentitySha256) {
  const marker = join(dependencyBuildRoot, ".done.json");
  const cached = readDependencyBuildCache({
    marker,
    installRoot,
    buildIdentitySha256,
    label: "native dependency",
  });
  if (cached) return cached;

  return withDependencyBuildLock({
    lock: `${dependencyBuildRoot}.lock`,
    label: "native dependency",
  }, () => {
    const rechecked = readDependencyBuildCache({
      marker,
      installRoot,
      buildIdentitySha256,
      label: "native dependency",
    });
    if (rechecked) return rechecked;

    rmSync(dependencyBuildRoot, { recursive: true, force: true });
    mkdirSync(dependencyBuildRoot, { recursive: true });
    for (const dep of depConfigs) {
      buildDep(dep, jobs, dependencySources.get(dep.name), dependencyBuildRoot, installRoot);
    }
    return writeDependencyBuildCache({
      marker,
      installRoot,
      buildIdentitySha256,
      label: "native dependency",
    });
  });
}

function buildOracle(installRoot) {
  // Keep the public CI/artifact contract stable even though dependency
  // installs now live under an identity-addressed cache directory.
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
assertEnvironmentVariablesUnset(
  process.env,
  ["CMAKE_TOOLCHAIN_FILE"],
  "native dependency build",
);

const dependencySources = new Map();
const dependencyNames = ["zlib", "libpng", "libjpeg-turbo", "leptonica"];
for (const name of dependencyNames) {
  dependencySources.set(name, ensureSource(name, versions[name]));
}
const sourceSetSha256 = dependencySourceSetSha256(dependencyNames, dependencySources);
const identityDepConfigs = createDepConfigs("<INSTALL_ROOT>");
const dependencyBuildIdentity = dependencyBuildIdentitySha256(
  createDependencyBuildInput(identityDepConfigs, dependencySources),
);
const dependencyBuildRoot = join(buildRoot, "deps", sourceSetSha256, dependencyBuildIdentity);
const installRoot = join(dependencyBuildRoot, "install");
const depConfigs = createDepConfigs(installRoot);
buildDependencies(
  depConfigs,
  dependencySources,
  opts.jobs,
  dependencyBuildRoot,
  installRoot,
  dependencyBuildIdentity,
);
const oracle = buildOracle(installRoot);
console.log(`native oracle build OK: ${oracle}`);
