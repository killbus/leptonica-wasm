import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const distRoot = join(repoRoot, "dist");
const EXCLUDED = new Set(["sha256.json", "tsconfig.gen-types.json"]);

/** Depth-first, sorted for deterministic ordering. */
async function listFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const files = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(path)));
    else if (entry.isFile()) files.push(path);
    else throw new Error(`hash manifest only accepts regular files: ${path}`);
  }
  return files;
}

export async function generateHashManifest(root = distRoot) {
  const files = [];
  for (const file of await listFiles(root)) {
    const rel = relative(root, file).split(sep).join("/");
    if (EXCLUDED.has(rel)) continue;
    const content = await readFile(file);
    files.push({ path: rel, bytes: content.length, sha256: createHash("sha256").update(content).digest("hex") });
  }

  const outPath = join(root, "sha256.json");
  await writeFile(outPath, JSON.stringify({ schemaVersion: 1, files }, null, 2) + "\n");
  return { outPath, fileCount: files.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { outPath, fileCount } = await generateHashManifest();
  console.log(`sha256 manifest: ${fileCount} files -> ${outPath}`);
}
