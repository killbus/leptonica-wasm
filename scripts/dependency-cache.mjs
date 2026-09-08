import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { accessSync, constants, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { installTreeSha256 } from "./source-patches.mjs";

function sha256Json(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function requireSha256(value, field) {
  if (!/^[0-9a-f]{64}$/.test(value ?? "")) {
    throw new Error(`${field} is missing or malformed`);
  }
  return value;
}

export function dependencySourceSetSha256(dependencyNames, dependencySources) {
  return sha256Json(dependencyNames.map((name) => [
    name,
    requireSha256(
      dependencySources.get(name)?.sourceIdentitySha256,
      `${name} source identity sha256`,
    ),
  ]));
}

export function dependencyBuildIdentitySha256(buildInput) {
  return sha256Json(buildInput);
}

export function commandVersion(command, args = ["--version"]) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}`);
  }
  return [result.stdout, result.stderr]
    .filter(Boolean)
    .join("\n")
    .replace(/\r\n/g, "\n")
    .trim();
}

export function commandPath(command, {
  cwd = process.cwd(),
  environment = process.env,
} = {}) {
  if (typeof command !== "string" || command === "" || /[\r\n\0]/.test(command)) {
    throw new Error("command path is invalid");
  }
  const hasPathSeparator = command.includes("/") || command.includes("\\") || command.includes(sep);
  const candidates = isAbsolute(command) || hasPathSeparator
    ? [isAbsolute(command) ? command : resolve(cwd, command)]
    : (environment.PATH ?? "")
      .split(delimiter)
      .map((directory) => resolve(cwd, directory || ".", command));
  for (const candidate of candidates) {
    try {
      const invocationPath = resolve(candidate);
      const canonicalTarget = realpathSync(invocationPath);
      if (!lstatSync(canonicalTarget).isFile()) continue;
      accessSync(invocationPath, constants.X_OK);
      return invocationPath;
    } catch (error) {
      if (["ENOENT", "ENOTDIR", "EACCES"].includes(error?.code)) continue;
      throw error;
    }
  }
  throw new Error(`command executable is unavailable: ${command}`);
}

export function compilerProgramPath(compiler, program, {
  cwd = process.cwd(),
  environment = process.env,
} = {}) {
  if (!/^[A-Za-z0-9_.+-]+$/.test(program)) {
    throw new Error(`compiler program name is invalid: ${program}`);
  }
  const compilerPath = commandPath(compiler, { cwd, environment });
  const args = [`-print-prog-name=${program}`];
  const result = spawnSync(compilerPath, args, {
    cwd,
    env: environment,
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${compilerPath} ${args.join(" ")} failed with exit code ${result.status}`);
  }
  const reported = result.stdout.trim();
  if (reported === "" || /[\r\n\0]/.test(reported)) {
    throw new Error(`${compilerPath} reported an invalid ${program} path`);
  }
  try {
    return commandPath(reported, { cwd, environment });
  } catch (error) {
    throw new Error(`${compilerPath} reported ${program} executable is unavailable: ${reported}`, { cause: error });
  }
}

export function assertEnvironmentVariablesUnset(environment, names, label) {
  const present = names.filter((name) => environment[name] !== undefined);
  if (present.length > 0) {
    throw new Error(`${label} does not accept environment overrides: ${present.join(", ")}`);
  }
}

