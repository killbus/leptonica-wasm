// Toolchain archive sha256 whitelist (M1 review supply W1).
//
// `emsdk install` downloads ~430MB of toolchain archives (wasm-binaries,
// node, cmake, ninja) over TLS, but the pinned emsdk.py performs no content
// verification — sdkReleaseHash in versions.json addresses a GCS path
// revision, it does not hash the bytes (verified against download_file in
// emsdk.py at the pinned commit; emsdk_manifest.json tool entries carry no
// sha either). This script closes that gap: archives are kept on disk via
// EMSDK_KEEP_DOWNLOADS=1 and hashed against versions.json
// emsdk.toolchainArchives before the emsdk tree enters the actions/cache
// layer (a failed verification fails the job, and actions/cache only saves
// on job success).
//
// Modes:
//   node scripts/verify-toolchain.mjs                        verify tmp/emsdk/downloads
//   node scripts/verify-toolchain.mjs --record [--log PATH] print a
//     toolchainArchives JSON block for versions.json. With --log, urls are
//     parsed from the emsdk install output ("Downloading: <path> from <url>,
//     N Bytes" lines) instead of being left empty for manual fill-in.
//
// Regeneration discipline (supply 议题 1): on an emsdk pin bump, dispatch
// the toolchain-hash workflow, paste the recorded block into versions.json
// under emsdk.toolchainArchives, and PR it for review. See
// research-vendor-pins.md §5. Trust model is TOFU: hashes are recorded from
// a download that already happened; like every pin in versions.json, their
// authority ultimately rests on the git history being review-gated
// (branch protection).

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const downloadsDir = join(repoRoot, "tmp", "emsdk", "downloads");

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

if (!existsSync(downloadsDir)) {
  console.error(`no downloads dir at ${downloadsDir} — this script only makes sense after`);
  console.error("an 'EMSDK_KEEP_DOWNLOADS=1 emsdk install' (pinned emsdk.py deletes archives otherwise)");
  process.exit(1);
}

const downloaded = readdirSync(downloadsDir, { withFileTypes: true })
  .filter((e) => e.isFile() && !e.name.endsWith(".part"))
  .map((e) => e.name)
  .sort();

if (downloaded.length === 0) {
  console.error(`no archives in ${downloadsDir} — expected the emsdk install downloads`);
  process.exit(1);
}

if (process.argv.includes("--record")) {
  // emsdk install log lines carry the authoritative urls (which depend on
  // manifest + os logic we deliberately do not re-implement):
  //   Downloading: /path/downloads/node-v24.19.0-linux-x64.tar.xz from
  //   https://storage.googleapis.com/..., 31633904 Bytes
  const logIdx = process.argv.indexOf("--log");
  const logPath = logIdx !== -1 ? process.argv[logIdx + 1] : undefined;
  const urls = new Map();
  const loggedBytes = new Map();
  if (logPath) {
    const lines = readFileSync(logPath, "utf8").split("\n");
    for (const line of lines) {
      const m = line.match(/Downloading: .*[/\\]downloads[/\\](\S+) from (\S+), (\d+) Bytes/);
      if (m) {
        urls.set(m[1], m[2]);
        loggedBytes.set(m[1], Number(m[3]));
      }
    }
  }
  const entries = downloaded.map((file) => {
    const path = join(downloadsDir, file);
    const bytes = statSync(path).size;
    const url = urls.get(file) ?? "";
    if (logPath && !url) {
      console.error(`no 'Downloading:' log line for ${file} — was the log captured from the same install?`);
      process.exit(1);
    }
    if (loggedBytes.has(file) && loggedBytes.get(file) !== bytes) {
      console.error(`byte-count mismatch for ${file}: log says ${loggedBytes.get(file)}, file has ${bytes}`);
      process.exit(1);
    }
    return { file, url, bytes, sha256: sha256(path) };
  });
  console.log(JSON.stringify({ toolchainArchives: entries }, null, 2));
  if (!logPath) {
    console.error("note: no --log given, urls are empty — rerun with --log <emsdk install output> to fill them");
  }
  process.exit(0);
}

const versions = JSON.parse(readFileSync(join(repoRoot, "vendor", "versions.json"), "utf8"));
const whitelist = versions.emsdk?.toolchainArchives;

if (!Array.isArray(whitelist) || whitelist.length === 0) {
  console.error("versions.json emsdk.toolchainArchives is empty — dispatch the toolchain-hash");
  console.error("workflow and record the hashes (research-vendor-pins.md §5)");
  process.exit(1);
}

for (const entry of whitelist) {
  if (
    typeof entry.file !== "string" ||
    typeof entry.bytes !== "number" ||
    typeof entry.url !== "string" ||
    !/^[0-9a-f]{64}$/.test(entry.sha256 ?? "")
  ) {
    console.error(`invalid toolchainArchives entry: ${JSON.stringify(entry)}`);
    process.exit(1);
  }
}

// Set equality between downloaded files and the whitelist is the coupling
// that forces regeneration on pin bumps: a new sdkVersion / tool version
// changes archive filenames, and this mismatch fails loudly instead of
// silently verifying against a stale list.
const expected = new Set(whitelist.map((e) => e.file));
const extra = downloaded.filter((f) => !expected.has(f));
const missing = [...expected].filter((f) => !downloaded.includes(f));
if (extra.length > 0 || missing.length > 0) {
  if (extra.length > 0) console.error(`downloaded but not whitelisted: ${extra.join(", ")}`);
  if (missing.length > 0) console.error(`whitelisted but not downloaded: ${missing.join(", ")}`);
  console.error("toolchain pins and toolchainArchives have drifted — dispatch toolchain-hash and re-record");
  process.exit(1);
}

let failed = false;
for (const entry of whitelist) {
  const path = join(downloadsDir, entry.file);
  const bytes = statSync(path).size;
  const sha = sha256(path);
  const ok = bytes === entry.bytes && sha === entry.sha256;
  if (!ok) failed = true;
  console.log(`${ok ? "OK  " : "FAIL"} ${entry.file}`);
  console.log(`     ${bytes} bytes (expected ${entry.bytes}), sha256 ${sha}`);
  if (!ok) console.error(`     expected sha256 ${entry.sha256}`);
}

if (failed) {
  console.error("toolchain archive verification FAILED");
  process.exit(1);
}
console.log(`toolchain archives verified (${whitelist.length}/${whitelist.length})`);
