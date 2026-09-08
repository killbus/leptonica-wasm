import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { parseDocument, visit } from "yaml";
import { validatePackageContract } from "./check-package-contract.mjs";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const canonicalRepoRoot = realpathSync(repoRoot);

export const CONSUMER_TOOL_VERSIONS = Object.freeze({
  "@types/node": "26.4.1",
  esbuild: "0.27.7",
  typescript: "7.0.2",
});

export function gitDependencyId(repository, commit) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error(`invalid GitHub repository: ${repository}`);
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`invalid Git commit: ${commit}`);
  return `leptonica-wasm@git+https://github.com/${repository}.git#${commit}`;
}

function parseArgs(argv) {
  const options = { keep: false, repeat: 1 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--tarball") options.tarball = resolve(argv[++i]);
    else if (arg === "--github-repository") options.repository = argv[++i];
    else if (arg === "--commit") options.commit = argv[++i]?.toLowerCase();
    else if (arg === "--repeat") options.repeat = Number(argv[++i]);
    else if (arg === "--keep") options.keep = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if ((options.tarball ? 1 : 0) + (options.repository ? 1 : 0) !== 1) {
    throw new Error("select exactly one source: --tarball or --github-repository");
  }
  if (options.commit && !/^[0-9a-f]{40}$/.test(options.commit)) throw new Error(`invalid Git commit: ${options.commit}`);
  if (options.repository) gitDependencyId(options.repository, options.commit ?? "");
  if (!Number.isInteger(options.repeat) || options.repeat < 1 || options.repeat > 3) {
    throw new Error("--repeat must be an integer from 1 through 3");
  }
  return options;
}

function run(command, args, cwd, env = process.env) {
  const result = spawnSync(command, args, { cwd, env, encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed in ${cwd}\n${result.stdout}\n${result.stderr}`);
  }
  if (result.stdout.trim()) process.stdout.write(result.stdout);
  if (result.stderr.trim()) process.stderr.write(result.stderr);
}

const RETRYABLE_NETWORK_PATTERNS = Object.freeze([
  /stream(?: was)? disconnected/i,
  /(?:ERR_PNPM_FETCH_|HTTP(?:\/\d(?:\.\d)?)?(?: status(?: code)?)?[: ]+|(?:response )?status(?: code)?[: ]+)?429(?:\D|$)/i,
  /(?:ERR_PNPM_FETCH_|HTTP(?:\/\d(?:\.\d)?)?(?: status(?: code)?)?[: ]+|(?:response )?status(?: code)?[: ]+)?(?:500|502|503|504|507|508|520|521|522|523|524|529)(?:\D|$)/i,
]);

function errorText(error) {
  if (!(error instanceof Error)) return String(error);
  return `${error.message}\n${error.cause == null ? "" : errorText(error.cause)}`;
}

export function isRetryableNetworkError(error) {
  return RETRYABLE_NETWORK_PATTERNS.some((pattern) => pattern.test(errorText(error)));
}

export function retryAfterMilliseconds(error, now = Date.now()) {
  let requested = 0;
  for (const match of errorText(error).matchAll(/retry-after\s*:\s*([^\r\n]+)/gi)) {
    const value = match[1].trim();
    const seconds = /^(?:0|[1-9]\d*)$/.test(value) ? Number(value) : Number.NaN;
    const milliseconds = Number.isFinite(seconds)
      ? seconds * 1_000
      : Math.max(0, Date.parse(value) - now);
    if (Number.isFinite(milliseconds)) requested = Math.max(requested, milliseconds);
  }
  return requested;
}

function defaultSleep(milliseconds) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

export async function retryWithBackoff(task, options = {}) {
  const sleep = options.sleep ?? defaultSleep;
  const onRetry = options.onRetry ?? (() => {});
  const initialDelayMs = options.initialDelayMs ?? 1_000;
  const maximumDelayMs = options.maximumDelayMs ?? 30_000;
  const now = options.now ?? Date.now;
  let attempt = 1;
  for (;;) {
    try {
      return await task(attempt);
    } catch (error) {
      if (!isRetryableNetworkError(error)) throw error;
      const backoffMs = Math.min(initialDelayMs * (2 ** Math.min(attempt - 1, 30)), maximumDelayMs);
      const delayMs = Math.max(backoffMs, retryAfterMilliseconds(error, now()));
      onRetry({ attempt, delayMs, error });
      await sleep(delayMs);
      attempt += 1;
    }
  }
}

const nodeConsumer = `
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { load } from "leptonica-wasm";
import type { Box, PackedMask } from "leptonica-wasm";
import { loadRaw } from "leptonica-wasm/raw";
import { createSession as createConditionalSession } from "leptonica-wasm/worker";
import { createSession as createNodeSession } from "leptonica-wasm/worker/node";
import fullAbiFactory from "leptonica-wasm/full-abi/leptonica.mjs";

void fullAbiFactory;
type WorkerEntry = typeof import("leptonica-wasm/worker/worker.mjs");
const workerEntry: WorkerEntry | undefined = undefined;
void workerEntry;

function gradient(width: number, height: number): Uint8Array {
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i] = (i / 4) & 0xff;
    rgba[i + 1] = 255 - ((i / 4) & 0xff);
    rgba[i + 2] = 128;
    rgba[i + 3] = 255;
  }
  return rgba;
}

async function exerciseWorker(createSession: typeof createNodeSession): Promise<number> {
  const session = await createSession();
  try {
    const source = await session.load(gradient(16, 16), 16, 16);
    const output = await session.run(source, [
      { op: "toGray" },
      { op: "sauvolaTiled", whsize: 4, factor: 0.34, nx: 1, ny: 1 },
      { op: "selectByArea", thresholdArea: 2, connectivity: 4, relation: "gte" },
    ]);
    return (await output.toMask()).data.length;
  } finally {
    await session.close();
  }
}

async function main(): Promise<void> {
  const lp = await load();
  using source = lp.fromRGBA(gradient(16, 16), 16, 16);
  lp.chain(source).cleanBackgroundToWhite(1, 70, 190);
  lp.chain(source).maskOverColorPixels(10, 1);
  using output = lp.chain(source).toGray().sauvolaTiled(4, 0.34, 1, 1).selectByArea(2, 4, "gte").run();
  const boxes: readonly Box[] = output.connComp();
  const mask: PackedMask = output.toMask();
  const png = output.toPNG();
  if (mask.data.length === 0 || png.length === 0) throw new Error("curated extraction returned no bytes");

  const rawWasmUrl = import.meta.resolve("leptonica-wasm/full-abi/leptonica.wasm");
  const rawWasm = await readFile(fileURLToPath(rawWasmUrl));
  const raw = await loadRaw({ wasmBinary: rawWasm });
  if (typeof raw.raw._pixGetWidth !== "function") throw new Error("raw _pixGetWidth is missing");

  const conditionalBytes = await exerciseWorker(createConditionalSession);
  const nodeBytes = await exerciseWorker(createNodeSession);
  console.log("consumer runtime ok", boxes.length, mask.data.length, png.length, conditionalBytes, nodeBytes);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
`;

const browserConsumer = `
import { load } from "leptonica-wasm";
import { createSession } from "leptonica-wasm/worker";
import type { PackedMask } from "leptonica-wasm/worker";
type WorkerEntry = typeof import("leptonica-wasm/worker/worker.mjs");
const workerEntry: WorkerEntry | undefined = undefined;
const packedMask: PackedMask | undefined = undefined;
void workerEntry;
void packedMask;
export const browserApi = { load, createSession };
`;

const browserFullAbiConsumer = `
import { loadRaw } from "leptonica-wasm/raw";
import fullAbiFactory from "leptonica-wasm/full-abi/leptonica.mjs";

export const fullAbiApi = { loadRaw, fullAbiFactory };
`;

const bundleConsumer = `
import { build } from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const workerEntry = fileURLToPath(new URL(import.meta.resolve("leptonica-wasm/worker/worker.mjs")));
const curatedWasm = fileURLToPath(new URL(import.meta.resolve("leptonica-wasm/leptonica.wasm")));
const fullAbiWasm = fileURLToPath(new URL(import.meta.resolve("leptonica-wasm/full-abi/leptonica.wasm")));
const common = { bundle: true, format: "esm", platform: "browser", external: ["node:*"] };

mkdirSync("browser-dist/full-abi", { recursive: true });
await build({ ...common, entryPoints: ["browser.ts"], outfile: "browser-dist/main.mjs" });
await build({ ...common, entryPoints: [workerEntry], outfile: "browser-dist/worker.mjs" });
await build({ ...common, entryPoints: ["browser-full-abi.ts"], outfile: "browser-dist/full-abi/main.mjs" });
copyFileSync(curatedWasm, "browser-dist/leptonica.wasm");
copyFileSync(fullAbiWasm, "browser-dist/full-abi/leptonica.wasm");
`;

export function consumerWorkspaceYaml(onlyBuiltDependency) {
  const allowed = ["esbuild", ...(onlyBuiltDependency ? [onlyBuiltDependency] : [])];
  return ["onlyBuiltDependencies:", ...allowed.map((name) => "  - \"" + name + "\""), ""].join("\n");
}

export function writeConsumer(root, sourceSpec, onlyBuiltDependency) {
  writeFileSync(join(root, "package.json"), JSON.stringify({
    name: "leptonica-wasm-independent-consumer",
    private: true,
    type: "module",
    packageManager: "pnpm@10.34.5",
    dependencies: { "leptonica-wasm": sourceSpec },
    devDependencies: CONSUMER_TOOL_VERSIONS,
  }, null, 2) + "\n");
  writeFileSync(join(root, "pnpm-workspace.yaml"), consumerWorkspaceYaml(onlyBuiltDependency));
  writeFileSync(join(root, "node-main.ts"), nodeConsumer);
  writeFileSync(join(root, "browser.ts"), browserConsumer);
  writeFileSync(join(root, "browser-full-abi.ts"), browserFullAbiConsumer);
  writeFileSync(join(root, "bundle.mjs"), bundleConsumer);
}

function collectRelativeUrlAssets(source) {
  return [...source.matchAll(/new URL\(\s*["']([^"']+)["']\s*,\s*(?:import\.meta\.url|self\.location\.href)\s*\)/g)]
    .map((match) => match[1]);
}

export function verifyBrowserBundleLayout(outputRoot) {
  const root = resolve(outputRoot);
  const expectations = [
    { file: "main.mjs", asset: "worker.mjs" },
    { file: "worker.mjs", asset: "leptonica.wasm" },
    { file: "full-abi/main.mjs", asset: "leptonica.wasm" },
  ];
  for (const { file, asset } of expectations) {
    const entry = join(root, file);
    if (!existsSync(entry) || !lstatSync(entry).isFile()) throw new Error(`browser bundle entry is missing: ${file}`);
    const source = readFileSync(entry, "utf8");
    const normalizedSource = source.replaceAll("\\", "/");
    if (normalizedSource.includes("/node_modules/") || normalizedSource.includes("file://")) {
      throw new Error(`${file} leaked a package-manager path`);
    }
    const urls = collectRelativeUrlAssets(source);
    const match = urls.find((url) => basename(url) === asset);
    if (!match) throw new Error(`${file} does not retain a resolvable ${asset} URL`);
    const target = match.startsWith("/") ? join(root, match.slice(1)) : resolve(dirname(entry), match);
    if (!target.startsWith(root + sep) || !existsSync(target) || !lstatSync(target).isFile()) {
      throw new Error(`${file} references missing browser asset ${match}`);
    }
  }
  const unexpected = readdirSync(root, { recursive: true })
    .map((path) => String(path).replaceAll("\\", "/"))
    .filter((path) => path.includes("node_modules/leptonica-wasm"));
  if (unexpected.length > 0) throw new Error(`browser bundle leaked package-manager paths: ${unexpected.join(", ")}`);
}

function normalizedPath(path) {
  return resolve(path).replaceAll("\\", "/");
}

function isRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireRecord(value, label) {
  if (!isRecord(value)) throw new Error(`consumer lockfile is missing ${label}`);
  return value;
}

function requireOwn(record, key, label) {
  if (!Object.hasOwn(record, key)) throw new Error(`consumer lockfile is missing ${label}`);
  return record[key];
}

function lockPath(parts) {
  return JSON.stringify(parts);
}

function parsePnpmLockfile(lock) {
  const document = parseDocument(lock, { strict: true, uniqueKeys: true });
  if (document.errors.length > 0) {
    throw new Error(`consumer lockfile is invalid YAML: ${document.errors[0].message}`);
  }
  if (document.warnings.length > 0) {
    throw new Error(`consumer lockfile is invalid YAML: ${document.warnings[0].message}`);
  }
  try {
    visit(document, {
      Alias() {
        throw new Error("YAML aliases are not allowed");
      },
      Node(_key, node) {
        if (node.tag) throw new Error("explicit YAML tags are not allowed");
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`consumer lockfile is invalid YAML: ${message}`);
  }
  let parsed;
  try {
    parsed = document.toJS({ maxAliasCount: 0 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`consumer lockfile is invalid YAML: ${message}`);
  }
  const root = requireRecord(parsed, "root mapping");
  if (root.lockfileVersion !== "9.0") {
    throw new Error(`consumer lockfile has unsupported version: ${String(root.lockfileVersion)}`);
  }
  return root;
}

function assertOnlyExpectedLocalLocators(root, allowedValues, allowedKeys) {
  const worktree = normalizedPath(canonicalRepoRoot);
  const inspect = (value, path) => {
    if (typeof value === "string") {
      const allowed = allowedValues.get(lockPath(path));
      const normalized = value.replaceAll("\\", "/");
      if ((/(?:file|link|workspace):/.test(value) || normalized.includes(worktree)) && value !== allowed) {
        throw new Error("consumer lockfile contains an unexpected local dependency");
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((entry, index) => inspect(entry, [...path, index]));
      return;
    }
    if (!isRecord(value)) return;
    for (const [key, entry] of Object.entries(value)) {
      const childPath = [...path, key];
      const allowed = allowedKeys.get(lockPath(childPath));
      if (/(?:file|link|workspace):/.test(key) && key !== allowed) {
        throw new Error("consumer lockfile contains an unexpected local dependency");
      }
      if (key === "directory" && path.at(-1) === "resolution") {
        throw new Error("consumer lockfile contains a directory resolution");
      }
      inspect(entry, childPath);
    }
  };
  inspect(root, []);
}

function requireSinglePackageIdentity(section, expectedKey, label) {
  const matching = Object.keys(section).filter((key) => key.startsWith("leptonica-wasm@"));
  if (matching.length !== 1 || matching[0] !== expectedKey) {
    throw new Error(`consumer lockfile has an unexpected ${label} identity`);
  }
  return requireOwn(section, expectedKey, `${label} entry`);
}

function sha512Integrity(path) {
  return `sha512-${createHash("sha512").update(readFileSync(path)).digest("base64")}`;
}

/** Verify that pnpm resolved leptonica-wasm from exactly the requested immutable source. */
export function validateConsumerLockfile(lock, options) {
  if ((options.tarball ? 1 : 0) + (options.repository ? 1 : 0) !== 1) {
    throw new Error("select exactly one lockfile source");
  }
  const root = parsePnpmLockfile(lock);
  const importers = requireRecord(root.importers, "importers");
  const rootImporter = requireRecord(requireOwn(importers, ".", "root importer"), "root importer");
  const dependencies = requireRecord(rootImporter.dependencies, "root importer dependencies");
  const dependency = requireRecord(
    requireOwn(dependencies, "leptonica-wasm", "leptonica-wasm dependency"),
    "leptonica-wasm dependency",
  );
  const packages = requireRecord(root.packages, "packages");
  const snapshots = requireRecord(root.snapshots, "snapshots");
  const allowedValues = new Map();
  const allowedKeys = new Map();

  if (options.tarball) {
    if (!options.consumerRoot) throw new Error("consumerRoot is required for tarball lockfile validation");
    const candidate = resolve(options.tarball);
    const candidateStat = lstatSync(candidate);
    if (!candidate.endsWith(".tgz") || candidateStat.isSymbolicLink() || !candidateStat.isFile()) {
      throw new Error("candidate tarball must be a regular non-symlink .tgz file");
    }
    if (normalizedPath(realpathSync(candidate)) !== normalizedPath(candidate)) {
      throw new Error("candidate tarball path must be canonical");
    }
    const absoluteLocator = `file:${normalizedPath(candidate)}`;
    const consumerRoot = realpathSync(resolve(options.consumerRoot));
    const relativeLocator = `file:${relative(consumerRoot, candidate).replaceAll("\\", "/")}`;
    const expectedKey = `leptonica-wasm@${relativeLocator}`;
    if (dependency.specifier !== absoluteLocator || dependency.version !== relativeLocator) {
      throw new Error("consumer lockfile does not bind the exact candidate tarball");
    }
    const packageEntry = requireRecord(
      requireSinglePackageIdentity(packages, expectedKey, "package"),
      "candidate package",
    );
    requireRecord(requireSinglePackageIdentity(snapshots, expectedKey, "snapshot"), "candidate snapshot");
    const resolution = requireRecord(packageEntry.resolution, "candidate package resolution");
    if (
      resolution.tarball !== relativeLocator
      || resolution.integrity !== sha512Integrity(candidate)
    ) {
      throw new Error("consumer lockfile has an invalid candidate tarball resolution");
    }
    allowedValues.set(lockPath(["importers", ".", "dependencies", "leptonica-wasm", "specifier"]), absoluteLocator);
    allowedValues.set(lockPath(["importers", ".", "dependencies", "leptonica-wasm", "version"]), relativeLocator);
    allowedValues.set(lockPath(["packages", expectedKey, "resolution", "tarball"]), relativeLocator);
    allowedKeys.set(lockPath(["packages", expectedKey]), expectedKey);
    allowedKeys.set(lockPath(["snapshots", expectedKey]), expectedKey);
  } else if (options.repository && options.commit) {
    gitDependencyId(options.repository, options.commit);
    const specifier = `git+https://github.com/${options.repository}.git#${options.commit}`;
    const tarball = `https://codeload.github.com/${options.repository}/tar.gz/${options.commit}`;
    const expectedKey = `leptonica-wasm@${tarball}`;
    if (dependency.specifier !== specifier || dependency.version !== tarball) {
      throw new Error("consumer lockfile does not bind the fixed Git source");
    }
    const packageEntry = requireRecord(requireSinglePackageIdentity(packages, expectedKey, "package"), "Git package");
    requireRecord(requireSinglePackageIdentity(snapshots, expectedKey, "snapshot"), "Git snapshot");
    const resolution = requireRecord(packageEntry.resolution, "Git package resolution");
    if (resolution.gitHosted !== true || resolution.tarball !== tarball) {
      throw new Error("consumer lockfile has an invalid fixed Git resolution");
    }
  } else {
    throw new Error("select exactly one lockfile source");
  }

  assertOnlyExpectedLocalLocators(root, allowedValues, allowedKeys);
}

export function validateInstalledPackageRoot(packageRoot, consumerRoot) {
  const canonicalPackageRoot = realpathSync(packageRoot);
  const canonicalConsumerRoot = realpathSync(consumerRoot);
  const relativeToRepo = relative(canonicalRepoRoot, canonicalPackageRoot);
  if (relativeToRepo === "" || (!relativeToRepo.startsWith(`..${sep}`) && !isAbsolute(relativeToRepo))) {
    throw new Error(`consumer resolved back into the worktree: ${canonicalPackageRoot}`);
  }
  const relativeToConsumer = relative(canonicalConsumerRoot, canonicalPackageRoot);
  if (
    relativeToConsumer === ""
    || relativeToConsumer === ".."
    || relativeToConsumer.startsWith(`..${sep}`)
    || isAbsolute(relativeToConsumer)
  ) {
    throw new Error(`consumer package root escaped the consumer directory: ${canonicalPackageRoot}`);
  }
}

function verifyInstalled(root, options) {
  const packageLink = join(root, "node_modules", "leptonica-wasm");
  const packageRoot = realpathSync(packageLink);
  validateInstalledPackageRoot(packageRoot, root);
  const contractErrors = validatePackageContract(packageRoot, {
    requireManifest: true,
    expectedCommit: options.commit,
    requireCleanSource: Boolean(options.commit),
  });
  if (contractErrors.length > 0) throw new Error(contractErrors.join("\n"));
  const lock = readFileSync(join(root, "pnpm-lock.yaml"), "utf8");
  validateConsumerLockfile(lock, { ...options, consumerRoot: root });

  run("pnpm", ["exec", "tsc", "node-main.ts", "--ignoreConfig", "--target", "ES2022", "--module", "NodeNext", "--moduleResolution", "NodeNext", "--lib", "ESNext,DOM", "--types", "node", "--strict", "--skipLibCheck", "false", "--outDir", "out"], root);
  run("pnpm", ["exec", "tsc", "browser.ts", "browser-full-abi.ts", "--ignoreConfig", "--target", "ES2022", "--module", "ESNext", "--moduleResolution", "Bundler", "--lib", "ESNext,DOM", "--strict", "--skipLibCheck", "false", "--noEmit"], root);
  run(process.execPath, [join(root, "bundle.mjs")], root);
  verifyBrowserBundleLayout(join(root, "browser-dist"));
  run(process.execPath, [join(root, "out", "node-main.js")], root);
  console.log(`consumer package root: ${packageRoot}`);
}

async function runOnce(options, attempt) {
  const root = mkdtempSync(join(tmpdir(), `leptonica-consumer-${attempt}-`));
  const store = join(root, "store");
  mkdirSync(store);
  const sourceSpec = options.tarball
    ? `file:${options.tarball}`
    : `git+https://github.com/${options.repository}.git#${options.commit}`;
  const allow = options.repository ? gitDependencyId(options.repository, options.commit) : undefined;
  writeConsumer(root, sourceSpec, allow);
  try {
    const installArgs = ["install", "--store-dir", store, "--config.confirmModulesPurge=false"];
    if (options.tarball) installArgs.push("--ignore-scripts");
    await retryWithBackoff(
      () => run("pnpm", installArgs, root, { ...process.env, CI: "true" }),
      {
        onRetry: ({ attempt: retryAttempt, delayMs, error }) => {
          const message = error instanceof Error ? error.message : String(error);
          console.warn(`pnpm install hit a retryable network failure (attempt ${retryAttempt}); retrying in ${delayMs}ms\n${message}`);
        },
      },
    );
    verifyInstalled(root, options);
  } finally {
    if (options.keep) console.log(`consumer retained at ${root}`);
    else rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void (async () => {
    const options = parseArgs(process.argv.slice(2));
    if (options.tarball && !basename(options.tarball).endsWith(".tgz")) throw new Error("--tarball must name a .tgz file");
    for (let attempt = 1; attempt <= options.repeat; attempt++) await runOnce(options, attempt);
  })().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
