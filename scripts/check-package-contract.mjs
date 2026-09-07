import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveSourcePatchSet } from "./source-patches.mjs";

export const EXPECTED_EXPORTS = Object.freeze([
  ".",
  "./raw",
  "./worker",
  "./worker/node",
  "./worker/worker.mjs",
  "./full-abi/leptonica.mjs",
  "./full-abi/leptonica.wasm",
  "./leptonica.mjs",
  "./leptonica.wasm",
]);

const REQUIRED_PACKAGE_FILES = Object.freeze([
  "LICENSE",
  "README.md",
  "vendor/versions.json",
  "vendor/patches/leptonica-1.87.0-recoverable-oom.patch",
  "dist/leptonica.mjs",
  "dist/leptonica.wasm",
  "dist/leptonica.d.ts",
  "dist/worker.mjs",
  "dist/types/index.js",
  "dist/types/index.d.ts",
  "dist/types/raw/index.js",
  "dist/types/raw/index.d.ts",
  "dist/types/worker/index.js",
  "dist/types/worker/index.d.ts",
  "dist/types/worker/node.js",
  "dist/types/worker/node.d.ts",
  "dist/types/worker/worker.mjs",
  "dist/types/worker/worker.d.ts",
  "dist/full-abi/leptonica.mjs",
  "dist/full-abi/leptonica.wasm",
  "dist/full-abi/leptonica-raw.d.ts",
  "dist/package-provenance.json",
]);

const TEST_ONLY_BINDING_NAMES = Object.freeze([
  "testAllocationStats",
  "testArmAllocationFailure",
  "testArmFault",
  "testClearFaults",
]);

function listFiles(root, errors = [], displayRoot = root) {
  const out = [];
  for (const entry of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(root, entry.name);
    if (entry.isSymbolicLink()) {
      errors.push(`${normalizeRelative(relative(displayRoot, path))} must not be a symbolic link`);
    } else if (entry.isDirectory()) out.push(...listFiles(path, errors, displayRoot));
    else if (entry.isFile()) out.push(path);
    else errors.push(`${normalizeRelative(relative(displayRoot, path))} is not a regular file`);
  }
  return out;
}

function flattenTargets(value, conditions = [], out = []) {
  if (typeof value === "string") {
    out.push({ conditions, target: value });
    return out;
  }
  if (value == null || typeof value !== "object" || Array.isArray(value)) return out;
  for (const [condition, child] of Object.entries(value)) {
    flattenTargets(child, [...conditions, condition], out);
  }
  return out;
}

function normalizeRelative(path) {
  return path.split(sep).join("/");
}

function resolveDeclarationSpecifier(importer, specifier) {
  const exact = resolve(dirname(importer), specifier);
  const candidates = [exact];
  if (/\.d\.(?:ts|mts|cts)$/.test(importer)) {
    if (specifier.endsWith(".js")) candidates.push(exact.slice(0, -3) + ".d.ts");
    if (specifier.endsWith(".mjs")) candidates.push(exact.slice(0, -4) + ".d.mts");
  }
  return candidates.find((candidate) => existsSync(candidate) && lstatSync(candidate).isFile());
}

