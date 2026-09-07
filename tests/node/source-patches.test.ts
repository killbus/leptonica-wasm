import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  applySourcePatches,
  prepareSourceTree,
  prepareSourceTreeFromArchive,
  publishVerifiedFile,
  resolveSourcePatchSet,
  sourceMarkerText,
  sourceProvenance,
  sourceTreeSha256,
  verifySourceTree,
} from "../../scripts/source-patches.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const versions = JSON.parse(readFileSync(join(repoRoot, "vendor/versions.json"), "utf8"));
const leptonicaPin = versions.leptonica;
const patchPath = join(repoRoot, leptonicaPin.patches[0].file);

function sha256(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function fixturePin(
  file: string,
  digest: string,
  sourceTreeDigest = "1".repeat(64),
  patchedSourceTreeDigest = "2".repeat(64),
) {
  const commit = "a".repeat(40);
  return {
    commit,
    sourceTreeSha256: sourceTreeDigest,
    patchedSourceTreeSha256: patchedSourceTreeDigest,
    patches: [{ file, appliesToCommit: commit, sha256: digest }],
  };
}

function oneLinePatch(replacement: string): string {
  return [
    "diff --git a/input.txt b/input.txt",
    "--- a/input.txt",
    "+++ b/input.txt",
    "@@ -1 +1 @@",
    "-before",
    `+${replacement}`,
    "",
  ].join("\n");
}

describe("pinned source patch supply chain", () => {
  it("binds the checked-in patch to the pinned Leptonica commit and content hash", () => {
    const source = resolveSourcePatchSet("leptonica", leptonicaPin, repoRoot);
    expect(source.commit).toBe("13275a278eb55b5746e33f95fbf5a2c8f604b3ab");
    expect(source.patches).toHaveLength(1);
    expect(source.patches[0]!.sha256).toBe(sha256(readFileSync(patchPath)));
    expect(source.patchSetSha256).toMatch(/^[0-9a-f]{64}$/);

    const marker = JSON.parse(sourceMarkerText(source));
    expect(marker).toMatchObject({
      schemaVersion: 2,
      commit: source.commit,
      sourceTreeSha256: leptonicaPin.sourceTreeSha256,
      patchedSourceTreeSha256: leptonicaPin.patchedSourceTreeSha256,
      sourceIdentitySha256: source.sourceIdentitySha256,
      patchSetSha256: source.patchSetSha256,
      patches: [{ file: leptonicaPin.patches[0].file, sha256: leptonicaPin.patches[0].sha256 }],
    });
    expect(sourceProvenance(source)).toEqual({
      commit: source.commit,
      sourceTreeSha256: source.sourceTreeSha256,
      patchedSourceTreeSha256: source.patchedSourceTreeSha256,
      sourceIdentitySha256: source.sourceIdentitySha256,
      patchSetSha256: source.patchSetSha256,
      patches: marker.patches,
    });
  });

  it("fails closed for a wrong hash or target commit", () => {
    const patch = leptonicaPin.patches[0];
    expect(() => resolveSourcePatchSet("leptonica", {
      ...leptonicaPin,
      patches: [{ ...patch, sha256: "0".repeat(64) }],
    }, repoRoot)).toThrow("sha256 mismatch");
    expect(() => resolveSourcePatchSet("leptonica", {
      ...leptonicaPin,
      patches: [{ ...patch, appliesToCommit: "b".repeat(40) }],
    }, repoRoot)).toThrow("applies to");
    expect(() => resolveSourcePatchSet("leptonica", {
      ...leptonicaPin,
      sourceTreeSha256: undefined,
    }, repoRoot)).toThrow("sourceTreeSha256");
    expect(() => resolveSourcePatchSet("leptonica", {
      ...leptonicaPin,
      patchedSourceTreeSha256: undefined,
    }, repoRoot)).toThrow("patchedSourceTreeSha256");
  });

  it("rejects unsafe, duplicate, and symlinked patch paths", () => {
    expect(() => resolveSourcePatchSet("leptonica", fixturePin(
      "vendor/patches/../escape.patch",
      "0".repeat(64),
    ), repoRoot)).toThrow("unsafe source patch path");

    const duplicate = fixturePin(leptonicaPin.patches[0].file, leptonicaPin.patches[0].sha256);
    duplicate.patches.push({ ...duplicate.patches[0]! });
    expect(() => resolveSourcePatchSet("leptonica", duplicate, repoRoot)).toThrow("duplicated");

    const fileLinkRoot = mkdtempSync(join(tmpdir(), "leptonica-source-patch-file-link-"));
    try {
      mkdirSync(join(fileLinkRoot, "vendor/patches"), { recursive: true });
      writeFileSync(join(fileLinkRoot, "target.patch"), "patch\n");
      symlinkSync(join(fileLinkRoot, "target.patch"), join(fileLinkRoot, "vendor/patches/link.patch"));
      expect(() => resolveSourcePatchSet(
        "leptonica",
        fixturePin("vendor/patches/link.patch", sha256("patch\n")),
        fileLinkRoot,
      )).toThrow("symbolic link");
    } finally {
      rmSync(fileLinkRoot, { recursive: true, force: true });
    }

    const directoryLinkRoot = mkdtempSync(join(tmpdir(), "leptonica-source-patch-directory-link-"));
    try {
      mkdirSync(join(directoryLinkRoot, "vendor"), { recursive: true });
      mkdirSync(join(directoryLinkRoot, "real-patches"), { recursive: true });
      writeFileSync(join(directoryLinkRoot, "real-patches/linked.patch"), "patch\n");
      symlinkSync(join(directoryLinkRoot, "real-patches"), join(directoryLinkRoot, "vendor/patches"));
      expect(() => resolveSourcePatchSet(
        "leptonica",
        fixturePin("vendor/patches/linked.patch", sha256("patch\n")),
        directoryLinkRoot,
      )).toThrow("symbolic link");
    } finally {
      rmSync(directoryLinkRoot, { recursive: true, force: true });
    }
  });

  it("keeps the canonical patch at the agreed general-purpose boundary", () => {
    const patch = readFileSync(patchPath, "utf8");
    for (const file of [
      "boxbasic.c",
      "fpix1.c",
      "numabasic.c",
      "pixabasic.c",
      "pixtiling.c",
      "sarray1.c",
      "sel1.c",
      "stack.c",
    ]) {
      expect(patch).toContain("diff --git a/src/" + file + " b/src/" + file);
    }
    for (const deferred of ["binarize.c", "colorcontent.c", "conncomp.c", "pixafunc1.c"]) {
      expect(patch).not.toContain("a/src/" + deferred);
    }
    expect(patch).toContain("return boxaAddBox(pixa->boxa, box, copyflag);");
  });

  it("executes a checked patch and rejects whitespace errors before mutation", () => {
    const validRoot = mkdtempSync(join(tmpdir(), "leptonica-source-patch-apply-"));
    try {
      const sourceDir = join(validRoot, "source");
      const patchFile = "vendor/patches/change.patch";
      mkdirSync(sourceDir, { recursive: true });
      mkdirSync(join(validRoot, "vendor/patches"), { recursive: true });
      writeFileSync(join(sourceDir, "input.txt"), "before\n");
      const expectedDir = join(validRoot, "expected");
      mkdirSync(expectedDir);
      writeFileSync(join(expectedDir, "input.txt"), "after\n");
      writeFileSync(join(validRoot, patchFile), oneLinePatch("after"));
      const source = resolveSourcePatchSet(
        "fixture",
        fixturePin(
          patchFile,
          sha256(oneLinePatch("after")),
          sourceTreeSha256(sourceDir),
          sourceTreeSha256(expectedDir),
        ),
        validRoot,
      );

      verifySourceTree(source, sourceDir, "upstream");
      applySourcePatches(source, sourceDir);
      verifySourceTree(source, sourceDir, "patched");

      expect(readFileSync(join(sourceDir, "input.txt"), "utf8")).toBe("after\n");
      writeFileSync(join(sourceDir, "input.txt"), "tampered\n");
      expect(() => verifySourceTree(source, sourceDir, "patched")).toThrow("source tree sha256 mismatch");
    } finally {
      rmSync(validRoot, { recursive: true, force: true });
    }

    const invalidRoot = mkdtempSync(join(tmpdir(), "leptonica-source-patch-whitespace-"));
    try {
      const sourceDir = join(invalidRoot, "source");
      const patchFile = "vendor/patches/change.patch";
      const invalidPatch = oneLinePatch("after ");
      mkdirSync(sourceDir, { recursive: true });
      mkdirSync(join(invalidRoot, "vendor/patches"), { recursive: true });
      writeFileSync(join(sourceDir, "input.txt"), "before\n");
      writeFileSync(join(invalidRoot, patchFile), invalidPatch);
      const source = resolveSourcePatchSet(
        "fixture",
        fixturePin(patchFile, sha256(invalidPatch), sourceTreeSha256(sourceDir)),
        invalidRoot,
      );

      expect(() => applySourcePatches(source, sourceDir)).toThrow("failed for vendor/patches/change.patch");
      expect(readFileSync(join(sourceDir, "input.txt"), "utf8")).toBe("before\n");
    } finally {
      rmSync(invalidRoot, { recursive: true, force: true });
    }
  });

  it("does not invoke git for an empty patch set", () => {
    const root = mkdtempSync(join(tmpdir(), "leptonica-source-no-patches-"));
    try {
      const sourceDir = join(root, "source");
      mkdirSync(sourceDir);
      writeFileSync(join(sourceDir, "CMakeLists.txt"), "project(fixture)\n");
      const source = resolveSourcePatchSet("fixture", {
        commit: "a".repeat(40),
        sourceTreeSha256: sourceTreeSha256(sourceDir),
        patches: [],
      }, root);
      const originalPath = process.env.PATH;
      process.env.PATH = "";
      try {
        expect(() => applySourcePatches(source, sourceDir)).not.toThrow();
      } finally {
        if (originalPath === undefined) delete process.env.PATH;
        else process.env.PATH = originalPath;
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("applies patches when the staging tree is nested inside the repository", () => {
    const tmpRoot = join(repoRoot, "tmp");
    mkdirSync(tmpRoot, { recursive: true });
    const root = mkdtempSync(join(tmpRoot, "leptonica-source-patch-nested-"));
    try {
      const sourceDir = join(root, "source");
      const expectedDir = join(root, "expected");
      const patchFile = "vendor/patches/change.patch";
      mkdirSync(sourceDir, { recursive: true });
      mkdirSync(expectedDir, { recursive: true });
      mkdirSync(join(root, "vendor/patches"), { recursive: true });
      writeFileSync(join(sourceDir, "input.txt"), "before\n");
      writeFileSync(join(expectedDir, "input.txt"), "after\n");
      writeFileSync(join(root, patchFile), oneLinePatch("after"));
      const source = resolveSourcePatchSet(
        "fixture",
        fixturePin(
          patchFile,
          sha256(oneLinePatch("after")),
          sourceTreeSha256(sourceDir),
          sourceTreeSha256(expectedDir),
        ),
        root,
      );

      applySourcePatches(source, sourceDir);

      expect(readFileSync(join(sourceDir, "input.txt"), "utf8")).toBe("after\n");
      verifySourceTree(source, sourceDir, "patched");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("atomically installs a verified tree and rejects a tampered cache hit", () => {
    const root = mkdtempSync(join(tmpdir(), "leptonica-source-tree-cache-"));
    try {
      const sourceDir = join(root, "deps/fixture");
      const upstreamDir = join(root, "expected-upstream");
      const patchedDir = join(root, "expected-patched");
      const patchFile = "vendor/patches/change.patch";
      for (const directory of [upstreamDir, patchedDir, join(root, "vendor/patches")]) {
        mkdirSync(directory, { recursive: true });
      }
      for (const directory of [upstreamDir, patchedDir]) {
        writeFileSync(join(directory, "CMakeLists.txt"), "project(fixture)\n");
      }
      writeFileSync(join(upstreamDir, "input.txt"), "before\n");
      writeFileSync(join(patchedDir, "input.txt"), "after\n");
      writeFileSync(join(root, patchFile), oneLinePatch("after"));
      const source = resolveSourcePatchSet(
        "fixture",
        fixturePin(
          patchFile,
          sha256(oneLinePatch("after")),
          sourceTreeSha256(upstreamDir),
          sourceTreeSha256(patchedDir),
        ),
        root,
      );
      let populateCalls = 0;
      const populate = (stagingDir: string) => {
        populateCalls += 1;
        writeFileSync(join(stagingDir, "CMakeLists.txt"), "project(fixture)\n");
        writeFileSync(join(stagingDir, "input.txt"), "before\n");
      };

      expect(prepareSourceTree(source, sourceDir, populate)).toBe("installed");
      expect(readFileSync(join(sourceDir, "input.txt"), "utf8")).toBe("after\n");
      expect(prepareSourceTree(source, sourceDir, populate)).toBe("reused");
      expect(populateCalls).toBe(1);

      writeFileSync(join(sourceDir, "input.txt"), "tampered\n");
      expect(() => prepareSourceTree(source, sourceDir, populate)).toThrow("source tree sha256 mismatch");
      expect(populateCalls).toBe(1);

      rmSync(sourceDir, { recursive: true, force: true });
      mkdirSync(sourceDir, { recursive: true });
      writeFileSync(join(sourceDir, "CMakeLists.txt"), "project(fixture)\n");
      writeFileSync(join(sourceDir, "input.txt"), "after\n");
      const externalMarker = join(root, "external-marker.txt");
      writeFileSync(externalMarker, "sentinel\n");
      symlinkSync(externalMarker, join(sourceDir, ".source-identity.json"));
      expect(() => prepareSourceTree(source, sourceDir, populate)).toThrow("marker is not a regular file");
      expect(readFileSync(externalMarker, "utf8")).toBe("sentinel\n");
      expect(populateCalls).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("publishes a verified archive without replacing a concurrent winner", () => {
    const root = mkdtempSync(join(tmpdir(), "leptonica-source-archive-publish-"));
    try {
      const first = join(root, "first.part");
      const second = join(root, "second.part");
      const archive = join(root, "archive.tar.gz");
      writeFileSync(first, "winner\n");
      writeFileSync(second, "loser\n");

      expect(publishVerifiedFile(first, archive)).toBe("published");
      expect(publishVerifiedFile(second, archive)).toBe("existing");
      expect(readFileSync(archive, "utf8")).toBe("winner\n");
      expect(readFileSync(second, "utf8")).toBe("loser\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("publishes a downloaded archive only after source-tree verification", () => {
    const root = mkdtempSync(join(tmpdir(), "leptonica-source-archive-order-"));
    try {
      const expectedDir = join(root, "expected");
      const sourceDir = join(root, "deps/fixture");
      const archive = join(root, "downloads/fixture.tar.gz");
      mkdirSync(expectedDir, { recursive: true });
      writeFileSync(join(expectedDir, "CMakeLists.txt"), "project(fixture)\n");
      writeFileSync(join(expectedDir, "input.txt"), "verified\n");
      const source = resolveSourcePatchSet("fixture", {
        commit: "a".repeat(40),
        sourceTreeSha256: sourceTreeSha256(expectedDir),
        patches: [],
      }, root);
      const downloadedCandidates: string[] = [];
      const download = (candidate: string) => {
        downloadedCandidates.push(candidate);
        mkdirSync(dirname(candidate), { recursive: true });
        writeFileSync(candidate, "complete archive candidate\n");
      };

      expect(() => prepareSourceTreeFromArchive({
        source,
        sourceDir,
        archive,
        download,
        extract(_archive: string, stagingDir: string) {
          writeFileSync(join(stagingDir, "CMakeLists.txt"), "project(fixture)\n");
          writeFileSync(join(stagingDir, "input.txt"), "unverified\n");
        },
      })).toThrow("source tree sha256 mismatch");
      expect(() => readFileSync(archive)).toThrow();
      expect(downloadedCandidates).toHaveLength(1);
      expect(() => readFileSync(downloadedCandidates[0]!)).toThrow();

      expect(prepareSourceTreeFromArchive({
        source,
        sourceDir,
        archive,
        download,
        extract(_archive: string, stagingDir: string) {
          writeFileSync(join(stagingDir, "CMakeLists.txt"), "project(fixture)\n");
          writeFileSync(join(stagingDir, "input.txt"), "verified\n");
        },
      })).toBe("installed");
      expect(readFileSync(archive, "utf8")).toBe("complete archive candidate\n");
      expect(downloadedCandidates).toHaveLength(2);
      expect(() => readFileSync(downloadedCandidates[1]!)).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps an old damaged archive fail-closed until the caller removes it", () => {
    const root = mkdtempSync(join(tmpdir(), "leptonica-source-archive-recovery-"));
    try {
      const candidate = join(root, "verified.part");
      const archive = join(root, "archive.tar.gz");
      writeFileSync(candidate, "verified\n");
      writeFileSync(archive, "damaged\n");

      expect(publishVerifiedFile(candidate, archive)).toBe("existing");
      expect(readFileSync(archive, "utf8")).toBe("damaged\n");

      rmSync(archive);
      expect(publishVerifiedFile(candidate, archive)).toBe("published");
      expect(readFileSync(archive, "utf8")).toBe("verified\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("allows exactly one publisher when two processes race", async () => {
    const root = mkdtempSync(join(tmpdir(), "leptonica-source-archive-race-"));
    try {
      const first = join(root, "first.part");
      const second = join(root, "second.part");
      const archive = join(root, "archive.tar.gz");
      writeFileSync(first, "first complete candidate\n");
      writeFileSync(second, "second complete candidate\n");
      const helperUrl = pathToFileURL(join(repoRoot, "scripts/source-patches.mjs")).href;
      const contenderScript = [
        'import { rmSync } from "node:fs";',
        'import { publishVerifiedFile } from ' + JSON.stringify(helperUrl) + ';',
        'const [candidate, destination] = process.argv.slice(1);',
        'process.stdout.write("ready\\n");',
        'await new Promise((resolve) => process.stdin.once("data", resolve));',
        'try {',
        '  process.stdout.write(publishVerifiedFile(candidate, destination) + "\\n");',
        '} finally {',
        '  rmSync(candidate, { force: true });',
        '}',
      ].join("\n");

      const launch = (candidate: string) => {
        const child = spawn(process.execPath, [
          "--input-type=module",
          "-e",
          contenderScript,
          candidate,
          archive,
        ], { stdio: ["pipe", "pipe", "pipe"] });
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        let stdout = "";
        let stderr = "";
        let readySeen = false;
        let resolveReady: () => void;
        let rejectReady: (error: Error) => void;
        const ready = new Promise<void>((resolvePromise, rejectPromise) => {
          resolveReady = resolvePromise;
          rejectReady = rejectPromise;
        });
        child.stdout.on("data", (chunk: string) => {
          stdout += chunk;
          if (!readySeen && stdout.includes("ready\n")) {
            readySeen = true;
            resolveReady();
          }
        });
        child.stderr.on("data", (chunk: string) => {
          stderr += chunk;
        });
        const done = new Promise<string>((resolvePromise, rejectPromise) => {
          child.once("error", rejectPromise);
          child.once("close", (code) => {
            if (!readySeen) rejectReady(new Error("publisher exited before barrier: " + stderr));
            if (code !== 0) {
              rejectPromise(new Error("publisher exited " + code + ": " + stderr));
              return;
            }
            resolvePromise(stdout.trim().split("\n").at(-1) ?? "");
          });
        });
        return { child, ready, done };
      };

      const contenders = [launch(first), launch(second)];
      await Promise.all(contenders.map(({ ready }) => ready));
      for (const { child } of contenders) child.stdin.end("publish\n");
      const outcomes = await Promise.all(contenders.map(({ done }) => done));

      expect(outcomes.sort()).toEqual(["existing", "published"]);
      expect(["first complete candidate\n", "second complete candidate\n"]).toContain(
        readFileSync(archive, "utf8"),
      );
      expect(readdirSync(root)).toEqual(["archive.tar.gz"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("adopts a verified source-tree winner and removes the losing staging tree", () => {
    const root = mkdtempSync(join(tmpdir(), "leptonica-source-tree-race-"));
    try {
      const sourceDir = join(root, "deps/fixture");
      const upstreamDir = join(root, "expected-upstream");
      const patchedDir = join(root, "expected-patched");
      const patchFile = "vendor/patches/change.patch";
      for (const directory of [upstreamDir, patchedDir, join(root, "vendor/patches")]) {
        mkdirSync(directory, { recursive: true });
      }
      for (const directory of [upstreamDir, patchedDir]) {
        writeFileSync(join(directory, "CMakeLists.txt"), "project(fixture)\n");
      }
      writeFileSync(join(upstreamDir, "input.txt"), "before\n");
      writeFileSync(join(patchedDir, "input.txt"), "after\n");
      writeFileSync(join(root, patchFile), oneLinePatch("after"));
      const source = resolveSourcePatchSet(
        "fixture",
        fixturePin(
          patchFile,
          sha256(oneLinePatch("after")),
          sourceTreeSha256(upstreamDir),
          sourceTreeSha256(patchedDir),
        ),
        root,
      );

      expect(prepareSourceTree(source, sourceDir, (stagingDir: string) => {
        writeFileSync(join(stagingDir, "CMakeLists.txt"), "project(fixture)\n");
        writeFileSync(join(stagingDir, "input.txt"), "before\n");

        mkdirSync(sourceDir, { recursive: true });
        writeFileSync(join(sourceDir, "CMakeLists.txt"), "project(fixture)\n");
        writeFileSync(join(sourceDir, "input.txt"), "after\n");
        writeFileSync(join(sourceDir, ".source-identity.json"), sourceMarkerText(source));
      })).toBe("reused");

      expect(readFileSync(join(sourceDir, "input.txt"), "utf8")).toBe("after\n");
      expect(readdirSync(join(root, "deps"))).toEqual(["fixture"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects an upstream archive that preclaims the reserved identity marker", () => {
    const root = mkdtempSync(join(tmpdir(), "leptonica-source-reserved-marker-"));
    try {
      const expectedDir = join(root, "expected");
      const sourceDir = join(root, "deps/fixture");
      mkdirSync(expectedDir, { recursive: true });
      writeFileSync(join(expectedDir, "CMakeLists.txt"), "project(fixture)\n");
      const source = resolveSourcePatchSet("fixture", {
        commit: "a".repeat(40),
        sourceTreeSha256: sourceTreeSha256(expectedDir),
        patches: [],
      }, root);

      expect(() => prepareSourceTree(source, sourceDir, (stagingDir: string) => {
        writeFileSync(join(stagingDir, "CMakeLists.txt"), "project(fixture)\n");
        writeFileSync(join(stagingDir, ".source-identity.json"), "untrusted\n");
      })).toThrow("upstream source contains a reserved identity marker");
      expect(() => readFileSync(join(sourceDir, ".source-identity.json"), "utf8")).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses strict application, patch-aware markers, caches, and provenance", () => {
    const helper = readFileSync(join(repoRoot, "scripts/source-patches.mjs"), "utf8");
    const build = readFileSync(join(repoRoot, "scripts/build.mjs"), "utf8");
    const nativeBuild = readFileSync(join(repoRoot, "scripts/build-native.mjs"), "utf8");
    const ci = readFileSync(join(repoRoot, ".github/workflows/ci.yml"), "utf8");

    expect(helper).toContain('for (const phase of ["check", "apply"])');
    expect(helper).toContain('args.push("--whitespace=error-all", patch.absolutePath)');
    expect(helper).not.toContain("--3way");
    expect(helper).not.toContain("--reject");
    expect(helper).toContain("applySourcePatches(source, stagingDir)");
    expect(helper).toContain('verifySourceTree(source, sourceDir, "patched")');
    expect(helper).toContain("randomUUID()");
    expect(helper).toContain("publishVerifiedFile(downloadedArchive, archive)");
    for (const script of [build, nativeBuild]) {
      expect(script).toContain("resolveSourcePatchSet");
      expect(script).toContain("prepareSourceTreeFromArchive({");
      expect(script).toContain("source.sourceIdentitySha256");
      expect(script).not.toContain("randomUUID()");
      expect(script).not.toContain("publishVerifiedFile(");
      expect(script).not.toContain("const partial = ");
    }
    expect(build).toContain("dependencySources");
    expect(build).toContain("pinned: versions.emsdk");
    expect(build).toContain("sourceProvenance");
    expect(ci).toContain("'vendor/patches/**'");
    expect(ci).toContain("'scripts/source-patches.mjs'");
    expect(ci).toContain("'scripts/dependency-cache.mjs'");
  });
});
