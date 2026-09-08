import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { parseAst } from "vite";
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
  return `leptonica-wasm@https://codeload.github.com/${repository}/tar.gz/${commit}`;
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

function walkAst(node, visit, parent = undefined) {
  if (visit(node, parent) === false) return;
  for (const [key, child] of Object.entries(node)) {
    if (key === "loc" || key === "start" || key === "end") continue;
    if (Array.isArray(child)) {
      for (const item of child) {
        if (item !== null && typeof item === "object" && typeof item.type === "string") {
          walkAst(item, visit, node);
        }
      }
    } else if (child !== null && typeof child === "object" && typeof child.type === "string") {
      walkAst(child, visit, node);
    }
  }
}

function parseBrowserBundle(source, file) {
  try {
    return parseAst(source);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(file + " is not parseable JavaScript: " + message);
  }
}

function childAstNodes(node) {
  const children = [];
  for (const [key, child] of Object.entries(node)) {
    if (key === "loc" || key === "start" || key === "end") continue;
    if (Array.isArray(child)) {
      for (const item of child) {
        if (item !== null && typeof item === "object" && typeof item.type === "string") {
          children.push(item);
        }
      }
    } else if (child !== null && typeof child === "object" && typeof child.type === "string") {
      children.push(child);
    }
  }
  return children;
}

function createScope(parent, kind) {
  return { parent, kind, bindings: new Map() };
}

function registerBinding(scope, name, expression, declarationStart) {
  if (scope.bindings.has(name)) {
    scope.bindings.set(name, { expression: undefined, declarationStart });
  } else {
    scope.bindings.set(name, { expression, declarationStart });
  }
}

function nearestVariableScope(scope) {
  let current = scope;
  while (current.kind !== "function" && current.kind !== "program") current = current.parent;
  return current;
}

function collectScopeInfo(parsed) {
  const scopeForNode = new WeakMap();
  const bindingIdentifiers = new WeakSet();
  const root = createScope(undefined, "program");

  const registerPattern = (scope, pattern, expression) => {
    const identifiers = [];
    const collect = (node) => {
      if (node === null || node === undefined) return;
      if (node.type === "Identifier") {
        identifiers.push(node);
      } else if (node.type === "RestElement") {
        collect(node.argument);
      } else if (node.type === "AssignmentPattern") {
        collect(node.left);
      } else if (node.type === "ArrayPattern") {
        for (const element of node.elements) collect(element);
      } else if (node.type === "ObjectPattern") {
        for (const property of node.properties) {
          collect(property.type === "RestElement" ? property.argument : property.value);
        }
      }
    };
    collect(pattern);
    for (const identifier of identifiers) {
      bindingIdentifiers.add(identifier);
      registerBinding(
        scope,
        identifier.name,
        identifiers.length === 1 ? expression : undefined,
        identifier.start,
      );
    }
  };

  const visit = (node, scope) => {
    scopeForNode.set(node, scope);

    if (node.type === "FunctionDeclaration" || node.type === "FunctionExpression"
      || node.type === "ArrowFunctionExpression") {
      if (node.type === "FunctionDeclaration" && node.id !== null) {
        bindingIdentifiers.add(node.id);
        registerBinding(scope, node.id.name, undefined, node.id.start);
      }
      const functionScope = createScope(scope, "function");
      if (node.type === "FunctionExpression" && node.id !== null) {
        bindingIdentifiers.add(node.id);
        registerBinding(functionScope, node.id.name, undefined, node.id.start);
      }
      for (const parameter of node.params) registerPattern(functionScope, parameter, undefined);
      if (node.id !== null) scopeForNode.set(node.id, functionScope);
      for (const parameter of node.params) visit(parameter, functionScope);
      visit(node.body, functionScope);
      return;
    }

    if (node.type === "ClassDeclaration" || node.type === "ClassExpression") {
      if (node.type === "ClassDeclaration" && node.id !== null) {
        bindingIdentifiers.add(node.id);
        registerBinding(scope, node.id.name, undefined, node.id.start);
      }
      const classScope = createScope(scope, "block");
      if (node.id !== null) {
        bindingIdentifiers.add(node.id);
        registerBinding(classScope, node.id.name, undefined, node.id.start);
        scopeForNode.set(node.id, classScope);
      }
      if (node.superClass !== null) visit(node.superClass, classScope);
      visit(node.body, classScope);
      return;
    }

    if (node.type === "BlockStatement" || node.type === "StaticBlock") {
      const blockScope = createScope(scope, "block");
      scopeForNode.set(node, blockScope);
      for (const child of childAstNodes(node)) visit(child, blockScope);
      return;
    }

    if (node.type === "ForStatement" || node.type === "ForInStatement"
      || node.type === "ForOfStatement" || node.type === "SwitchStatement") {
      const blockScope = createScope(scope, "block");
      scopeForNode.set(node, blockScope);
      for (const child of childAstNodes(node)) visit(child, blockScope);
      return;
    }

    if (node.type === "CatchClause") {
      const catchScope = createScope(scope, "block");
      scopeForNode.set(node, catchScope);
      registerPattern(catchScope, node.param, undefined);
      if (node.param !== null) visit(node.param, catchScope);
      visit(node.body, catchScope);
      return;
    }

    if (node.type === "VariableDeclaration") {
      const targetScope = node.kind === "var" ? nearestVariableScope(scope) : scope;
      for (const declaration of node.declarations) {
        const expression = node.kind === "const" && declaration.id.type === "Identifier"
          && declaration.init !== null ? declaration.init : undefined;
        registerPattern(targetScope, declaration.id, expression);
      }
    } else if (node.type === "ImportDeclaration") {
      for (const specifier of node.specifiers) registerPattern(scope, specifier.local, undefined);
    }

    for (const child of childAstNodes(node)) visit(child, scope);
  };

  visit(parsed, root);
  return { scopeForNode, bindingIdentifiers };
}

