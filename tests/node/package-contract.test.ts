import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { stringify } from "yaml";
import { describe, expect, it } from "vitest";
import { EXPECTED_EXPORTS, validatePackageContract } from "../../scripts/check-package-contract.mjs";
import { generateHashManifest } from "../../scripts/gen-hash-manifest.mjs";
import {
  CONSUMER_TOOL_VERSIONS,
  consumerWorkspaceYaml,
  gitDependencyId,
  isRetryableNetworkError,
  removeConsumerRoot,
  retryAfterMilliseconds,
  retryWithBackoff,
  withConsumerRootCleanup,
  validateConsumerLockfile,
  validateInstalledPackageRoot,
  verifyBrowserBundleLayout,
  writeConsumer,
} from "../../scripts/run-consumer-gate.mjs";

function git(root: string, args: readonly string[]): string {
  const result = spawnSync(
    "git",
    ["-c", "core.excludesFile=/dev/null", ...args],
    { cwd: root, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout.trimEnd();
}

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "leptonica-package-contract-"));
  const exports: Record<string, Record<string, string>> = Object.fromEntries(EXPECTED_EXPORTS.map((key, index) => {
    const base = `dist/entry-${index}`;
    if (key.endsWith(".wasm")) return [key, { default: `./${base}.wasm` }];
    return [key, { types: `./${base}.d.ts`, import: `./${base}.js` }];
  }));
  writeFileSync(join(root, "package.json"), JSON.stringify({
    name: "leptonica-wasm",
    version: "0.1.1",
    files: ["src", "dist", "README.md", "LICENSE", "vendor/versions.json", "vendor/patches"],
    exports,
  }));
  for (const path of [
    "LICENSE", "README.md", "vendor/patches/leptonica-1.87.0-recoverable-oom.patch",
    "dist/leptonica.mjs", "dist/leptonica.wasm", "dist/leptonica.d.ts", "dist/worker.mjs",
    "dist/types/index.js", "dist/types/index.d.ts", "dist/types/raw/index.js", "dist/types/raw/index.d.ts",
    "dist/types/worker/index.js", "dist/types/worker/index.d.ts", "dist/types/worker/node.js",
    "dist/types/worker/node.d.ts", "dist/types/worker/worker.mjs", "dist/types/worker/worker.d.ts",
    "dist/full-abi/leptonica.mjs", "dist/full-abi/leptonica.wasm", "dist/full-abi/leptonica-raw.d.ts",
  ]) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), path.endsWith(".json") ? "{}\n" : "");
  }
  const patchFile = "vendor/patches/leptonica-1.87.0-recoverable-oom.patch";
  const patchSha256 = createHash("sha256").update(readFileSync(join(root, patchFile))).digest("hex");
  const dependencyPins = {
    leptonica: {
      commit: "c".repeat(40),
      sourceTreeSha256: "1".repeat(64),
      patchedSourceTreeSha256: "2".repeat(64),
      patches: [{ file: patchFile, appliesToCommit: "c".repeat(40), sha256: patchSha256 }],
    },
  };
  writeFileSync(join(root, "vendor/versions.json"), JSON.stringify(dependencyPins));
  for (const value of Object.values(exports)) {
    for (const target of Object.values(value)) {
      mkdirSync(join(root, target, ".."), { recursive: true });
      writeFileSync(join(root, target), "");
    }
  }
  writeFileSync(join(root, "dist/package-provenance.json"), JSON.stringify({
    sourceCommit: "a".repeat(40), packageVersion: "0.1.1", sourceTreeDirty: false, dependencyPins,
  }));
  return root;
}

function writeManifest(root: string): void {
  const files = ["leptonica.mjs"];
  const entries = files.map((path) => {
    const content = Buffer.from("");
    return { path, bytes: content.length, sha256: createHash("sha256").update(content).digest("hex") };
  });
  writeFileSync(join(root, "dist/sha256.json"), JSON.stringify({ files: entries }));
}

function writeCompleteManifest(root: string): void {
  const distRoot = join(root, "dist");
  const list = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? list(path) : [path];
  });
  const entries = list(distRoot).map((absolutePath) => {
    const path = absolutePath.slice(distRoot.length + 1).replaceAll("\\", "/");
    const content = readFileSync(absolutePath);
    return { path, bytes: content.length, sha256: createHash("sha256").update(content).digest("hex") };
  });
  writeFileSync(join(distRoot, "sha256.json"), JSON.stringify({ schemaVersion: 1, files: entries }));
}

