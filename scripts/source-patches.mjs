import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const defaultRepoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function normalizeRelative(path) {
  return path.split(sep).join("/");
}

export function directoryTreeSha256(sourceDir, { ignoredRootEntries = [] } = {}) {
  const root = resolve(sourceDir);
  const rootStat = lstatSync(root, { throwIfNoEntry: false });
  if (!rootStat) throw new Error(`tree root is missing: ${root}`);
  if (rootStat.isSymbolicLink()) throw new Error(`tree root is a symbolic link: ${root}`);
  if (!rootStat.isDirectory()) throw new Error(`tree root is not a directory: ${root}`);
  const ignored = new Set(ignoredRootEntries);
  const entries = [];
  const visit = (directory, prefix = "") => {
    const children = readdirSync(directory, { withFileTypes: true })
      .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const child of children) {
      const relativePath = prefix ? `${prefix}/${child.name}` : child.name;
      const absolutePath = join(directory, child.name);
      const stat = lstatSync(absolutePath);
      if (stat.isSymbolicLink()) {
        throw new Error(`source tree contains a symbolic link: ${relativePath}`);
      }
      if (prefix === "" && ignored.has(child.name)) {
        if (!stat.isFile()) throw new Error(`${child.name} is not a regular file`);
        continue;
      }
      if (stat.isDirectory()) {
        visit(absolutePath, relativePath);
        continue;
      }
      if (!stat.isFile()) {
        throw new Error(`source tree contains a non-regular entry: ${relativePath}`);
      }
      entries.push({
        path: relativePath,
        mode: stat.mode & 0o111 ? "100755" : "100644",
        bytes: stat.size,
        sha256: sha256(readFileSync(absolutePath)),
      });
    }
  };
  visit(root);
  return sha256(JSON.stringify(entries));
}

export function sourceTreeSha256(sourceDir) {
  return directoryTreeSha256(sourceDir, {
    ignoredRootEntries: [".source-identity.json"],
  });
}

function validatePatchPath(file) {
  if (typeof file !== "string" || file.length === 0) {
    throw new Error("source patch file must be a non-empty string");
  }
  const segments = file.split("/");
  if (isAbsolute(file) || /^[A-Za-z]:[\\/]/.test(file) || file.includes("\\") ||
      segments.includes("") || segments.includes(".") || segments.includes("..") ||
      posix.normalize(file) !== file || !file.startsWith("vendor/patches/")) {
    throw new Error("unsafe source patch path: " + file);
  }
}

function validateRegularPatchFile(repoRoot, file) {
  const root = resolve(repoRoot);
  const absolutePath = resolve(root, file);
  if (!absolutePath.startsWith(root + sep)) {
    throw new Error("unsafe source patch path: " + file);
  }
  let current = root;
  for (const segment of file.split("/")) {
    current = join(current, segment);
    if (!existsSync(current)) {
      throw new Error(file + " is missing or is not a regular file");
    }
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) {
      throw new Error(file + " contains a symbolic link");
    }
  }
  if (!lstatSync(absolutePath).isFile()) {
    throw new Error(file + " is missing or is not a regular file");
  }
  return absolutePath;
}

