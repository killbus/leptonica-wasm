import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertEnvironmentVariablesUnset,
  dependencyBuildIdentitySha256,
  dependencySourceSetSha256,
  readDependencyBuildCache,
  withDependencyBuildLock,
  writeDependencyBuildCache,
} from "../../scripts/dependency-cache.mjs";

describe("dependency build cache", () => {
  it("fails closed for unsupported build-environment injection", () => {
    expect(() => assertEnvironmentVariablesUnset(
      { CMAKE_TOOLCHAIN_FILE: "/tmp/injected.cmake" },
      ["CMAKE_TOOLCHAIN_FILE"],
      "native dependency build",
    )).toThrow("does not accept environment overrides: CMAKE_TOOLCHAIN_FILE");
    expect(() => assertEnvironmentVariablesUnset(
      {},
      ["CMAKE_TOOLCHAIN_FILE"],
      "native dependency build",
    )).not.toThrow();
  });

  it("binds the source set and build identity to every dependency input", () => {
    const names = ["zlib", "libpng"];
    const first = new Map([
      ["zlib", { sourceIdentitySha256: "1".repeat(64) }],
      ["libpng", { sourceIdentitySha256: "2".repeat(64) }],
    ]);
    const changed = new Map(first);
    changed.set("zlib", { sourceIdentitySha256: "3".repeat(64) });

    expect(dependencySourceSetSha256(names, first)).not.toBe(
      dependencySourceSetSha256(names, changed),
    );

    const base = {
      schemaVersion: 1,
      toolchain: {
        compilerVersion: "compiler 1",
        pinned: {
          toolchainArchives: [{ sha256: "a".repeat(64) }],
        },
      },
      dependencies: [{
        name: "zlib",
        sourceIdentitySha256: "1".repeat(64),
        configure: ["-DZLIB_BUILD_SHARED=OFF"],
      }],
    };
    expect(dependencyBuildIdentitySha256(base)).not.toBe(
      dependencyBuildIdentitySha256({
        ...base,
        dependencies: [{
          ...base.dependencies[0],
          configure: ["-DZLIB_BUILD_SHARED=ON"],
        }],
      }),
    );
    expect(dependencyBuildIdentitySha256(base)).not.toBe(
      dependencyBuildIdentitySha256({
        ...base,
        toolchain: { ...base.toolchain, compilerVersion: "compiler 2" },
      }),
    );
    expect(dependencyBuildIdentitySha256(base)).not.toBe(
      dependencyBuildIdentitySha256({
        ...base,
        toolchain: {
          ...base.toolchain,
          pinned: {
            toolchainArchives: [{ sha256: "b".repeat(64) }],
          },
        },
      }),
    );
  });

  it("verifies the complete install tree before accepting a cache hit", () => {
    const root = mkdtempSync(join(tmpdir(), "leptonica-dependency-cache-"));
    try {
      const installRoot = join(root, "install");
      const marker = join(root, ".done.json");
      const buildIdentitySha256 = dependencyBuildIdentitySha256({ fixture: true });
      mkdirSync(join(installRoot, "lib"), { recursive: true });
      writeFileSync(join(installRoot, "lib/library.a"), "verified bytes\n");

      const written = writeDependencyBuildCache({
        marker,
        installRoot,
        buildIdentitySha256,
        label: "fixture dependency",
      });
      expect(readDependencyBuildCache({
        marker,
        installRoot,
        buildIdentitySha256,
        label: "fixture dependency",
      })).toEqual(written);

      writeFileSync(join(installRoot, ".source-identity.json"), "unexpected install file\n");
      expect(() => readDependencyBuildCache({
        marker,
        installRoot,
        buildIdentitySha256,
        label: "fixture dependency",
      })).toThrow("install tree sha256 mismatch");
      rmSync(join(installRoot, ".source-identity.json"));

      writeFileSync(join(installRoot, "lib/library.a"), "tampered bytes\n");
      expect(() => readDependencyBuildCache({
        marker,
        installRoot,
        buildIdentitySha256,
        label: "fixture dependency",
      })).toThrow("install tree sha256 mismatch");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a symlinked build marker without writing through it", () => {
    const root = mkdtempSync(join(tmpdir(), "leptonica-dependency-marker-link-"));
    try {
      const installRoot = join(root, "install");
      const marker = join(root, ".done.json");
      const sentinel = join(root, "sentinel.txt");
      const buildIdentitySha256 = dependencyBuildIdentitySha256({ fixture: true });
      mkdirSync(installRoot);
      writeFileSync(sentinel, "sentinel\n");
      symlinkSync(sentinel, marker);

      expect(() => readDependencyBuildCache({
        marker,
        installRoot,
        buildIdentitySha256,
        label: "fixture dependency",
      })).toThrow("build marker is not a regular file");
      expect(readFileSync(sentinel, "utf8")).toBe("sentinel\n");

      writeFileSync(join(installRoot, "library.a"), "verified bytes\n");
      writeDependencyBuildCache({
        marker,
        installRoot,
        buildIdentitySha256,
        label: "fixture dependency",
      });
      expect(lstatSync(marker).isFile()).toBe(true);
      expect(readFileSync(sentinel, "utf8")).toBe("sentinel\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects an install root that is itself a symbolic link", () => {
    const root = mkdtempSync(join(tmpdir(), "leptonica-dependency-install-link-"));
    try {
      const realInstallRoot = join(root, "real-install");
      const installRoot = join(root, "install");
      const marker = join(root, ".done.json");
      const buildIdentitySha256 = dependencyBuildIdentitySha256({ fixture: true });
      mkdirSync(realInstallRoot);
      writeFileSync(join(realInstallRoot, "library.a"), "verified bytes\n");
      writeDependencyBuildCache({
        marker,
        installRoot: realInstallRoot,
        buildIdentitySha256,
        label: "fixture dependency",
      });
      symlinkSync(realInstallRoot, installRoot);

      expect(() => readDependencyBuildCache({
        marker,
        installRoot,
        buildIdentitySha256,
        label: "fixture dependency",
      })).toThrow("tree root is a symbolic link");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("serializes writers, fails closed on stale locks, and releases only its own lock", () => {
    const root = mkdtempSync(join(tmpdir(), "leptonica-dependency-lock-"));
    const lock = join(root, "build.lock");
    try {
      mkdirSync(lock);
      writeFileSync(join(lock, "owner.json"), JSON.stringify({
        schemaVersion: 1,
        hostname: "different-runner",
        pid: 999999,
      }) + "\n");
      expect(() => withDependencyBuildLock({
        lock,
        label: "fixture dependency",
        timeoutMs: 5,
        pollMs: 1,
      }, () => "must not enter")).toThrow("build lock timed out");
      expect(lstatSync(lock).isDirectory()).toBe(true);
      rmSync(lock, { recursive: true });

      expect(() => withDependencyBuildLock({
        lock,
        label: "fixture dependency",
      }, () => {
        throw new Error("build failed");
      })).toThrow("build failed");
      expect(lstatSync(lock, { throwIfNoEntry: false })).toBeUndefined();

      expect(() => withDependencyBuildLock({
        lock,
        label: "fixture dependency",
      }, () => {
        writeFileSync(join(lock, "owner.json"), JSON.stringify({
          schemaVersion: 1,
          ownerToken: "replacement-owner",
        }) + "\n");
      })).toThrow("build lock ownership changed before release");
      expect(lstatSync(lock).isDirectory()).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