function checkGeneratedImports(packageRoot, errors) {
  const distRoot = join(packageRoot, "dist");
  if (!existsSync(distRoot)) return;
  if (!lstatSync(distRoot).isDirectory() || lstatSync(distRoot).isSymbolicLink()) {
    errors.push("dist must be a regular directory, not a symbolic link");
    return;
  }
  for (const file of listFiles(distRoot, errors, packageRoot).filter((path) => /\.(?:js|mjs|d\.ts|d\.mts)$/.test(path))) {
    const source = readFileSync(file, "utf8");
    const rel = normalizeRelative(relative(packageRoot, file));
    if (/from\s+["'][^"']+\.ts["']|import\s*\(\s*["'][^"']+\.ts["']\s*\)/.test(source)) {
      errors.push(`${rel} contains a published .ts module specifier`);
    }
    const specs = new Set();
    for (const match of source.matchAll(/(?:from\s*|import\s*\(\s*)["']([^"']+)["']/g)) specs.add(match[1]);
    for (const match of source.matchAll(/\bimport\s*["']([^"']+)["']/g)) specs.add(match[1]);
    for (const specifier of specs) {
      if (specifier.startsWith(".") && !resolveDeclarationSpecifier(file, specifier)) {
        errors.push(`${rel} references missing relative module ${specifier}`);
      }
    }
    for (const match of source.matchAll(/new URL\(\s*["']([^"']+)["']\s*,\s*import\.meta\.url\s*\)/g)) {
      const target = resolve(dirname(file), match[1]);
      if (!existsSync(target)) errors.push(`${rel} references missing URL asset ${match[1]}`);
    }
  }
}

function checkNoTestBindings(packageRoot, errors) {
  for (const relativePath of ["dist/leptonica.mjs", "dist/leptonica.d.ts"]) {
    const path = join(packageRoot, relativePath);
    if (!existsSync(path) || !lstatSync(path).isFile()) continue;
    const source = readFileSync(path, "utf8");
    for (const name of TEST_ONLY_BINDING_NAMES) {
      if (source.includes(name)) errors.push(`${relativePath} exposes test-only binding ${name}`);
    }
  }
}

function checkManifest(packageRoot, errors) {
  const distRoot = join(packageRoot, "dist");
  const manifestPath = join(distRoot, "sha256.json");
  if (!existsSync(manifestPath)) {
    errors.push("dist/sha256.json is missing");
    return;
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    errors.push(`dist/sha256.json is invalid JSON: ${error.message}`);
    return;
  }
  if (!Array.isArray(manifest.files)) {
    errors.push("dist/sha256.json files must be an array");
    return;
  }
  if (manifest.schemaVersion !== 1) errors.push("dist/sha256.json schemaVersion must be 1");
  const manifestPaths = [];
  const seen = new Set();
  for (const [index, entry] of manifest.files.entries()) {
    const path = entry?.path;
    if (typeof path !== "string" || path.length === 0) {
      errors.push(`dist/sha256.json files[${index}].path must be a non-empty string`);
      continue;
    }
    const segments = path.split("/");
    if (isAbsolute(path) || /^[A-Za-z]:[\\/]/.test(path) || path.includes("\\") || segments.includes("") || segments.includes(".") || segments.includes("..") || posix.normalize(path) !== path) {
      errors.push(`dist/sha256.json contains unsafe path: ${path}`);
      continue;
    }
    if (seen.has(path)) errors.push(`dist/sha256.json contains duplicate path: ${path}`);
    seen.add(path);
    manifestPaths.push(path);
    if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0) {
      errors.push(`dist/sha256.json has invalid byte count for ${path}`);
    }
    if (!/^[0-9a-f]{64}$/.test(entry.sha256 ?? "")) {
      errors.push(`dist/sha256.json has invalid sha256 for ${path}`);
    }
  }
  const actual = listFiles(distRoot, errors, packageRoot)
    .map((path) => normalizeRelative(relative(distRoot, path)))
    .filter((path) => path !== "sha256.json")
    .sort();
  const recorded = manifestPaths.sort();
  if (JSON.stringify(actual) !== JSON.stringify(recorded)) {
    const missing = actual.filter((path) => !recorded.includes(path));
    const stale = recorded.filter((path) => !actual.includes(path));
    errors.push(`dist/sha256.json file set mismatch (missing: ${missing.join(", ") || "none"}; stale: ${stale.join(", ") || "none"})`);
  }
  const byPath = new Map(manifest.files.map((entry) => [entry?.path, entry]));
  for (const path of actual) {
    const entry = byPath.get(path);
    if (!entry) continue;
    const bytes = readFileSync(join(distRoot, path));
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (entry.bytes !== bytes.length) errors.push(`${path} byte count differs from dist/sha256.json`);
    if (entry.sha256 !== sha256) errors.push(`${path} hash differs from dist/sha256.json`);
  }
}

