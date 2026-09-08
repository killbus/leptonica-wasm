export const CONSUMER_TOOL_VERSIONS: Readonly<{
  "@types/node": string;
  esbuild: string;
  typescript: string;
}>;
export const CONSUMER_COMMAND_MAX_BUFFER_BYTES: number;
export function consumerCommandSpawnOptions(
  cwd: string,
  env?: NodeJS.ProcessEnv,
): {
  cwd: string;
  env: NodeJS.ProcessEnv;
  encoding: "utf8";
  maxBuffer: number;
};
export function runStreamingCommand(
  command: string,
  args: readonly string[],
  cwd: string,
  env?: NodeJS.ProcessEnv,
  output?: {
    stdout?: (chunk: Buffer) => void;
    stderr?: (chunk: Buffer) => void;
  },
): Promise<void>;
export function consumerWorkspaceYaml(onlyBuiltDependency?: string): string;
export function consumerAttemptPaths(ownerRoot: string): { consumerRoot: string; store: string };
export function gitDependencyId(repository: string, commit: string): string;
export function isRetryableNetworkError(error: unknown): boolean;
export function retryAfterMilliseconds(error: unknown, now?: number): number;
export function retryWithBackoff<T>(
  task: (attempt: number) => T | Promise<T>,
  options?: {
    sleep?: (milliseconds: number) => void | Promise<void>;
    onRetry?: (event: { attempt: number; delayMs: number; error: unknown }) => void;
    initialDelayMs?: number;
    maximumDelayMs?: number;
    now?: () => number;
  },
): Promise<T>;
export function removeConsumerRoot(
  root: string,
  remove?: (
    path: string,
    options: {
      recursive: true;
      force: true;
      maxRetries: number;
      retryDelay: number;
    },
  ) => void,
): void;
export function withConsumerRootCleanup<T>(
  root: string,
  task: () => T | Promise<T>,
  options?: {
    remove?: (root: string) => void;
    warn?: (message: string) => void;
  },
): Promise<T>;
export function validateConsumerLockfile(
  lock: string,
  options: { consumerRoot?: string; tarball?: string; repository?: string; commit?: string },
): void;
export function validateInstalledPackageRoot(packageRoot: string, consumerRoot: string): void;
export function consumerPackageContractOptions(options: {
  tarball?: string;
  repository?: string;
  commit?: string;
}): {
  requireManifest: true;
  expectedCommit?: string;
  expectedSourceIdentityKind: "git-checkout" | "git-commit-archive";
  requireCleanSource: boolean;
};
export function writeConsumer(root: string, sourceSpec: string, onlyBuiltDependency?: string): void;
export function verifyBrowserBundleLayout(outputRoot: string): void;
