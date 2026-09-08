import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";

const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const ARCHIVE_MARKER = ".git_archival.txt";

function captureGit(repoRoot, args) {
  const result = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8", env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error("git " + args.join(" ") + " failed: " + result.stderr.trim());
  }
  return result.stdout.trim();
}

function hasGitMetadata(repoRoot) {
  const gitPath = join(repoRoot, ".git");
  if (!existsSync(gitPath)) return false;
  const stat = lstatSync(gitPath);
  if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
    throw new Error("source identity Git metadata must be a regular file or directory");
  }
  return true;
}

function readArchiveCommit(repoRoot) {
  const markerPath = join(repoRoot, ARCHIVE_MARKER);
  if (!existsSync(markerPath)) {
    throw new Error("source identity unavailable: missing .git metadata and " + ARCHIVE_MARKER);
  }
  const stat = lstatSync(markerPath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("archive source commit marker must be a regular file");
  }
  const marker = readFileSync(markerPath, "utf8");
  const match = /^sourceCommit: ([0-9a-f]{40})\r?\n?$/.exec(marker);
  if (!match) throw new Error("archive source commit marker is missing, unexpanded, or malformed");
  return match[1];
}

function validateExpectedCommit(expectedCommit) {
  if (expectedCommit === undefined) return undefined;
  const commit = expectedCommit.trim();
  if (!COMMIT_PATTERN.test(commit)) {
    throw new Error("invalid expected source commit: " + expectedCommit);
  }
  return commit;
}

export function resolveSourceIdentity(repoRoot, expectedCommit = undefined) {
  let identity;
  if (hasGitMetadata(repoRoot)) {
    const sourceCommit = captureGit(repoRoot, ["rev-parse", "HEAD"]);
    if (!COMMIT_PATTERN.test(sourceCommit)) throw new Error("invalid Git source commit: " + sourceCommit);
    const sourceTreeDirty = captureGit(repoRoot, ["status", "--porcelain", "--untracked-files=normal"]).length > 0;
    identity = {
      sourceCommit,
      sourceIdentityKind: "git-checkout",
      sourceTreeDirty,
      sourceTreeState: sourceTreeDirty ? "dirty" : "clean",
    };
  } else {
    identity = {
      sourceCommit: readArchiveCommit(repoRoot),
      sourceIdentityKind: "git-commit-archive",
      sourceTreeDirty: null,
      sourceTreeState: "not-observable-commit-archive",
    };
  }

  const expected = validateExpectedCommit(expectedCommit);
  if (expected !== undefined && expected !== identity.sourceCommit) {
    throw new Error("expected source commit " + expected + " differs from intrinsic source commit " + identity.sourceCommit);
  }
  return identity;
}

export function assertSourceIdentityUnchanged(before, after) {
  if (
    before.sourceCommit !== after.sourceCommit
    || before.sourceIdentityKind !== after.sourceIdentityKind
    || before.sourceTreeDirty !== after.sourceTreeDirty
    || before.sourceTreeState !== after.sourceTreeState
  ) {
    throw new Error("source identity changed during package preparation");
  }
}
