export interface DependencySourceIdentity {
  sourceIdentitySha256: string;
}

export interface DependencyBuildRecord {
  buildIdentitySha256: string;
  installTreeSha256: string;
}

export interface DependencyBuildCacheOptions {
  marker: string;
  installRoot: string;
  buildIdentitySha256: string;
  label: string;
}

export function dependencySourceSetSha256(
  dependencyNames: string[],
  dependencySources: Map<string, DependencySourceIdentity>,
): string;
export function dependencyBuildIdentitySha256(buildInput: unknown): string;
export function commandVersion(command: string, args?: string[]): string;
export function commandPath(
  command: string,
  options?: {
    cwd?: string;
    environment?: Record<string, string | undefined>;
  },
): string;
export function compilerProgramPath(
  compiler: string,
  program: string,
  options?: {
    cwd?: string;
    environment?: Record<string, string | undefined>;
  },
): string;
export function assertEnvironmentVariablesUnset(
  environment: Record<string, string | undefined>,
  names: string[],
  label: string,
): void;
export function readDependencyBuildCache(
  options: DependencyBuildCacheOptions,
): DependencyBuildRecord | null;
export function writeDependencyBuildCache(
  options: DependencyBuildCacheOptions,
): DependencyBuildRecord;
export function withDependencyBuildLock<T>(
  options: {
    lock: string;
    label: string;
    timeoutMs?: number;
    pollMs?: number;
  },
  callback: () => T,
): T;