export function validatePackageContract(packageRoot, options = {}) {
  const root = resolve(packageRoot);
  const errors = [];
  const packagePath = join(root, "package.json");
  if (!existsSync(packagePath)) return ["package.json is missing"];
  const pkg = JSON.parse(readFileSync(packagePath, "utf8"));
  if (!Array.isArray(pkg.files) || !pkg.files.includes("vendor/patches")) {
    errors.push("package files must include vendor/patches");
  }
  const exportKeys = Object.keys(pkg.exports ?? {}).sort();
  const expected = [...EXPECTED_EXPORTS].sort();
  if (JSON.stringify(exportKeys) !== JSON.stringify(expected)) {
    const missing = expected.filter((key) => !exportKeys.includes(key));
    const extra = exportKeys.filter((key) => !expected.includes(key));
    errors.push(`exports mismatch (missing: ${missing.join(", ") || "none"}; extra: ${extra.join(", ") || "none"})`);
  }
  for (const [subpath, value] of Object.entries(pkg.exports ?? {})) {
    const targets = flattenTargets(value);
    if (targets.length === 0) errors.push(`${subpath} has no export targets`);
    for (const { conditions, target } of targets) {
      if (!target.startsWith("./")) {
        errors.push(`${subpath} target ${target} must be package-relative`);
        continue;
      }
      const resolved = resolve(root, target);
      if (!resolved.startsWith(root + sep) || !existsSync(resolved) || !lstatSync(resolved).isFile()) {
        errors.push(`${subpath} ${conditions.join("/") || "default"} target is missing: ${target}`);
      }
      if (conditions.includes("types") && !/\.d\.(?:ts|mts|cts)$/.test(target)) {
        errors.push(`${subpath} types target is not a declaration file: ${target}`);
      }
    }
  }
  for (const path of REQUIRED_PACKAGE_FILES) {
    const required = join(root, path);
    if (!existsSync(required) || !lstatSync(required).isFile()) errors.push(`${path} is missing or not a regular file`);
  }
  let dependencyPins = null;
  try {
    dependencyPins = JSON.parse(readFileSync(join(root, "vendor", "versions.json"), "utf8"));
    for (const [name, pin] of Object.entries(dependencyPins)) {
      if (pin?.sourceTreeSha256 !== undefined || pin?.patches !== undefined) {
        resolveSourcePatchSet(name, pin, root);
      }
    }
  } catch (error) {
    errors.push(`source patch metadata is invalid: ${error.message}`);
  }
  checkGeneratedImports(root, errors);
  checkNoTestBindings(root, errors);

  const provenancePath = join(root, "dist", "package-provenance.json");
  if (existsSync(provenancePath)) {
    try {
      const provenance = JSON.parse(readFileSync(provenancePath, "utf8"));
      if (!/^[0-9a-f]{40}$/.test(provenance.sourceCommit ?? "")) errors.push("package provenance sourceCommit is not a 40-character lowercase SHA");
      if (provenance.packageVersion !== pkg.version) errors.push("package provenance version differs from package.json");
      if (dependencyPins && JSON.stringify(provenance.dependencyPins) !== JSON.stringify(dependencyPins)) {
        errors.push("package provenance dependencyPins differ from vendor/versions.json");
      }
      if (options.expectedCommit && provenance.sourceCommit !== options.expectedCommit) {
        errors.push(`package provenance commit ${provenance.sourceCommit} differs from expected ${options.expectedCommit}`);
      }
      if (options.requireCleanSource && provenance.sourceTreeDirty !== false) errors.push("package provenance reports a dirty source tree");
    } catch (error) {
      errors.push(`dist/package-provenance.json is invalid JSON: ${error.message}`);
    }
  }
  if (options.requireManifest) checkManifest(root, errors);
  return errors;
}

function parseArgs(argv) {
  const options = { packageRoot: ".", requireManifest: false, requireCleanSource: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--package-root") options.packageRoot = argv[++i];
    else if (arg === "--manifest") options.requireManifest = true;
    else if (arg === "--expected-commit") options.expectedCommit = argv[++i];
    else if (arg === "--require-clean-source") options.requireCleanSource = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const options = parseArgs(process.argv.slice(2));
  const errors = validatePackageContract(options.packageRoot, options);
  if (errors.length > 0) {
    for (const error of errors) console.error(`package contract: ${error}`);
    process.exit(1);
  }
  console.log(`package contract OK: ${resolve(options.packageRoot)}`);
}
