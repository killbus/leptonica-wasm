import { createHash } from "node:crypto";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

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
    else files.push(path);
  }
  return files;
}

const files = [];
for (const file of await listFiles(distRoot)) {
  const rel = relative(distRoot, file).split(sep).join("/");
  if (EXCLUDED.has(rel)) continue;
  const [content, info] = await Promise.all([readFile(file), stat(file)]);
  files.push({ path: rel, bytes: info.size, sha256: createHash("sha256").update(content).digest("hex") });
}

const outPath = join(distRoot, "sha256.json");
await writeFile(outPath, JSON.stringify({ generatedAt: new Date().toISOString(), files }, null, 2) + "\n");
console.log(`sha256 manifest: ${files.length} files -> ${outPath}`);
