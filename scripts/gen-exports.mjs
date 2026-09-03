import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function extractExportedFunctions(headerText) {
  const names = new Set();
  const parts = headerText.split("LEPT_DLL extern");
  for (let i = 1; i < parts.length; i++) {
    const decl = parts[i].split(";")[0];
    const fnPtr = /\(\s*\*\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(decl);
    if (fnPtr && !decl.slice(0, fnPtr.index).includes("(")) continue;
    const plain = /\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(decl);
    if (plain) names.add("_" + plain[1]);
  }
  return [...names].sort();
}

function usage() {
  console.error("usage: node gen-exports.mjs <header.h> [--out <file>]");
}

const isMain = (() => {
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
})();

if (isMain) {
  const args = process.argv.slice(2);
  let outPath = null;
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--out") {
      outPath = args[i + 1] ?? null;
      if (outPath === null) {
        usage();
        process.exit(2);
      }
      i++;
    } else if (args[i].startsWith("--")) {
      usage();
      process.exit(2);
    } else {
      positional.push(args[i]);
    }
  }
  if (positional.length !== 1 || !positional[0].endsWith(".h")) {
    usage();
    process.exit(2);
  }
  const names = extractExportedFunctions(readFileSync(positional[0], "utf8"));
  const payload = JSON.stringify(names) + "\n";
  if (outPath) {
    mkdirSync(dirname(resolve(outPath)), { recursive: true });
    writeFileSync(outPath, payload);
    console.error(`wrote ${names.length} exported functions to ${outPath}`);
  } else {
    process.stdout.write(payload);
  }
}
