import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EXPECTED_EXPORTS, validatePackageContract } from "../../scripts/check-package-contract.mjs";
import { generateHashManifest } from "../../scripts/gen-hash-manifest.mjs";
import {
  CONSUMER_TOOL_VERSIONS,
  consumerWorkspaceYaml,
  gitDependencyId,
  isRetryableNetworkError,
  retryAfterMilliseconds,
  retryWithBackoff,
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
      `leptonica-wasm@git+https://github.com/owner/repository.git#${commit}`,
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

  it("fails when an emitted browser URL has no matching packaged asset", () => {
    const root = mkdtempSync(join(tmpdir(), "leptonica-browser-layout-"));
    mkdirSync(join(root, "full-abi"), { recursive: true });
    writeFileSync(join(root, "main.mjs"), 'new Worker(new URL("./worker.mjs", import.meta.url));\n');
    writeFileSync(join(root, "worker.mjs"), 'new URL("leptonica.wasm", import.meta.url);\n');
    writeFileSync(join(root, "full-abi/main.mjs"), 'new URL("leptonica.wasm", import.meta.url);\n');
    writeFileSync(join(root, "leptonica.wasm"), "curated");

    expect(() => verifyBrowserBundleLayout(root)).toThrow(
      "full-abi/main.mjs references missing browser asset leptonica.wasm",
    );
    writeFileSync(join(root, "full-abi/leptonica.wasm"), "full ABI");
    expect(() => verifyBrowserBundleLayout(root)).not.toThrow();
  });

  it("rejects package-manager paths embedded in browser bundle contents", () => {
    const root = mkdtempSync(join(tmpdir(), "leptonica-browser-path-leak-"));
    mkdirSync(join(root, "full-abi"), { recursive: true });
    writeFileSync(
      join(root, "main.mjs"),
      'const leaked = "file:///tmp/consumer/node_modules/leptonica-wasm/dist/worker.mjs";\n' +
        'new Worker(new URL("./worker.mjs", import.meta.url));\n',
    );
    writeFileSync(join(root, "worker.mjs"), 'new URL("leptonica.wasm", import.meta.url);\n');
    writeFileSync(join(root, "full-abi/main.mjs"), 'new URL("leptonica.wasm", import.meta.url);\n');
    writeFileSync(join(root, "leptonica.wasm"), "curated");
    writeFileSync(join(root, "full-abi/leptonica.wasm"), "full ABI");

    expect(() => verifyBrowserBundleLayout(root)).toThrow(
      "main.mjs leaked a package-manager path",
    );
  });

  it("rejects non-localhost file URLs embedded in browser bundles", () => {
    const root = mkdtempSync(join(tmpdir(), "leptonica-browser-file-url-leak-"));
    mkdirSync(join(root, "full-abi"), { recursive: true });
    writeFileSync(
      join(root, "main.mjs"),
      'const leaked = "file://build-host/share/worker.mjs";\n' +
        'new Worker(new URL("./worker.mjs", import.meta.url));\n',
    );
    writeFileSync(join(root, "worker.mjs"), 'new URL("leptonica.wasm", import.meta.url);\n');
    writeFileSync(join(root, "full-abi/main.mjs"), 'new URL("leptonica.wasm", import.meta.url);\n');
    writeFileSync(join(root, "leptonica.wasm"), "curated");
    writeFileSync(join(root, "full-abi/leptonica.wasm"), "full ABI");

    expect(() => verifyBrowserBundleLayout(root)).toThrow(
      "main.mjs leaked a package-manager path",
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
});

describe("consumer install retry policy", () => {
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