function resolveBinding(node, name, scopeInfo) {
  let scope = scopeInfo.scopeForNode.get(node);
  while (scope !== undefined) {
    if (scope.bindings.has(name)) return scope.bindings.get(name);
    scope = scope.parent;
  }
  return undefined;
}

function isUnboundIdentifier(node, name, scopeInfo) {
  return node.type === "Identifier" && node.name === name
    && resolveBinding(node, name, scopeInfo) === undefined;
}

function memberHasName(node, name) {
  if (node.type !== "MemberExpression") return false;
  return node.computed
    ? node.property.type === "Literal" && node.property.value === name
    : node.property.type === "Identifier" && node.property.name === name;
}

function staticTemplateValue(node, scopeInfo, resolving) {
  let value = node.quasis[0]?.value.cooked;
  if (value === null || value === undefined) return undefined;
  for (let index = 0; index < node.expressions.length; index += 1) {
    const expression = staticStringValue(node.expressions[index], scopeInfo, resolving);
    if (expression === undefined) return undefined;
    const quasi = node.quasis[index + 1]?.value.cooked;
    if (quasi === null || quasi === undefined) return undefined;
    value += expression + quasi;
  }
  return value;
}

function staticStringValue(node, scopeInfo, resolving = new Set()) {
  if (node.type === "Literal" && typeof node.value === "string") {
    return node.value;
  }
  if (node.type === "Identifier") {
    const binding = resolveBinding(node, node.name, scopeInfo);
    if (binding === undefined || binding.expression === undefined || resolving.has(binding)
      || (binding.declarationStart !== undefined && node.start < binding.declarationStart)) return undefined;
    const next = new Set(resolving);
    next.add(binding);
    return staticStringValue(binding.expression, scopeInfo, next);
  }
  if (node.type === "BinaryExpression" && node.operator === "+") {
    const left = staticStringValue(node.left, scopeInfo, resolving);
    const right = staticStringValue(node.right, scopeInfo, resolving);
    return left === undefined || right === undefined ? undefined : left + right;
  }
  if (node.type === "TemplateLiteral") {
    return staticTemplateValue(node, scopeInfo, resolving);
  }
  return undefined;
}