describe("package contract checker", () => {
  it("keeps only the known auxiliary build outputs outside source-dirty provenance", () => {
    const root = mkdtempSync(join(tmpdir(), "leptonica-source-dirty-"));
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, ".gitignore"), readFileSync(".gitignore"));
    writeFileSync(join(root, "src/tracked.ts"), "export const value = 1;\n");
    git(root, ["init", "--quiet"]);
    git(root, ["config", "user.name", "Source Dirty Contract"]);
    git(root, ["config", "user.email", "source-dirty@example.invalid"]);
    git(root, ["add", "."]);
    git(root, ["commit", "--quiet", "-m", "fixture"]);

    for (const directory of ["dist-o2", "dist-instrumented"]) {
      mkdirSync(join(root, directory));
      writeFileSync(join(root, directory, "artifact.wasm"), directory);
    }
    expect(git(root, ["status", "--porcelain", "--untracked-files=normal"])).toBe("");

    writeFileSync(join(root, "src/tracked.ts"), "export const value = 2;\n");
    expect(git(root, ["status", "--porcelain", "--untracked-files=normal"])).toContain(
      " M src/tracked.ts",
    );
    writeFileSync(join(root, "src/tracked.ts"), "export const value = 1;\n");

    writeFileSync(join(root, "src/untracked.ts"), "export {};\n");
    for (const directory of ["dist-o2", "dist-instrumented"]) {
      mkdirSync(join(root, "src", directory));
      writeFileSync(join(root, "src", directory, "source.ts"), "export {};\n");
    }
    mkdirSync(join(root, "dist-unexpected"));
    writeFileSync(join(root, "dist-unexpected/artifact.wasm"), "unexpected");
    const dirty = git(root, ["status", "--porcelain", "--untracked-files=normal"]);
    expect(dirty).toContain("?? src/untracked.ts");
    expect(dirty).toContain("?? src/dist-o2/");
    expect(dirty).toContain("?? src/dist-instrumented/");
    expect(dirty).toContain("?? dist-unexpected/");
  });

  it("accepts a complete regular-file manifest", () => {
    const root = fixture();
    writeCompleteManifest(root);
    expect(validatePackageContract(root, { requireManifest: true })).toEqual([]);
  });

  it("fails when a declared public export disappears", () => {
    const root = fixture();
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    delete pkg.exports["./worker/node"];
    writeFileSync(join(root, "package.json"), JSON.stringify(pkg));
    expect(validatePackageContract(root)).toContainEqual(expect.stringContaining("exports mismatch"));
  });

  it("fails closed when the manifest omits generated files", () => {
    const root = fixture();
    writeManifest(root);
    expect(validatePackageContract(root, { requireManifest: true })).toContainEqual(
      expect.stringContaining("file set mismatch"),
    );
  });

  it("rejects a source identity different from the requested commit", () => {
    const root = fixture();
    expect(validatePackageContract(root, { expectedCommit: "b".repeat(40) })).toContainEqual(
      expect.stringContaining("differs from expected"),
    );
  });

  it("rejects a packaged source patch whose bytes no longer match its pin", () => {
    const root = fixture();
    writeFileSync(join(root, "vendor/patches/leptonica-1.87.0-recoverable-oom.patch"), "tampered\n");
    expect(validatePackageContract(root)).toContainEqual(
      expect.stringContaining("source patch metadata is invalid"),
    );
  });

  it("rejects package provenance that diverges from the packaged dependency pins", () => {
    const root = fixture();
    const provenancePath = join(root, "dist/package-provenance.json");
    const provenance = JSON.parse(readFileSync(provenancePath, "utf8"));
    provenance.dependencyPins.leptonica.commit = "d".repeat(40);
    writeFileSync(provenancePath, JSON.stringify(provenance));
    expect(validatePackageContract(root)).toContain(
      "package provenance dependencyPins differ from vendor/versions.json",
    );
  });

  it("rejects duplicate and unsafe manifest paths", () => {
    const root = fixture();
    writeCompleteManifest(root);
    const manifestPath = join(root, "dist/sha256.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.files.push(manifest.files[0], { path: "../outside", bytes: 0, sha256: "0".repeat(64) });
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const errors = validatePackageContract(root, { requireManifest: true });
    expect(errors).toContainEqual(expect.stringContaining("duplicate path"));
    expect(errors).toContainEqual(expect.stringContaining("unsafe path"));
  });

  it("rejects symbolic links in generated package content", () => {
    const root = fixture();
    symlinkSync("leptonica.mjs", join(root, "dist/linked.mjs"));
    expect(validatePackageContract(root)).toContainEqual(expect.stringContaining("must not be a symbolic link"));
  });

  it("detects missing side-effect imports in runtime JavaScript", () => {
    const root = fixture();
    writeFileSync(join(root, "dist/types/index.js"), 'import "./missing.js";\n');
    writeFileSync(join(root, "dist/types/missing.d.ts"), "export {};\n");
    expect(validatePackageContract(root)).toContainEqual(expect.stringContaining("missing relative module ./missing.js"));
  });

  it.each(["dist/leptonica.mjs", "dist/leptonica.d.ts"])(
    "rejects test-only instrumentation leaked into %s",
    (relativePath) => {
      const root = fixture();
      writeFileSync(join(root, relativePath), "export const testAllocationStats = () => ({});\n");
      expect(validatePackageContract(root)).toContainEqual(
        expect.stringContaining(`${relativePath} exposes test-only binding testAllocationStats`),
      );
    },
  );
});

describe("hash manifest generation", () => {
  it("is deterministic, sorted, and excludes its own output", async () => {
    const root = mkdtempSync(join(tmpdir(), "leptonica-hash-manifest-"));
    mkdirSync(join(root, "nested"));
    writeFileSync(join(root, "z.txt"), "z");
    writeFileSync(join(root, "nested/a.txt"), "alpha");
    await generateHashManifest(root);
    const first = readFileSync(join(root, "sha256.json"), "utf8");
    await generateHashManifest(root);
    const second = readFileSync(join(root, "sha256.json"), "utf8");
    expect(second).toBe(first);
    expect(JSON.parse(first)).toMatchObject({
      schemaVersion: 1,
      files: [{ path: "nested/a.txt", bytes: 5 }, { path: "z.txt", bytes: 1 }],
    });
  });

  it("rejects symbolic links instead of hashing their targets", async () => {
    const root = mkdtempSync(join(tmpdir(), "leptonica-hash-manifest-link-"));
    writeFileSync(join(root, "target.txt"), "target");
    symlinkSync("target.txt", join(root, "link.txt"));
    await expect(generateHashManifest(root)).rejects.toThrow("only accepts regular files");
  });
});

describe("fixed-commit consumer identity", () => {
  it("uses the exact pnpm Git dependency identity", () => {
    const commit = "a".repeat(40);
    expect(gitDependencyId("owner/repository", commit)).toBe(
      `leptonica-wasm@https://codeload.github.com/owner/repository/tar.gz/${commit}`,
    );
  });

  it("rejects mutable refs and malformed repositories", () => {
    expect(() => gitDependencyId("owner/repository", "main")).toThrow("invalid Git commit");
    expect(() => gitDependencyId("https://github.com/owner/repository", "a".repeat(40))).toThrow(
      "invalid GitHub repository",
    );
  });
});

