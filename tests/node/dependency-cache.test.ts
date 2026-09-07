import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertEnvironmentVariablesUnset,
  commandPath,
  compilerProgramPath,
  dependencyBuildIdentitySha256,
  dependencySourceSetSha256,
  readDependencyBuildCache,
  withDependencyBuildLock,
  writeDependencyBuildCache,
} from "../../scripts/dependency-cache.mjs";

describe("dependency build cache", () => {
  it("resolves the compiler-selected archiver to the exact executable used by CMake", () => {
    const root = mkdtempSync(join(tmpdir(), "leptonica-compiler-program-"));
    try {
      const binDir = join(root, "bin");
      const compiler = join(binDir, "fixture-cc");
      const archiverDriver = join(binDir, "fixture-driver");
      const archiver = join(binDir, "fixture-ar");
      mkdirSync(binDir);
      writeFileSync(compiler, [
        "#!/bin/sh",
        "test \"$1\" = \"-print-prog-name=ar\" || exit 2",
        "printf \"fixture-ar\\n\"",
      ].join("\n"));
      writeFileSync(archiverDriver, "#!/bin/sh\nprintf 'fixture ar 1\n'\n");
      chmodSync(compiler, 0o755);
      chmodSync(archiverDriver, 0o755);
      symlinkSync("fixture-driver", archiver);

      expect(compilerProgramPath(compiler, "ar", {
        cwd: root,
        environment: { ...process.env, PATH: binDir },
      })).toBe(archiver);

      const currentDirectoryArchiver = join(root, "fixture-ar");
      writeFileSync(currentDirectoryArchiver, "#!/bin/sh\nprintf 'cwd fixture ar 1\n'\n");
      chmodSync(currentDirectoryArchiver, 0o755);
      expect(compilerProgramPath(compiler, "ar", {
        cwd: root,
        environment: { ...process.env, PATH: `${delimiter}${binDir}` },
      })).toBe(realpathSync(currentDirectoryArchiver));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("resolves relative PATH entries against one cwd before compiler and CMake use", () => {
    const root = mkdtempSync(join(tmpdir(), "leptonica-command-path-"));
    try {
      const first = join(root, "first");
      const second = join(root, "second");
      mkdirSync(first);
      mkdirSync(second);
      for (const directory of [first, second]) {
        const compiler = join(directory, "fixture-cc");
        writeFileSync(compiler, "#!/bin/sh\nprintf 'fixture cc 1\n'\n");
        chmodSync(compiler, 0o755);
      }

      expect(commandPath("fixture-cc", {
        cwd: first,
        environment: { ...process.env, PATH: "." },
      })).toBe(join(first, "fixture-cc"));
      expect(commandPath("fixture-cc", {
        cwd: second,
        environment: { ...process.env, PATH: "." },
      })).toBe(join(second, "fixture-cc"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

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

  it("accepts a schema-1 marker written with the historical regular-file digest", () => {
    const root = mkdtempSync(join(tmpdir(), "leptonica-dependency-cache-schema-1-"));
    try {
      const installRoot = join(root, "install");
      const marker = join(root, ".done.json");
      const buildIdentitySha256 = dependencyBuildIdentitySha256({ fixture: "schema-1" });
      mkdirSync(join(installRoot, "bin"), { recursive: true });
      writeFileSync(join(installRoot, "bin/tool"), "regular bytes\n");
      chmodSync(join(installRoot, "bin/tool"), 0o755);
      writeFileSync(join(installRoot, "README"), "regular bytes\n");
      chmodSync(join(installRoot, "README"), 0o644);
      const installTreeSha256 = "73827e41a417402e7478299fa8a73347d96bf25697190e9e1efaf3fbbf055c54";
      writeFileSync(marker, JSON.stringify({
        schemaVersion: 1,
        buildIdentitySha256,
        installTreeSha256,
      }) + "\n");

      expect(readDependencyBuildCache({
        marker,
        installRoot,
        buildIdentitySha256,
        label: "fixture dependency",
      })).toEqual({ buildIdentitySha256, installTreeSha256 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("accepts internal install links when only an ancestor of the root is a symbolic link", () => {
    const root = mkdtempSync(join(tmpdir(), "leptonica-dependency-cache-ancestor-link-"));
    try {
      const realParent = join(root, "real-parent");
      const aliasParent = join(root, "alias-parent");
      const installRoot = join(aliasParent, "install");
      const marker = join(root, ".done.json");
      const buildIdentitySha256 = dependencyBuildIdentitySha256({ fixture: "ancestor-link" });
      mkdirSync(join(realParent, "install/bin"), { recursive: true });
      writeFileSync(join(realParent, "install/bin/tool-real"), "tool\n");
      symlinkSync("tool-real", join(realParent, "install/bin/tool"));
      symlinkSync("real-parent", aliasParent);

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
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("hashes safe internal install symlinks and rejects unsafe targets", () => {
    const root = mkdtempSync(join(tmpdir(), "leptonica-dependency-cache-links-"));
    try {
      const installRoot = join(root, "install");
      const binDir = join(installRoot, "bin");
      const marker = join(root, ".done.json");
      const link = join(binDir, "libpng-config");
      const outside = join(root, "outside-config");
      const buildIdentitySha256 = dependencyBuildIdentitySha256({ fixture: "links" });
      mkdirSync(binDir, { recursive: true });
      writeFileSync(join(binDir, "libpng16-config"), "same bytes\n");
      writeFileSync(join(binDir, "alternate-config"), "same bytes\n");
      writeFileSync(outside, "outside\n");
      symlinkSync("libpng16-config", link);

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

      rmSync(link);
      symlinkSync("./libpng16-config", link);
      expect(() => readDependencyBuildCache({
        marker,
        installRoot,
        buildIdentitySha256,
        label: "fixture dependency",
      })).toThrow("install tree sha256 mismatch");

      rmSync(link);
      symlinkSync("libpng16-config", link);
      writeDependencyBuildCache({
        marker,
        installRoot,
        buildIdentitySha256,
        label: "fixture dependency",
      });
      writeFileSync(join(binDir, "libpng16-config"), "changed target bytes\n");
      expect(() => readDependencyBuildCache({
        marker,
        installRoot,
        buildIdentitySha256,
        label: "fixture dependency",
      })).toThrow("install tree sha256 mismatch");
      writeFileSync(join(binDir, "libpng16-config"), "same bytes\n");
      writeDependencyBuildCache({
        marker,
        installRoot,
        buildIdentitySha256,
        label: "fixture dependency",
      });

      rmSync(link);
      writeFileSync(link, "same bytes\n");
      expect(() => readDependencyBuildCache({
        marker,
        installRoot,
        buildIdentitySha256,
        label: "fixture dependency",
      })).toThrow("install tree sha256 mismatch");

      rmSync(link);
      symlinkSync("alternate-config", link);
      expect(() => readDependencyBuildCache({
        marker,
        installRoot,
        buildIdentitySha256,
        label: "fixture dependency",
      })).toThrow("install tree sha256 mismatch");

      rmSync(link);
      symlinkSync("../../outside-config", link);
      expect(() => writeDependencyBuildCache({
        marker,
        installRoot,
        buildIdentitySha256,
        label: "fixture dependency",
      })).toThrow("install tree symbolic link escapes its root");
      expect(() => readDependencyBuildCache({
        marker,
        installRoot,
        buildIdentitySha256,
        label: "fixture dependency",
      })).toThrow("install tree symbolic link escapes its root");

      rmSync(link);
      symlinkSync(outside, link);
      expect(() => readDependencyBuildCache({
        marker,
        installRoot,
        buildIdentitySha256,
        label: "fixture dependency",
      })).toThrow("install tree contains an absolute symbolic link");

      rmSync(link);
      symlinkSync("\\\\server\\share\\config", link);
      expect(() => readDependencyBuildCache({
        marker,
        installRoot,
        buildIdentitySha256,
        label: "fixture dependency",
      })).toThrow("install tree contains an absolute symbolic link");

      rmSync(link);
      symlinkSync("missing-config", link);
      expect(() => readDependencyBuildCache({
        marker,
        installRoot,
        buildIdentitySha256,
        label: "fixture dependency",
      })).toThrow("install tree symbolic link target is missing");

      rmSync(link);
      symlinkSync("../../install/bin/libpng16-config", link);
      expect(() => readDependencyBuildCache({
        marker,
        installRoot,
        buildIdentitySha256,
        label: "fixture dependency",
      })).toThrow("install tree symbolic link escapes its root");

      rmSync(link);
      mkdirSync(join(binDir, "config-dir"));
      symlinkSync("config-dir", link);
      expect(() => readDependencyBuildCache({
        marker,
        installRoot,
        buildIdentitySha256,
        label: "fixture dependency",
      })).toThrow("install tree symbolic link target is not a regular file");

      rmSync(link);
      symlinkSync("loop", link);
      symlinkSync("libpng-config", join(binDir, "loop"));
      expect(() => readDependencyBuildCache({
        marker,
        installRoot,
        buildIdentitySha256,
        label: "fixture dependency",
      })).toThrow("install tree contains a symbolic link loop");
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
