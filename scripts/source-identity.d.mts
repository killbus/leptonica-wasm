export interface SourceIdentity {
  sourceCommit: string;
  sourceIdentityKind: "git-checkout" | "git-commit-archive";
  sourceTreeDirty: boolean | null;
  sourceTreeState: "clean" | "dirty" | "not-observable-commit-archive";
}

export function resolveSourceIdentity(
  repoRoot: string,
  expectedCommit?: string,
): SourceIdentity;

export function assertSourceIdentityUnchanged(
  before: SourceIdentity,
  after: SourceIdentity,
): void;