export function resolveSourcePatchSet(name, pin, repoRoot = defaultRepoRoot) {
  if (!pin || !/^[0-9a-f]{40}$/.test(pin.commit ?? "")) {
    throw new Error(name + " source commit is missing or malformed");
  }
  if (!/^[0-9a-f]{64}$/.test(pin.sourceTreeSha256 ?? "")) {
    throw new Error(name + " sourceTreeSha256 is missing or malformed");
  }
  const patches = pin.patches ?? [];
  if (!Array.isArray(patches)) {
    throw new Error(name + " patches must be an array");
  }
  if (patches.length > 0 && !/^[0-9a-f]{64}$/.test(pin.patchedSourceTreeSha256 ?? "")) {
    throw new Error(name + " patchedSourceTreeSha256 is missing or malformed");
  }

  const seenFiles = new Set();
  const resolved = patches.map((patch, index) => {
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
      throw new Error(name + " patches[" + index + "] must be an object");
    }
    validatePatchPath(patch.file);
    if (seenFiles.has(patch.file)) {
      throw new Error(name + " patch file is duplicated: " + patch.file);
    }
    seenFiles.add(patch.file);
    if (patch.appliesToCommit !== pin.commit) {
      throw new Error(patch.file + " applies to " + (patch.appliesToCommit ?? "<missing>") + ", not " + pin.commit);
    }
    if (!/^[0-9a-f]{64}$/.test(patch.sha256 ?? "")) {
      throw new Error(patch.file + " sha256 is missing or malformed");
    }
    const absolutePath = validateRegularPatchFile(repoRoot, patch.file);
    const actualSha256 = sha256(readFileSync(absolutePath));
    if (actualSha256 !== patch.sha256) {
      throw new Error(patch.file + " sha256 mismatch: expected " + patch.sha256 + ", got " + actualSha256);
    }
    return Object.freeze({
      file: normalizeRelative(relative(repoRoot, absolutePath)),
      appliesToCommit: patch.appliesToCommit,
      sha256: actualSha256,
      absolutePath,
    });
  });

  const patchSetInput = JSON.stringify({
    name,
    commit: pin.commit,
    patches: resolved.map(({ file, appliesToCommit, sha256: digest }) => ({
      file,
      appliesToCommit,
      sha256: digest,
    })),
  });
  const patchSetSha256 = sha256(patchSetInput);
  const identityInput = JSON.stringify({
    name,
    commit: pin.commit,
    sourceTreeSha256: pin.sourceTreeSha256,
    patchedSourceTreeSha256: pin.patchedSourceTreeSha256 ?? pin.sourceTreeSha256,
    patchSetSha256,
  });
  return Object.freeze({
    name,
    commit: pin.commit,
    sourceTreeSha256: pin.sourceTreeSha256,
    patchedSourceTreeSha256: pin.patchedSourceTreeSha256 ?? pin.sourceTreeSha256,
    sourceIdentitySha256: sha256(identityInput),
    patchSetSha256,
    patches: Object.freeze(resolved),
  });
}

export function verifySourceTree(source, sourceDir, phase) {
  const expected = phase === "upstream"
    ? source.sourceTreeSha256
    : phase === "patched"
      ? source.patchedSourceTreeSha256
      : null;
  if (!expected) throw new Error(`unknown source tree verification phase: ${phase}`);
  const actual = sourceTreeSha256(sourceDir);
  if (actual !== expected) {
    throw new Error(`${source.name} ${phase} source tree sha256 mismatch: expected ${expected}, got ${actual}`);
  }
  return actual;
}

export function sourceMarkerText(source) {
  return JSON.stringify({
    schemaVersion: 2,
    name: source.name,
    commit: source.commit,
    sourceTreeSha256: source.sourceTreeSha256,
    patchedSourceTreeSha256: source.patchedSourceTreeSha256,
    sourceIdentitySha256: source.sourceIdentitySha256,
    patchSetSha256: source.patchSetSha256,
    patches: source.patches.map(({ file, appliesToCommit, sha256: digest }) => ({
      file,
      appliesToCommit,
      sha256: digest,
    })),
  }) + "\n";
}

export function sourceProvenance(source) {
  return {
    commit: source.commit,
    sourceTreeSha256: source.sourceTreeSha256,
    patchedSourceTreeSha256: source.patchedSourceTreeSha256,
    sourceIdentitySha256: source.sourceIdentitySha256,
    patchSetSha256: source.patchSetSha256,
    patches: source.patches.map(({ file, appliesToCommit, sha256: digest }) => ({
      file,
      appliesToCommit,
      sha256: digest,
    })),
  };
}

export function publishVerifiedFile(candidate, destination) {
  try {
    linkSync(candidate, destination);
    return "published";
  } catch (error) {
    if (error?.code === "EEXIST") return "existing";
    throw error;
  }
}

export function prepareSourceTreeFromArchive({
  source,
  sourceDir,
  archive,
  download,
  extract,
  requiredPath = "CMakeLists.txt",
}) {
  let downloadedArchive = null;
  try {
    const result = prepareSourceTree(source, sourceDir, (stagingDir) => {
      let archiveToExtract = archive;
      if (!existsSync(archive)) {
        downloadedArchive = archive + "." + process.pid + "." + randomUUID() + ".part";
        download(downloadedArchive);
        if (!existsSync(downloadedArchive)) {
          throw new Error("download did not produce " + downloadedArchive);
        }
        archiveToExtract = downloadedArchive;
      }
      extract(archiveToExtract, stagingDir);
    }, requiredPath);
    if (downloadedArchive !== null) publishVerifiedFile(downloadedArchive, archive);
    return result;
  } finally {
    if (downloadedArchive !== null) rmSync(downloadedArchive, { force: true });
  }
}