describe("independent consumer gate", () => {
  function tarballFixture(consumerRoot: string, tarball: string): any {
    const absoluteLocator = `file:${resolve(tarball).replaceAll("\\", "/")}`;
    const relativeLocator = `file:${relative(consumerRoot, tarball).replaceAll("\\", "/")}`;
    const key = `leptonica-wasm@${relativeLocator}`;
    return {
      lockfileVersion: "9.0",
      importers: {
        ".": { dependencies: { "leptonica-wasm": { specifier: absoluteLocator, version: relativeLocator } } },
      },
      packages: {
        [key]: {
          resolution: {
            integrity: `sha512-${createHash("sha512").update(readFileSync(tarball)).digest("base64")}`,
            tarball: relativeLocator,
          },
        },
      },
      snapshots: { [key]: {} },
    };
  }

  function gitFixture(repository: string, commit: string): any {
    const specifier = `git+https://github.com/${repository}.git#${commit}`;
    const tarball = `https://codeload.github.com/${repository}/tar.gz/${commit}`;
    const key = `leptonica-wasm@${tarball}`;
    return {
      lockfileVersion: "9.0",
      importers: { ".": { dependencies: { "leptonica-wasm": { specifier, version: tarball } } } },
      packages: { [key]: { resolution: { gitHosted: true, tarball } } },
      snapshots: { [key]: {} },
    };
  }

  function renameOnlyKey(section: Record<string, unknown>, suffix: string): void {
    const key = Object.keys(section)[0]!;
    section[key + suffix] = section[key];
    delete section[key];
  }

  function browserBundleFixture(
    prefix: string,
    mainSource: string,
    includeWorkerReference = true,
  ): string {
    const workspace = mkdtempSync(join(tmpdir(), prefix));
    const root = join(workspace, "browser-dist");
    const packageDist = join(workspace, "node_modules/leptonica-wasm/dist");
    mkdirSync(join(root, "full-abi"), { recursive: true });
    mkdirSync(join(packageDist, "full-abi"), { recursive: true });
    writeFileSync(
      join(root, "main.mjs"),
      mainSource + (includeWorkerReference
        ? 'new Worker(new URL("./worker.mjs", import.meta.url));\n'
          + 'new URL("leptonica.wasm", import.meta.url);\n'
        : ""),
    );
    writeFileSync(join(root, "worker.mjs"), 'new URL("leptonica.wasm", import.meta.url);\n');
    writeFileSync(join(root, "full-abi/main.mjs"), 'new URL("leptonica.wasm", import.meta.url);\n');
    writeFileSync(join(root, "leptonica.wasm"), "curated");
    writeFileSync(join(root, "full-abi/leptonica.wasm"), "full ABI");
    writeFileSync(join(packageDist, "leptonica.wasm"), "curated");
    writeFileSync(join(packageDist, "full-abi/leptonica.wasm"), "full ABI");
    return root;
  }

  it("binds all pnpm tarball identities to the exact candidate", () => {
    const root = mkdtempSync(join(tmpdir(), "leptonica-lock-contract-"));
    const consumerRoot = join(root, "consumer");
    const tarball = join(root, "candidate", "leptonica-wasm-0.1.1.tgz");
    mkdirSync(consumerRoot);
    mkdirSync(dirname(tarball));
    writeFileSync(tarball, "fixture");
    const base = tarballFixture(consumerRoot, tarball);
    expect(() => validateConsumerLockfile(stringify(base), { consumerRoot, tarball })).not.toThrow();
    expect(() => validateConsumerLockfile(stringify(base), {
      consumerRoot, tarball, repository: "owner/repository", commit: "a".repeat(40),
    })).toThrow("select exactly one lockfile source");

    const mutations = [
      (value: any) => { value.importers["."].dependencies["leptonica-wasm"].specifier += ".bak"; },
      (value: any) => { value.importers["."].dependencies["leptonica-wasm"].version += "?query"; },
      (value: any) => { renameOnlyKey(value.packages, ".bak"); },
      (value: any) => { (Object.values(value.packages)[0] as any).resolution.tarball += "#fragment"; },
      (value: any) => { (Object.values(value.packages)[0] as any).resolution.integrity = `sha512-${"A".repeat(88)}`; },
      (value: any) => { renameOnlyKey(value.snapshots, ".bak"); },
      (value: any) => {
        const snapshotKey = Object.keys(value.snapshots)[0]!;
        value.snapshots[snapshotKey] = null;
      },
      (value: any) => {
        const packageKey = Object.keys(value.packages)[0]!;
        value.packages[packageKey + "-extra"] = structuredClone(value.packages[packageKey]);
      },
      (value: any) => {
        const snapshotKey = Object.keys(value.snapshots)[0]!;
        value.snapshots[snapshotKey + "-extra"] = {};
      },
    ];
    for (const mutate of mutations) {
      const changed = structuredClone(base);
      mutate(changed);
      expect(() => validateConsumerLockfile(stringify(changed), { consumerRoot, tarball })).toThrow();
    }
    writeFileSync(tarball, "mutated candidate");
    expect(() => validateConsumerLockfile(stringify(base), { consumerRoot, tarball })).toThrow(
      "invalid candidate tarball resolution",
    );
  });

  it("fails closed on extra local locators and deceptive YAML", () => {
    const root = mkdtempSync(join(tmpdir(), "leptonica-lock-adversarial-"));
    const consumerRoot = join(root, "consumer");
    const tarball = join(root, "candidate", "leptonica-wasm-0.1.1.tgz");
    mkdirSync(consumerRoot);
    mkdirSync(dirname(tarball));
    writeFileSync(tarball, "fixture");
    const base = tarballFixture(consumerRoot, tarball);
    for (const locator of ["file:/tmp/evil.tgz", "file:../../evil.tgz", "link:../../evil", "workspace:*"]) {
      const changed = structuredClone(base);
      changed.importers["."].dependencies.evil = { specifier: locator, version: locator };
      expect(() => validateConsumerLockfile(stringify(changed), { consumerRoot, tarball })).toThrow(
        "unexpected local dependency",
      );
    }
    for (const locator of ["file:/tmp/evil.tgz", "link:../../evil", "workspace:*"]) {
      const changed = structuredClone(base);
      changed.packages[`evil@${locator}`] = { resolution: {} };
      expect(() => validateConsumerLockfile(stringify(changed), { consumerRoot, tarball })).toThrow(
        "unexpected local dependency",
      );
    }
    const directoryResolution = structuredClone(base);
    (Object.values(directoryResolution.packages)[0] as any).resolution.directory = "../../src";
    expect(() => validateConsumerLockfile(stringify(directoryResolution), { consumerRoot, tarball })).toThrow(
      "directory resolution",
    );
    const valid = stringify(base);
    const commentSpoof = structuredClone(base);
    commentSpoof.importers["."].dependencies["leptonica-wasm"].specifier = "file:/tmp/evil.tgz";
    expect(() => validateConsumerLockfile(`${stringify(commentSpoof)}\n# file:${tarball}\n`, { consumerRoot, tarball })).toThrow(
      "does not bind the exact candidate tarball",
    );
    expect(() => validateConsumerLockfile(`${valid}\n# file:${tarball}\nlockfileVersion: '9.0'\n`, { consumerRoot, tarball })).toThrow(
      "invalid YAML",
    );
    expect(() => validateConsumerLockfile("lockfileVersion: '9.0'\nimporters: &x {}\npackages: *x\nsnapshots: {}\n", { consumerRoot, tarball })).toThrow(
      "invalid YAML",
    );
    expect(() => validateConsumerLockfile("lockfileVersion: [", { consumerRoot, tarball })).toThrow(
      "invalid YAML",
    );
    expect(() => validateConsumerLockfile("lockfileVersion: !unknown '9.0'", { consumerRoot, tarball })).toThrow(
      "invalid YAML",
    );
    const binaryLocator = valid.replace(
      "      leptonica-wasm:\n",
      "      evil:\n        specifier: !!binary ZmlsZTovdG1wL2V2aWw=\n        version: 1.0.0\n      leptonica-wasm:\n",
    );
    expect(() => validateConsumerLockfile(binaryLocator, { consumerRoot, tarball })).toThrow(
      "invalid YAML",
    );
    expect(() => validateConsumerLockfile(valid.replace("packages:\n", "packages: !!map\n"), { consumerRoot, tarball })).toThrow(
      "invalid YAML",
    );

    const tarballAlias = join(root, "candidate-alias.tgz");
    symlinkSync(tarball, tarballAlias);
    expect(() => validateConsumerLockfile(valid, { consumerRoot, tarball: tarballAlias })).toThrow(
      "regular non-symlink",
    );
  });

  it("binds fixed Git locks to the exact repository and commit", () => {
    const repository = "owner/repository";
    const commit = "a".repeat(40);
    const valid = gitFixture(repository, commit);
    expect(() => validateConsumerLockfile(stringify(valid), { repository, commit })).not.toThrow();

    const mutations = [
      (value: any) => { value.importers["."].dependencies["leptonica-wasm"].specifier = `git+https://github.com/other/repository.git#${commit}`; },
      (value: any) => { value.importers["."].dependencies["leptonica-wasm"].specifier = `git+https://github.com/${repository}.git#${"b".repeat(40)}`; },
      (value: any) => { value.importers["."].dependencies["leptonica-wasm"].version = value.importers["."].dependencies["leptonica-wasm"].version.replace(repository, "other/repository"); },
      (value: any) => { value.importers["."].dependencies["leptonica-wasm"].version = value.importers["."].dependencies["leptonica-wasm"].version.replace(commit, "b".repeat(40)); },
      (value: any) => { renameOnlyKey(value.packages, ".bak"); },
      (value: any) => { (Object.values(value.packages)[0] as any).resolution.tarball = (Object.values(value.packages)[0] as any).resolution.tarball.replace(commit, "b".repeat(40)); },
      (value: any) => { (Object.values(value.packages)[0] as any).resolution.gitHosted = false; },
      (value: any) => { renameOnlyKey(value.snapshots, ".bak"); },
      (value: any) => {
        const packageKey = Object.keys(value.packages)[0]!;
        value.packages[packageKey + "-extra"] = structuredClone(value.packages[packageKey]);
      },
      (value: any) => {
        const snapshotKey = Object.keys(value.snapshots)[0]!;
        value.snapshots[snapshotKey + "-extra"] = {};
      },
    ];
    for (const mutate of mutations) {
      const changed = structuredClone(valid);
      mutate(changed);
      expect(() => validateConsumerLockfile(stringify(changed), { repository, commit })).toThrow();
    }

    const wrongCommit = stringify(gitFixture(repository, "b".repeat(40)));
    expect(() => validateConsumerLockfile(`${wrongCommit}\n# ${commit}\n`, { repository, commit })).toThrow();
  });

  it("keeps installed package roots inside only the independent consumer", () => {
    const root = mkdtempSync(join(tmpdir(), "leptonica-consumer-boundary-"));
    const consumerRoot = join(root, "deep", "consumer");
    const consumerAlias = join(root, "consumer-alias");
    const installedRoot = join(consumerRoot, "node_modules/.pnpm/leptonica-wasm");
    const outsideRoot = join(root, "outside/leptonica-wasm");
    mkdirSync(installedRoot, { recursive: true });
    mkdirSync(outsideRoot, { recursive: true });
    symlinkSync(consumerRoot, consumerAlias, "dir");
    expect(() => validateInstalledPackageRoot(process.cwd(), consumerRoot)).toThrow("worktree");
    expect(() => validateInstalledPackageRoot(join(process.cwd(), "src"), consumerRoot)).toThrow("worktree");
    expect(() => validateInstalledPackageRoot(join(consumerAlias, "node_modules/.pnpm/leptonica-wasm"), consumerAlias)).not.toThrow();
    expect(() => validateInstalledPackageRoot(consumerRoot, consumerRoot)).toThrow("escaped");
    expect(() => validateInstalledPackageRoot(outsideRoot, consumerRoot)).toThrow("escaped");

    const prefixSibling = mkdtempSync(process.cwd() + "-copy-");
    try {
      expect(() => validateInstalledPackageRoot(prefixSibling, dirname(process.cwd()))).not.toThrow();
    } finally {
      rmSync(prefixSibling, { recursive: true, force: true });
    }
  });

  it("accepts a lockfile generated by pnpm 10.34.5 from a real local tarball", () => {
    const root = mkdtempSync(join(tmpdir(), "leptonica-real-lock-"));
    const sourceRoot = join(root, "source");
    const artifactRoot = join(root, "artifact");
    const consumerRoot = join(root, "consumer");
    mkdirSync(sourceRoot);
    mkdirSync(artifactRoot);
    mkdirSync(consumerRoot);
    writeFileSync(join(sourceRoot, "package.json"), JSON.stringify({ name: "leptonica-wasm", version: "0.1.1" }));
    const packed = spawnSync("npm", ["pack", "--ignore-scripts", "--pack-destination", artifactRoot], {
      cwd: sourceRoot, encoding: "utf8",
    });
    expect(packed.status, packed.stderr).toBe(0);
    const tarball = join(artifactRoot, packed.stdout.trim().split(/\r?\n/).at(-1)!);
    writeFileSync(join(consumerRoot, "package.json"), JSON.stringify({
      name: "consumer", private: true, dependencies: { "leptonica-wasm": `file:${tarball}` },
    }));
    const installed = spawnSync("corepack", ["pnpm@10.34.5", "install", "--lockfile-only", "--ignore-scripts"], {
      cwd: consumerRoot, encoding: "utf8",
    });
    expect(installed.status, installed.stderr).toBe(0);
    expect(() => validateConsumerLockfile(readFileSync(join(consumerRoot, "pnpm-lock.yaml"), "utf8"), {
      consumerRoot, tarball,
    })).not.toThrow();
  }, 30_000);

  it("pins its compiler and browser bundler without resolving back to the worktree", () => {
    const root = mkdtempSync(join(tmpdir(), "leptonica-consumer-fixture-"));
    const commit = "a".repeat(40);
    const dependency = gitDependencyId("owner/repository", commit);
    writeConsumer(root, "git+https://github.com/owner/repository.git#" + commit, dependency);

    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    expect(pkg.devDependencies).toEqual(CONSUMER_TOOL_VERSIONS);
    expect(pkg.devDependencies.esbuild).toBe("0.27.7");
    expect(pkg.devDependencies["@types/node"]).toBe("26.4.1");
    expect(readFileSync(join(root, "pnpm-workspace.yaml"), "utf8")).toBe(
      consumerWorkspaceYaml(dependency),
    );
    expect(readFileSync(join(root, "bundle.mjs"), "utf8")).toContain(
      'import.meta.resolve("leptonica-wasm/worker/worker.mjs")',
    );
    expect(readFileSync(join(root, "browser-full-abi.ts"), "utf8")).toContain(
      'from "leptonica-wasm/full-abi/leptonica.mjs"',
    );
  });

  it("accepts the curated WASM URL retained beside the Worker entry", () => {
    const root = browserBundleFixture("leptonica-browser-main-assets-", "");
    expect(() => verifyBrowserBundleLayout(root)).not.toThrow();
  });

  it("fails when an emitted browser URL has no matching packaged asset", () => {
    const root = browserBundleFixture("leptonica-browser-layout-", "");
    rmSync(join(root, "full-abi/leptonica.wasm"));

    expect(() => verifyBrowserBundleLayout(root)).toThrow(
      "full-abi/main.mjs references missing browser asset leptonica.wasm",
    );
    writeFileSync(join(root, "full-abi/leptonica.wasm"), "full ABI");
    expect(() => verifyBrowserBundleLayout(root)).not.toThrow();
  });

  it("rejects a full-ABI browser asset containing the curated WASM bytes", () => {
    const root = browserBundleFixture("leptonica-browser-cross-variant-bytes-", "");
    writeFileSync(join(root, "full-abi/leptonica.wasm"), "curated");
    expect(() => verifyBrowserBundleLayout(root)).toThrow(
      "full-abi/leptonica.wasm differs from installed package asset",
    );
  });

  it.each([
    ["diagnostic package-manager path", 'const diagnostic = "/tmp/consumer/node_modules/leptonica-wasm/dist/worker.mjs";\n'],
    ["diagnostic file URL", 'const diagnostic = "file://build-host/share/worker.mjs";\n'],
    ["dynamic file URL composition", 'const diagnostic = "file:" + runtimePath;\n'],
    ["unknown tagged template", 'tag`file:///tmp/worker.mjs`;\n'],
    ["runtime protocol check", 'const isFileURI = (value) => value.startsWith("file://");\n'],
    ["runtime scheme check", 'const isFileURI = (value) => value.startsWith("file:");\n'],
    ["bare protocol constant", 'const fileProtocol = "file://";\n'],
    ["bare scheme constant", 'const fileProtocol = "file:";\n'],
    ["computed runtime protocol check", 'const isFileURI = (value) => value["startsWith"]("file://");\n'],
    ["regular expression", 'const matcher = /^file:\\/\\/\\//;\n'],
    ["raw tagged template", 'const escaped = String.raw`file\\x3a\\x2f\\x2fbuild-host/share`;\n'],
    [
      "harmless static raw composition",
      'const label = String.raw`${"/node_modules"}-suffix`;\n',
    ],
    ["harmless static concat", 'const label = "prefix".concat("/node_modules", "-suffix");\n'],
  ])("allows unrelated %s content outside a resource URL connection", (_label, source) => {
    const root = browserBundleFixture("leptonica-browser-file-protocol-", source);
    expect(() => verifyBrowserBundleLayout(root)).not.toThrow();
  });

  it("fails closed when a browser bundle is not parseable JavaScript", () => {
    const root = browserBundleFixture("leptonica-browser-invalid-js-", "const broken = ;\n");
    expect(() => verifyBrowserBundleLayout(root)).toThrow("main.mjs is not parseable JavaScript");
  });

  it("does not accept a resource URL that appears only inside a string", () => {
    const root = browserBundleFixture(
      "leptonica-browser-stringified-url-",
      'const fake = \'new URL("./worker.mjs", import.meta.url)\';\n',
      false,
    );
    expect(() => verifyBrowserBundleLayout(root)).toThrow(
      "main.mjs does not retain a resolvable worker.mjs URL",
    );
  });

  it("does not let a disconnected correct URL hide the Worker resource sink", () => {
    const root = browserBundleFixture(
      "leptonica-browser-disconnected-worker-url-",
      'new URL("./worker.mjs", import.meta.url);\n' +
        'new Worker(new URL("./wrong-worker.mjs", import.meta.url));\n',
      false,
    );
    expect(() => verifyBrowserBundleLayout(root)).toThrow(
      "main.mjs references unexpected browser asset ./wrong-worker.mjs",
    );
  });

  it.each([
    [
      "URL",
      'URL = class { constructor() { return "https://evil.invalid/worker.mjs"; } };\n' +
        'new Worker(new URL("./worker.mjs", import.meta.url));\n',
    ],
    [
      "Worker",
      'Worker = class {};\n' +
        'new Worker(new URL("./worker.mjs", import.meta.url));\n',
    ],
  ])("rejects a direct global %s-constructor mutation before the Worker sink", (name, source) => {
    const root = browserBundleFixture(
      `leptonica-browser-mutated-${name.toLowerCase()}-constructor-`,
      source,
      false,
    );
    expect(() => verifyBrowserBundleLayout(root)).toThrow(
      `main.mjs mutates the global ${name} constructor`,
    );
  });

  it("does not evaluate mutable String methods as static resource names", () => {
    const root = browserBundleFixture(
      "leptonica-browser-mutated-string-concat-",
      'String.prototype.concat = () => "./wrong-worker.mjs";\n' +
        'new Worker(new URL(".".concat("/worker.mjs"), import.meta.url));\n',
      false,
    );
    expect(() => verifyBrowserBundleLayout(root)).toThrow(
      "main.mjs contains a non-static browser asset URL",
    );
  });

  it.each([
    ["file URL", "file:///tmp/worker.mjs", "contains a disallowed browser asset URL"],
    ["package-manager path", "./node_modules/leptonica-wasm/worker.mjs", "references unexpected browser asset"],
  ])("rejects an additional %s resource URL beside the correct Worker URL", (_label, reference, classification) => {
    const root = browserBundleFixture(
      "leptonica-browser-extra-resource-url-",
      `new URL(${JSON.stringify(reference)}, import.meta.url);\n`,
    );
    expect(() => verifyBrowserBundleLayout(root)).toThrow(
      `main.mjs ${classification} ${reference}`,
    );
  });

  it("does not accept a resource URL through a shadowed URL constructor", () => {
    const root = browserBundleFixture(
      "leptonica-browser-shadowed-url-",
      'const URL = class {}; new Worker(new URL("./worker.mjs", import.meta.url));\n',
      false,
    );
    expect(() => verifyBrowserBundleLayout(root)).toThrow(
      "main.mjs does not retain a resolvable worker.mjs URL",
    );
  });

  it("does not propagate a resource name through its temporal dead zone", () => {
    const root = browserBundleFixture(
      "leptonica-browser-forward-reference-",
      'new Worker(new URL(asset, import.meta.url)); const asset = "./worker.mjs";\n',
      false,
    );
    expect(() => verifyBrowserBundleLayout(root)).toThrow(
      "main.mjs contains a non-static browser asset URL",
    );
  });

  it("does not treat a class name in its heritage expression as a global URL", () => {
    const root = browserBundleFixture(
      "leptonica-browser-class-tdz-",
      'class URL extends (new URL("./worker.mjs", import.meta.url)).constructor {}\n',
      false,
    );
    expect(() => verifyBrowserBundleLayout(root)).toThrow(
      "main.mjs does not retain a resolvable worker.mjs URL",
    );
  });

  it("does not accept a resource URL through a shadowed self binding", () => {
    const root = browserBundleFixture("leptonica-browser-shadowed-self-", "");
    writeFileSync(
      join(root, "worker.mjs"),
      'const self = { location: { href: import.meta.url } };\n' +
        'new URL("leptonica.wasm", self.location.href);\n',
    );
    expect(() => verifyBrowserBundleLayout(root)).toThrow(
      "worker.mjs does not retain a resolvable leptonica.wasm URL",
    );
  });

  it("accepts leading and trailing ASCII URL whitespace with browser semantics", () => {
    const root = browserBundleFixture(
      "leptonica-browser-ascii-url-whitespace-",
      `new Worker(new URL(${JSON.stringify(" \t./worker.mjs\r\n")}, import.meta.url));\n`
        + 'new URL("leptonica.wasm", import.meta.url);\n',
      false,
    );
    expect(() => verifyBrowserBundleLayout(root)).not.toThrow();
  });

  it.each([
    ["package-manager path", './node_modules/leptonica-wasm/worker.mjs', "references unexpected browser asset"],
    ["file URL", 'file:///tmp/worker.mjs', "contains a disallowed browser asset URL"],
    ["protocol-relative", '//worker.mjs', "contains a disallowed browser asset URL"],
    ["sentinel-origin absolute", 'https://bundle.invalid/worker.mjs', "contains a disallowed browser asset URL"],
    ["sentinel-origin authority", '//bundle.invalid/worker.mjs', "contains a disallowed browser asset URL"],
    ["directory-shaped", './worker.mjs//', "contains a disallowed browser asset URL"],
    ["encoded path separators", 'nested%2F..%2Fworker.mjs', "contains a disallowed browser asset URL"],
    ["encoded backslash separators", 'nested%5C..%5Cworker.mjs', "contains a disallowed browser asset URL"],
    ["leading non-ASCII whitespace", '\u00a0./worker.mjs', "references unexpected browser asset"],
  ])("does not accept a %s resource URL", (_label, reference, classification) => {
    const root = browserBundleFixture(
      "leptonica-browser-invalid-reference-",
      `new Worker(new URL(${JSON.stringify(reference)}, import.meta.url));\n`,
      false,
    );
    expect(() => verifyBrowserBundleLayout(root)).toThrow(
      `main.mjs ${classification} ${reference}`,
    );
  });

  it("does not let the full-ABI entry resolve to the curated WASM sibling", () => {
    const root = browserBundleFixture("leptonica-browser-cross-variant-reference-", "");
    writeFileSync(
      join(root, "full-abi/main.mjs"),
      'new URL("../leptonica.wasm", import.meta.url);\n',
    );
    expect(() => verifyBrowserBundleLayout(root)).toThrow(
      "full-abi/main.mjs references unexpected browser asset ../leptonica.wasm",
    );
  });

  it("repeats both clean-consumer modes in CI and release workflows", () => {
    const ci = readFileSync(".github/workflows/ci.yml", "utf8");
    const release = readFileSync(".github/workflows/release.yml", "utf8");

    expect(ci.match(/--repeat 2/g)).toHaveLength(2);
    expect(release.match(/--repeat 2/g)).toHaveLength(2);
    expect(ci).toContain("timeout-minutes: 60");
    expect(release).toContain("timeout-minutes: 90");
  });

  it("runs the fixed-commit gate against the reviewable PR head", () => {
    const ci = readFileSync(".github/workflows/ci.yml", "utf8");

    expect(ci).toContain("github.event_name == 'pull_request' || (github.event_name == 'push'");
    expect(ci).toContain("github.event.pull_request.head.sha");
    expect(ci).toContain('--commit "$SOURCE_COMMIT"');
    expect(ci).toContain('candidate="tmp/release-candidate/leptonica-wasm-${version}.tgz"');
    expect(ci).toContain('path: ${{ steps.pack_release_candidate.outputs.candidate }}');
    expect(ci.indexOf("name: release-candidate")).toBeLessThan(
      ci.indexOf("- name: Fresh tarball consumer"),
    );
  });

  it("binds a release to package version, current main, and one exact tarball", () => {
    const release = readFileSync(".github/workflows/release.yml", "utf8");

    expect(release).toContain('expected_tag="v${version}"');
    expect(release).toContain('git ls-remote --exit-code origin refs/heads/main');
    expect(release).toContain('test "$head_commit" = "$event_commit"');
    expect(release).toContain('test "$event_commit" = "$tag_commit"');
    expect(release).toContain('test "$tag_commit" = "$main_commit"');
    expect(release).toContain('Verify successful CI for release commit');
    expect(release).toContain('.head_sha == $commit');
    expect(release).toContain('run-id: ${{ steps.verified_main_ci.outputs.run_id }}');
    expect(release).toContain('cmp --silent "$candidate" "$verified_candidate"');
    expect(release).toContain('cmp --silent "$release_asset" "$first_download"');
    expect(release).toContain('cmp --silent "$release_asset" "$rebuilt"');
    expect(release).toContain('echo "commit=$tag_commit" >> "$GITHUB_OUTPUT"');
    expect(release).toContain('LEPTONICA_WASM_SOURCE_COMMIT: ${{ steps.release_identity.outputs.commit }}');
    expect(release).toContain(
      'files: tmp/release-asset/leptonica-wasm-${{ steps.release_identity.outputs.version }}.tgz',
    );
    expect(release).not.toContain('leptonica-wasm-*.tgz');

    const finalDownload = release.lastIndexOf("uses: actions/download-artifact@");
    const freeze = release.indexOf("- name: Freeze verified release asset");
    const revalidate = release.indexOf("- name: Revalidate release target");
    const publish = release.indexOf("- name: Create GitHub Release");
    expect(finalDownload).toBeGreaterThan(release.indexOf("- name: Fresh fixed-commit Git consumer"));
    expect(finalDownload).toBeLessThan(freeze);
    expect(freeze).toBeLessThan(revalidate);
    expect(revalidate).toBeLessThan(publish);
  });
});

