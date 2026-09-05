// TS type + JS emission for the published package (M4, reviews F16/B2).
//
// The source tree ships .ts sources whose import specifiers end in ".ts"
// and rely on the repo's tsconfig.base.json (allowImportingTsExtensions,
// lib ESNext+DOM). An external consumer compiles the package with its OWN
// tsconfig — none of those flags — and skipLibCheck:false pulls every
// source into their program (TS5097/TS2614/TS2584, exactly what the
// consumer fixture caught). The fix: emit declarations from the package's
// own controlled tsconfig and point "exports" at the output.
//
// M4 review B2: the package's "import" conditions pointed at those same
// .ts sources. Node strips types only OUTSIDE node_modules — an installed
// package importing .ts fails on every Node version (ERR_UNSUPPORTED_
// NODE_MODULES_TYPE_STRIPPING; verified on a real node_modules layout,
// node v24). So this script now emits JS as well: the runtime entries in
// "exports" point at dist/index.js and dist/raw/index.js, and the .ts
// rewrite tsc performs on import specifiers (.ts -> .js) is exactly what
// the emitted JS needs.
//
// Usage: node gen-types.mjs [--out <dir>] [--root-name <name>]

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

let outDir = join(repoRoot, "dist", "types");
let rootName = "index";
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (arg === "--out") {
    outDir = resolve(process.argv[++i]);
  } else if (arg === "--root-name") {
    rootName = process.argv[++i];
  } else {
    console.error(`usage: node gen-types.mjs [--out <dir>] [--root-name <name>]`);
    console.error(`unknown argument: ${arg}`);
    process.exit(2);
  }
}

// Step 1: the raw tsc declaration emit. We reuse the repo tsconfig base so
// the emitted d.ts match the package's own typecheck exactly (strictness
// and lib settings stay under the package's control, not the consumer's).
// Root module name is rewritten in step 2 because the ambient d.ts
// references the package's internal subpath specifiers.
// tsc resolves "leptonica-wasm/leptonica.mjs" through the real package
// exports (dist/leptonica.d.ts — the embind-generated one). That works for
// the repo's own typecheck but the emitted CuratedModule there is the raw
// embind shape, not our hand-pinned one. Instead of fighting resolution,
// we emit with a paths shim: rewrite the specifier after emit (step 2).
const tsconfigShim = join(repoRoot, "tmp", "tsconfig.gen-types.json");
mkdirSync(dirname(tsconfigShim), { recursive: true });
writeFileSync(
  tsconfigShim,
  JSON.stringify(
    {
      compilerOptions: {
        emitDeclarationOnly: false,
        stripInternal: true,
        declaration: true,
        outDir,
        rootDir: join(repoRoot, "src"),
        module: "nodenext",
        moduleResolution: "nodenext",
        target: "es2022",
        lib: ["esnext", "dom"],
        strict: true,
        noUncheckedIndexedAccess: true,
        exactOptionalPropertyTypes: true,
        allowImportingTsExtensions: true,
        // M4 review B2: JS emit requires this so tsc rewrites the .ts
        // import specifiers in the emitted JS to .js (allowImportingTsExtensions
        // alone forbids emit; this is the supported emit path).
        rewriteRelativeImportExtensions: true,
        noEmit: false,
        types: [],
        // Resolve the package-internal subpath through the hand-pinned
        // ambient declaration instead of the package exports map (which
        // points at the embind-generated d.ts with a different shape).
        // The emitted specifier is rewritten in step 2 anyway; this only
        // has to make tsc's own emit resolve the right names.
        paths: {
          "leptonica-wasm/leptonica.mjs": ["../src/core/emscripten-glue-inner.d.ts"],
        },
      },
      files: [join(repoRoot, "src", "index.ts"), join(repoRoot, "src", "raw", "index.ts")],
    },
    null,
    2,
  ),
);
const tscResult = spawnSync(
  process.execPath,
  [
    "./node_modules/typescript/bin/tsc",
    "-p", tsconfigShim,
  ],
  { stdio: "inherit", cwd: repoRoot },
);
if (tscResult.error) throw tscResult.error;
if (tscResult.status !== 0) {
  console.error(`tsc declaration emit failed with exit code ${tscResult.status}`);
  process.exit(1);
}

// Step 2: rewrite module specifiers so the emitted d.ts no longer
// reference "leptonica-wasm/leptonica.mjs" (the package's OWN name — from a
// consumer's perspective that would resolve through their node_modules
// and circularly back into the package they are compiling). The emitted
// d.ts are consumed in-tree; the relative path replaces the subpath.
const dtsFiles = ["index.d.ts", "raw/index.d.ts", "raw/types.d.ts", "core/types.d.ts", "core/chain.d.ts", "core/load.d.ts", "protocol.d.ts"];
for (const f of dtsFiles) {
  const p = join(outDir, f);
  if (!existsSync(p)) {
    console.error(`gen-types: expected ${p} to exist after tsc emit`);
    process.exit(1);
  }
  let src = readFileSync(p, "utf8");
  src = src.replace(/from "leptonica-wasm\/leptonica.mjs"/g, 'from "./emscripten-glue.d.ts"');
  src = src.replace(/\.ts"/g, '.js"');
  src = src.replace(/emscripten-glue\.d\.js/g, "emscripten-glue.js");
  // The ambient glue declares the module AND we emit a direct import —
  // with both present the import hits the ambient declaration shape
  // (PixHandle etc.); keep the emitted import, drop the ambient file from
  // the program: consumers compile the whole dist/types tree anyway.
  src = src.replace(/\/\/\/ <reference types="leptonica-wasm\/leptonica.mjs" \/>/g, "");
  writeFileSync(p, src);
}
mkdirSync(join(outDir, "core"), { recursive: true });
// Step 3: the ambient embind glue (declare module) must ship with the
// types — chain.d.ts/types.d.ts import PixHandle/CuratedModule from the
// module specifier that the ambient file declares. Copy it in.
const ambientSource = join(repoRoot, "src", "core", "emscripten-glue.d.ts");
if (!existsSync(ambientSource)) {
  console.error(`gen-types: missing ${ambientSource}`);
  process.exit(1);
}
const ambientDest = join(outDir, "core", "emscripten-glue.d.ts");
const ambient = readFileSync(ambientSource, "utf8");
// The ambient file declares module "leptonica-wasm/leptonica.mjs". The
// emitted d.ts import that specifier, but we rewrote those imports to the
// relative path above, so strip the ambient wrapper and keep only the
// interfaces it contains (they are what the imports actually consume).
// The emit-side glue: a plain module re-exporting the shape the emitted
// d.ts import (from "./emscripten-glue.js" — the .js specifier node
// resolution maps onto this .d.ts sibling).
const emitGlue = [
  "// Generated by gen-types.mjs — plain form of src/core/emscripten-glue.d.ts.",
  'export type { EmscriptenModuleArg, PixHandle, CuratedModule } from "../emscripten-glue-shape.js";',
  "",
].join("\n");
writeFileSync(ambientDest, emitGlue);
// The shape file itself must ship with the types — the re-export above
// points at it.
const shapeSource = join(repoRoot, "src", "core", "emscripten-glue-shape.d.ts");
const shapeDest = join(outDir, "emscripten-glue-shape.d.ts");
if (!existsSync(shapeSource)) {
  console.error(`gen-types: missing ${shapeSource}`);
  process.exit(1);
}
writeFileSync(shapeDest, readFileSync(shapeSource, "utf8"));

console.log(`gen-types OK: ${outDir}`);