function waitSynchronously(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

export function withDependencyBuildLock({
  lock,
  label,
  timeoutMs = 30 * 60 * 1000,
  pollMs = 250,
}, callback) {
  const startedAt = Date.now();
  const ownerFile = join(lock, "owner.json");
  const ownerToken = randomUUID();
  mkdirSync(dirname(lock), { recursive: true });

  for (;;) {
    try {
      mkdirSync(lock);
      try {
        writeFileSync(ownerFile, JSON.stringify({
          schemaVersion: 1,
          hostname: hostname(),
          pid: process.pid,
          ownerToken,
          createdAt: new Date().toISOString(),
        }) + "\n", { flag: "wx" });
      } catch (error) {
        rmSync(lock, { recursive: true, force: true });
        throw error;
      }
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const lockStat = lstatSync(lock, { throwIfNoEntry: false });
      if (!lockStat) continue;
      if (!lockStat.isDirectory()) {
        throw new Error(`${label} build lock is not a directory`);
      }

      const ownerStat = lstatSync(ownerFile, { throwIfNoEntry: false });
      if (ownerStat && !ownerStat.isFile()) {
        throw new Error(`${label} build lock owner is not a regular file`);
      }
      if (ownerStat) {
        try {
          JSON.parse(readFileSync(ownerFile, "utf8"));
        } catch (parseError) {
          throw new Error(`${label} build lock owner is not valid JSON`, { cause: parseError });
        }
      }
      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error(`${label} build lock timed out`);
      }
      waitSynchronously(pollMs);
    }
  }

  let callbackFailed = false;
  try {
    return callback();
  } catch (error) {
    callbackFailed = true;
    throw error;
  } finally {
    let stillOwned = false;
    const ownerStat = lstatSync(ownerFile, { throwIfNoEntry: false });
    if (ownerStat?.isFile()) {
      try {
        stillOwned = JSON.parse(readFileSync(ownerFile, "utf8")).ownerToken === ownerToken;
      } catch {
        stillOwned = false;
      }
    }
    if (stillOwned) {
      rmSync(lock, { recursive: true, force: true });
    } else if (!callbackFailed) {
      throw new Error(`${label} build lock ownership changed before release`);
    }
  }
}

export function readDependencyBuildCache({ marker, installRoot, buildIdentitySha256, label }) {
  requireSha256(buildIdentitySha256, `${label} build identity sha256`);
  const buildRoot = dirname(marker);
  const buildRootStat = lstatSync(buildRoot, { throwIfNoEntry: false });
  if (!buildRootStat) return null;
  if (!buildRootStat.isDirectory()) throw new Error(`${label} build root is not a directory`);
  const markerStat = lstatSync(marker, { throwIfNoEntry: false });
  if (!markerStat) return null;
  if (!markerStat.isFile()) throw new Error(`${label} build marker is not a regular file`);

  let recorded;
  try {
    recorded = JSON.parse(readFileSync(marker, "utf8"));
  } catch (error) {
    throw new Error(`${label} build marker is not valid JSON`, { cause: error });
  }
  if (recorded.schemaVersion !== 1) {
    throw new Error(`${label} build marker schema is unsupported`);
  }
  requireSha256(recorded.buildIdentitySha256, `${label} recorded build identity sha256`);
  requireSha256(recorded.installTreeSha256, `${label} recorded install tree sha256`);
  if (recorded.buildIdentitySha256 !== buildIdentitySha256) return null;

  if (!existsSync(installRoot)) throw new Error(`${label} install tree is missing`);
  const actualInstallTreeSha256 = installTreeSha256(installRoot);
  if (recorded.installTreeSha256 !== actualInstallTreeSha256) {
    throw new Error(`${label} install tree sha256 mismatch: expected ${recorded.installTreeSha256}, got ${actualInstallTreeSha256}`);
  }
  return { buildIdentitySha256, installTreeSha256: actualInstallTreeSha256 };
}

export function writeDependencyBuildCache({ marker, installRoot, buildIdentitySha256, label }) {
  requireSha256(buildIdentitySha256, `${label} build identity sha256`);
  const buildRootStat = lstatSync(dirname(marker), { throwIfNoEntry: false });
  if (!buildRootStat?.isDirectory()) throw new Error(`${label} build root is not a directory`);
  const computedInstallTreeSha256 = installTreeSha256(installRoot);
  const temporary = join(dirname(marker), `.done.${process.pid}.${randomUUID()}.tmp`);
  const contents = JSON.stringify({
    schemaVersion: 1,
    buildIdentitySha256,
    installTreeSha256: computedInstallTreeSha256,
  }) + "\n";
  try {
    writeFileSync(temporary, contents, { flag: "wx" });
    renameSync(temporary, marker);
  } finally {
    rmSync(temporary, { force: true });
  }
  return { buildIdentitySha256, installTreeSha256: computedInstallTreeSha256 };
}