function isBrowserRuntimeConstructor(node, name, scopeInfo) {
  if (isUnboundIdentifier(node, name, scopeInfo)) return true;
  return node.type === "MemberExpression" && memberHasName(node, name)
    && node.object.type === "Identifier"
    && ["globalThis", "self", "window"].some(
      (globalName) => isUnboundIdentifier(node.object, globalName, scopeInfo),
    );
}

function findBrowserRuntimeConstructorMutation(parsed, scopeInfo) {
  let mutation;
  walkAst(parsed, (node) => {
    if (mutation !== undefined) return false;
    const target = node.type === "AssignmentExpression" || node.type === "UpdateExpression"
      ? node.left ?? node.argument
      : node.type === "UnaryExpression" && node.operator === "delete"
        ? node.argument
        : undefined;
    if (target === undefined) return true;
    for (const name of ["URL", "Worker"]) {
      if (isBrowserRuntimeConstructor(target, name, scopeInfo)) {
        mutation = name;
        return false;
      }
    }
    return true;
  });
  return mutation;
}

function isBrowserUrlBase(node, scopeInfo) {
  if (node.type !== "MemberExpression" || node.computed !== false
    || node.property.type !== "Identifier") return false;
  if (node.property.name === "url" && node.object.type === "MetaProperty") {
    return node.object.meta.name === "import" && node.object.property.name === "meta";
  }
  return node.property.name === "href" && node.object.type === "MemberExpression"
    && node.object.computed === false && node.object.property.type === "Identifier"
    && node.object.property.name === "location"
    && isUnboundIdentifier(node.object.object, "self", scopeInfo);
}

function collectBrowserAssetReferences(parsed, scopeInfo) {
  const references = [];
  const workerConstructors = [];
  walkAst(parsed, (node, parent) => {
    if (node.type === "NewExpression" && node.callee.type === "Identifier"
      && isUnboundIdentifier(node.callee, "Worker", scopeInfo)) {
      workerConstructors.push(node);
    }
    if (node.type !== "NewExpression" || node.callee.type !== "Identifier"
      || !isUnboundIdentifier(node.callee, "URL", scopeInfo) || node.arguments.length < 2
      || !isBrowserUrlBase(node.arguments[1], scopeInfo)) return true;
    references.push({
      node,
      reference: staticStringValue(node.arguments[0], scopeInfo),
      workerSink: parent?.type === "NewExpression"
        && parent.arguments[0] === node
        && parent.callee.type === "Identifier"
        && isUnboundIdentifier(parent.callee, "Worker", scopeInfo),
    });
    return false;
  });
  return { references, workerConstructors };
}

function preprocessBrowserUrlReference(reference) {
  return reference
    .replace(/[\t\n\r]/g, "")
    .replace(/^[\u0000-\u0020]+|[\u0000-\u0020]+$/g, "")
    .replaceAll("\\", "/");
}

function resolveBrowserAssetReference(root, entryFile, reference) {
  try {
    const normalizedReference = preprocessBrowserUrlReference(reference);
    if (/^[A-Za-z][A-Za-z\d+.-]*:/.test(normalizedReference)
      || normalizedReference.startsWith("//")) return undefined;
    const base = new URL(entryFile.replaceAll("\\", "/"), "https://bundle.invalid/");
    const resolvedUrl = new URL(normalizedReference, base);
    if (resolvedUrl.origin !== base.origin || resolvedUrl.pathname.endsWith("/")) return undefined;
    // decodeURIComponent followed by path.resolve() would otherwise turn an
    // encoded separator into filesystem traversal that the browser URL parser
    // did not perform (for example, x%2F..%2Fworker.mjs).
    if (/%(?:2f|5c)/i.test(resolvedUrl.pathname)) return undefined;
    const pathname = decodeURIComponent(resolvedUrl.pathname);
    const target = resolve(root, "." + pathname);
    return target.startsWith(root + sep) ? target : undefined;
  } catch {
    return undefined;
  }
}

