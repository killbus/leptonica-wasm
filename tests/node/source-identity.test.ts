import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertSourceIdentityUnchanged, resolveSourceIdentity } from "../../scripts/source-identity.mjs";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

function git(root: string, args: readonly string[]): string {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr.trim());
  return result.stdout.trim();
}

function gitFixture(): { root: string; commit: string } {
  const root = mkdtempSync(join(tmpdir(), "leptonica-source-identity-git-"));
  git(root, ["init", "--quiet"]);
  git(root, ["config", "user.name", "Source Identity Contract"]);
  git(root, ["config", "user.email", "source-identity@example.invalid"]);
  writeFileSync(join(root, "tracked.txt"), "tracked\n");
  git(root, ["add", "tracked.txt"]);
  git(root, ["commit", "--quiet", "-m", "fixture"]);
  return { root, commit: git(root, ["rev-parse", "HEAD"]) };
}

function archiveFixture(marker: string): string {
  const root = mkdtempSync(join(tmpdir(), "leptonica-source-identity-archive-"));
  writeFileSync(join(root, ".git_archival.txt"), marker);
  return root;
}

describe("package source identity", () => {
  it("rejects source-tree state changes across package preparation", () => {
    const clean = {
      sourceCommit: SHA_A,
      sourceIdentityKind: "git-checkout" as const,
      sourceTreeDirty: false,
      sourceTreeState: "clean" as const,
    };
    const dirty = {
      ...clean,
      sourceTreeDirty: true,
      sourceTreeState: "dirty" as const,
    };

    expect(() => assertSourceIdentityUnchanged(clean, clean)).not.toThrow();
    expect(() => assertSourceIdentityUnchanged(clean, dirty)).toThrow(/changed during package preparation/i);
    expect(() => assertSourceIdentityUnchanged(dirty, clean)).toThrow(/changed during package preparation/i);
  });

  it("uses Git as the intrinsic identity and records observable cleanliness", () => {
    const { root, commit } = gitFixture();
    expect(resolveSourceIdentity(root)).toEqual({
      sourceCommit: commit,
      sourceIdentityKind: "git-checkout",
      sourceTreeDirty: false,
      sourceTreeState: "clean",
    });

    writeFileSync(join(root, "untracked.txt"), "dirty\n");
    expect(resolveSourceIdentity(root)).toMatchObject({
      sourceCommit: commit,
      sourceTreeDirty: true,
      sourceTreeState: "dirty",
    });
  });

  it("uses an expanded archive marker without claiming a clean tree", () => {
    const root = archiveFixture("sourceCommit: " + SHA_A + "\n");
    expect(resolveSourceIdentity(root)).toEqual({
      sourceCommit: SHA_A,
      sourceIdentityKind: "git-commit-archive",
      sourceTreeDirty: null,
      sourceTreeState: "not-observable-commit-archive",
    });
  });

  it.each([
    ["an unexpanded marker", "sourceCommit: $Format:%H$\n"],
    ["a malformed marker", "sourceCommit: not-a-commit\n"],
    ["multiple markers", "sourceCommit: " + SHA_A + "\nsourceCommit: " + SHA_B + "\n"],
  ])("fails closed for %s", (_label, marker) => {
    expect(() => resolveSourceIdentity(archiveFixture(marker))).toThrow(/archive source commit/i);
  });

  it("fails closed without Git metadata or a valid archive marker", () => {
    const root = mkdtempSync(join(tmpdir(), "leptonica-source-identity-missing-"));
    mkdirSync(join(root, "src"));
    expect(() => resolveSourceIdentity(root)).toThrow(/source identity/i);
    expect(() => resolveSourceIdentity(root, SHA_A)).toThrow(/source identity/i);
  });

  it("rejects a symbolic-link archive marker", () => {
    const root = mkdtempSync(join(tmpdir(), "leptonica-source-identity-symlink-"));
    writeFileSync(join(root, "marker-target"), "sourceCommit: " + SHA_A + "\n");
    symlinkSync("marker-target", join(root, ".git_archival.txt"));
    expect(() => resolveSourceIdentity(root)).toThrow(/regular file/i);
  });

  it("uses the environment only to cross-check intrinsic Git identity", () => {
    const { root, commit } = gitFixture();
    expect(resolveSourceIdentity(root, commit).sourceCommit).toBe(commit);
    expect(() => resolveSourceIdentity(root, SHA_B)).toThrow(/differs from intrinsic/i);
  });

  it("uses the environment only to cross-check intrinsic archive identity", () => {
    const root = archiveFixture("sourceCommit: " + SHA_A + "\n");
    expect(resolveSourceIdentity(root, SHA_A).sourceCommit).toBe(SHA_A);
    expect(() => resolveSourceIdentity(root, SHA_B)).toThrow(/differs from intrinsic/i);
  });
});
