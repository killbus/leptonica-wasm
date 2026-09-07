export interface SourcePatchPin {
  file: string;
  appliesToCommit: string;
  sha256: string;
}

export interface SourcePin {
  commit: string;
  sourceTreeSha256: string;
  patchedSourceTreeSha256?: string;
  patches?: SourcePatchPin[];
}

export interface ResolvedSourcePatch extends SourcePatchPin {
  absolutePath: string;
}

export interface ResolvedSource {
  name: string;
  commit: string;
  sourceTreeSha256: string;
  patchedSourceTreeSha256: string;
  sourceIdentitySha256: string;
  patchSetSha256: string;
  patches: readonly ResolvedSourcePatch[];
}

export function directoryTreeSha256(
  sourceDir: string,
  options?: { ignoredRootEntries?: string[] },
): string;
export function installTreeSha256(installDir: string): string;
export function sourceTreeSha256(sourceDir: string): string;
export function resolveSourcePatchSet(name: string, pin: SourcePin, repoRoot?: string): ResolvedSource;
export function verifySourceTree(source: ResolvedSource, sourceDir: string, phase: "upstream" | "patched"): string;
export function sourceMarkerText(source: ResolvedSource): string;
export function sourceProvenance(source: ResolvedSource): {
  commit: string;
  sourceTreeSha256: string;
  patchedSourceTreeSha256: string;
  sourceIdentitySha256: string;
  patchSetSha256: string;
  patches: Array<Pick<SourcePatchPin, "file" | "appliesToCommit" | "sha256">>;
};
export function publishVerifiedFile(candidate: string, destination: string): "published" | "existing";
export function prepareSourceTreeFromArchive(options: {
  source: ResolvedSource;
  sourceDir: string;
  archive: string;
  download: (candidate: string) => void;
  extract: (archive: string, stagingDir: string) => void;
  requiredPath?: string;
}): "installed" | "reused";
export function prepareSourceTree(
  source: ResolvedSource,
  sourceDir: string,
  populate: (stagingDir: string) => void,
  requiredPath?: string,
): "installed" | "reused";
export function applySourcePatches(source: ResolvedSource, sourceDir: string): void;