export function verifyBrowserBundleLayout(outputRoot) {
  const root = resolve(outputRoot);
  const installedDist = resolve(dirname(root), "node_modules/leptonica-wasm/dist");
  const expectations = [
    {
      file: "main.mjs",
      assets: [
        { asset: "worker.mjs", requireWorkerSink: true },
        { asset: "leptonica.wasm", installedAsset: "leptonica.wasm" },
      ],
    },
    { file: "worker.mjs", assets: [{ asset: "leptonica.wasm", installedAsset: "leptonica.wasm" }] },
    {
      file: "full-abi/main.mjs",
      assets: [{ asset: "leptonica.wasm", installedAsset: "full-abi/leptonica.wasm" }],
    },
  ];
  for (const { file, assets } of expectations) {
    const entry = join(root, file);
    if (!existsSync(entry) || !lstatSync(entry).isFile()) throw new Error(`browser bundle entry is missing: ${file}`);
    const source = readFileSync(entry, "utf8");
    const parsed = parseBrowserBundle(source, file);
    const scopeInfo = collectScopeInfo(parsed);
    const constructorMutation = findBrowserRuntimeConstructorMutation(parsed, scopeInfo);
    if (constructorMutation !== undefined) {
      throw new Error(`${file} mutates the global ${constructorMutation} constructor`);
    }
    const { references, workerConstructors } = collectBrowserAssetReferences(parsed, scopeInfo);
    const expectedAssets = assets.map((expectation) => ({
      ...expectation,
      target: resolve(dirname(entry), expectation.asset),
    }));
    const resolvedReferences = references.map(({ node, reference, workerSink }) => {
      if (reference === undefined) {
        throw new Error(`${file} contains a non-static browser asset URL`);
      }
      const target = resolveBrowserAssetReference(root, file, reference);
      if (target === undefined) {
        throw new Error(`${file} contains a disallowed browser asset URL ${reference}`);
      }
      const expected = expectedAssets.find((candidate) => candidate.target === target);
      if (expected === undefined) {
        throw new Error(`${file} references unexpected browser asset ${reference}`);
      }
      return { node, reference, target, workerSink, expected };
    });
    for (const expected of expectedAssets) {
      const matching = resolvedReferences.filter(({ target }) => target === expected.target);
      if (matching.length === 0) {
        throw new Error(`${file} does not retain a resolvable ${expected.asset} URL`);
      }
      if (!existsSync(expected.target) || !lstatSync(expected.target).isFile()) {
        throw new Error(`${file} references missing browser asset ${matching[0].reference}`);
      }
      if (expected.installedAsset !== undefined) {
        const installed = join(installedDist, expected.installedAsset);
        if (!existsSync(installed) || !lstatSync(installed).isFile()) {
          throw new Error(`installed package asset is missing: ${expected.installedAsset}`);
        }
        if (!readFileSync(expected.target).equals(readFileSync(installed))) {
          throw new Error(`${relative(root, expected.target).replaceAll("\\", "/")} differs from installed package asset`);
        }
      }
    }
    const workerAsset = expectedAssets.find(({ requireWorkerSink }) => requireWorkerSink === true);
    if (workerAsset !== undefined) {
      const connected = new Set(
        resolvedReferences
          .filter(({ workerSink, target }) => workerSink && target === workerAsset.target)
          .map(({ node }) => node),
      );
      if (connected.size === 0 || workerConstructors.some((worker) => !connected.has(worker.arguments[0]))) {
        throw new Error(`${file} does not retain a resolvable ${workerAsset.asset} URL in every Worker resource sink`);
      }
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