describe("consumer install retry policy", () => {
  it("retries transient recursive cleanup races", () => {
    let receivedPath;
    let receivedOptions;
    removeConsumerRoot("/tmp/consumer-root", (path, options) => {
      receivedPath = path;
      receivedOptions = options;
    });

    expect(receivedPath).toBe("/tmp/consumer-root");
    expect(receivedOptions).toEqual({
      recursive: true,
      force: true,
      maxRetries: 8,
      retryDelay: 250,
    });
  });

  it("preserves a successful gate when an owned temporary root stays non-empty", async () => {
    const warnings: string[] = [];
    const root = join(tmpdir(), "leptonica-consumer-1-race");
    const result = await withConsumerRootCleanup(root, () => "verified", {
      remove: () => { throw Object.assign(new Error("directory not empty"), { code: "ENOTEMPTY" }); },
      warn: (message) => { warnings.push(message); },
    });

    expect(result).toBe("verified");
    expect(warnings).toEqual([expect.stringContaining(root)]);
  });

  it.each(["EACCES", "EIO"])(
    "fails a successful gate when cleanup reports %s",
    async (code) => {
      const cleanupError = Object.assign(new Error(`cleanup failed: ${code}`), { code });
      await expect(withConsumerRootCleanup(
        join(tmpdir(), "leptonica-consumer-1-hard-failure"),
        () => "verified",
        { remove: () => { throw cleanupError; } },
      )).rejects.toBe(cleanupError);
    },
  );

  it.each(["ENOTEMPTY", "EACCES"])(
    "preserves the gate failure when cleanup also reports %s",
    async (code) => {
      const gateError = new Error("consumer verification failed");
      const warnings: string[] = [];
      await expect(withConsumerRootCleanup(
        join(tmpdir(), "leptonica-consumer-1-primary-failure"),
        () => { throw gateError; },
        {
          remove: () => { throw Object.assign(new Error(`cleanup failed: ${code}`), { code }); },
          warn: (message) => { warnings.push(message); },
        },
      )).rejects.toBe(gateError);
      expect(warnings).toEqual([expect.stringContaining(`cleanup failed: ${code}`)]);
    },
  );

  it("does not trust an ENOTEMPTY-looking message without that error code", async () => {
    const cleanupError = Object.assign(new Error("ENOTEMPTY: directory not empty"), { code: "EIO" });
    await expect(withConsumerRootCleanup(
      join(tmpdir(), "leptonica-consumer-1-wrong-code"),
      () => "verified",
      { remove: () => { throw cleanupError; } },
    )).rejects.toBe(cleanupError);
  });

  it("does not tolerate ENOTEMPTY outside an owned consumer root", async () => {
    const cleanupError = Object.assign(new Error("directory not empty"), { code: "ENOTEMPTY" });
    await expect(withConsumerRootCleanup(
      join(tmpdir(), "unrelated-root"),
      () => "verified",
      { remove: () => { throw cleanupError; } },
    )).rejects.toBe(cleanupError);
  });

  it("continues later isolated attempts after a tolerated cleanup race", async () => {
    const executed: number[] = [];
    const warnings: string[] = [];
    for (const attempt of [1, 2]) {
      await withConsumerRootCleanup(
        join(tmpdir(), `leptonica-consumer-${attempt}-race`),
        () => { executed.push(attempt); },
        {
          remove: () => { throw Object.assign(new Error("directory not empty"), { code: "ENOTEMPTY" }); },
          warn: (message) => { warnings.push(message); },
        },
      );
    }

    expect(executed).toEqual([1, 2]);
    expect(warnings).toHaveLength(2);
  });

  it.each([
    "stream disconnected while receiving package metadata",
    "ERR_PNPM_FETCH_429 GET https://registry.example/package: Too Many Requests",
    "HTTP 500 Internal Server Error",
    "HTTP/1.1 502 Bad Gateway",
    "status code: 503 Service Unavailable",
    "ERR_PNPM_FETCH_504 request timed out",
  ])("classifies %s as retryable", (message) => {
    expect(isRetryableNetworkError(new Error(message))).toBe(true);
  });

  it("reads retryable failures from nested causes and rejects non-transient 5xx", () => {
    expect(isRetryableNetworkError(new Error("install failed", { cause: new Error("HTTP 503") }))).toBe(true);
    expect(isRetryableNetworkError(new Error("HTTP 501 Not Implemented"))).toBe(false);
  });

  it("keeps retrying transient failures with capped exponential backoff", async () => {
    const delays: number[] = [];
    const attempts: number[] = [];
    const result = await retryWithBackoff(
      (attempt) => {
        attempts.push(attempt);
        if (attempt <= 5) throw new Error(attempt % 2 === 0 ? "HTTP 429" : "stream disconnected");
        return "installed";
      },
      {
        initialDelayMs: 10,
        maximumDelayMs: 40,
        sleep: (milliseconds) => { delays.push(milliseconds); },
      },
    );
    expect(result).toBe("installed");
    expect(attempts).toEqual([1, 2, 3, 4, 5, 6]);
    expect(delays).toEqual([10, 20, 40, 40, 40]);
  });

  it("honors Retry-After even when it exceeds the backoff cap", async () => {
    const now = Date.parse("2026-09-06T12:00:00Z");
    expect(retryAfterMilliseconds(new Error("HTTP 429\nRetry-After: 75"), now)).toBe(75_000);
    expect(retryAfterMilliseconds(new Error("HTTP 503\nRetry-After: Sun, 06 Sep 2026 12:02:00 GMT"), now)).toBe(120_000);

    const delays: number[] = [];
    let attempts = 0;
    await retryWithBackoff(
      () => {
        attempts += 1;
        if (attempts === 1) throw new Error("HTTP 429\nRetry-After: 75");
      },
      {
        initialDelayMs: 10,
        maximumDelayMs: 40,
        now: () => now,
        sleep: (milliseconds) => { delays.push(milliseconds); },
      },
    );
    expect(delays).toEqual([75_000]);
  });

  it("does not retry deterministic command failures", async () => {
    let attempts = 0;
    await expect(retryWithBackoff(
      () => {
        attempts += 1;
        throw new Error("TypeScript compilation failed");
      },
      { sleep: () => { throw new Error("sleep must not run"); } },
    )).rejects.toThrow("TypeScript compilation failed");
    expect(attempts).toBe(1);
  });
});