export function prepareSourceTree(source, sourceDir, populate, requiredPath = "CMakeLists.txt") {
  const marker = join(sourceDir, ".source-identity.json");
  const markerText = sourceMarkerText(source);
  const reuseExisting = () => {
    const sourceStat = lstatSync(sourceDir, { throwIfNoEntry: false });
    if (!sourceStat) return false;
    if (!sourceStat.isDirectory()) throw new Error(`${source.name} source path is not a directory`);
    const markerStat = lstatSync(marker, { throwIfNoEntry: false });
    if (markerStat && !markerStat.isFile()) {
      throw new Error(`${source.name} source identity marker is not a regular file`);
    }
    if (markerStat && readFileSync(marker, "utf8") === markerText &&
        existsSync(join(sourceDir, requiredPath))) {
      verifySourceTree(source, sourceDir, "patched");
      return true;
    }
    throw new Error(`${source.name} source directory has an unexpected identity`);
  };
  if (reuseExisting()) {
    return "reused";
  }

  const parent = dirname(sourceDir);
  mkdirSync(parent, { recursive: true });
  const stagingDir = mkdtempSync(join(parent, `.${basename(sourceDir)}-`));
  let installed = false;
  try {
    populate(stagingDir);
    if (lstatSync(join(stagingDir, ".source-identity.json"), { throwIfNoEntry: false })) {
      throw new Error(`${source.name} upstream source contains a reserved identity marker`);
    }
    if (!existsSync(join(stagingDir, requiredPath))) {
      throw new Error(`${source.name} source tree is missing ${requiredPath}`);
    }
    verifySourceTree(source, stagingDir, "upstream");
    applySourcePatches(source, stagingDir);
    verifySourceTree(source, stagingDir, "patched");
    writeFileSync(join(stagingDir, ".source-identity.json"), markerText);
    try {
      renameSync(stagingDir, sourceDir);
    } catch (error) {
      if ((error?.code === "EEXIST" || error?.code === "ENOTEMPTY") && reuseExisting()) {
        return "reused";
      }
      throw error;
    }
    installed = true;
    return "installed";
  } finally {
    if (!installed) rmSync(stagingDir, { recursive: true, force: true });
  }
}

export function applySourcePatches(source, sourceDir) {
  if (source.patches.length === 0) return;
  const sourceRoot = resolve(sourceDir);
  const repository = spawnSync("git", ["-C", sourceRoot, "rev-parse", "--show-toplevel"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (repository.error) throw repository.error;
  const repositoryRoot = repository.status === 0 ? resolve(repository.stdout.trim()) : null;
  const repositoryRelativeSource = repositoryRoot === null ? null : relative(repositoryRoot, sourceRoot);
  if (repositoryRelativeSource !== null &&
      (isAbsolute(repositoryRelativeSource) || repositoryRelativeSource.split(sep).includes(".."))) {
    throw new Error(`${source.name} source tree is outside its discovered git worktree`);
  }
  for (const patch of source.patches) {
    for (const phase of ["check", "apply"]) {
      const args = ["apply"];
      // Git ignores paths outside the current repository subdirectory. Run
      // from the discovered worktree root and prefix the nested staging path
      // so applying under repo-owned tmp/ cannot become a successful no-op.
      if (repositoryRelativeSource) {
        args.push(`--directory=${normalizeRelative(repositoryRelativeSource)}`);
      }
      if (phase === "check") args.push("--check");
      args.push("--whitespace=error-all", patch.absolutePath);
      const result = spawnSync("git", args, {
        cwd: repositoryRoot ?? sourceRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (result.error) throw result.error;
      if (result.status !== 0) {
        const detail = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
        throw new Error("git " + args.join(" ") + " failed for " + patch.file + (detail ? ":\n" + detail : ""));
      }
    }
  }
}
