export const CONSUMER_TOOL_VERSIONS: Readonly<{
  "@types/node": string;
  esbuild: string;
  typescript: string;
}>;
export function consumerWorkspaceYaml(onlyBuiltDependency?: string): string;
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
export function validateConsumerLockfile(
  lock: string,
  options: { consumerRoot?: string; tarball?: string; repository?: string; commit?: string },
): void;
export function validateInstalledPackageRoot(packageRoot: string, consumerRoot: string): void;
export function writeConsumer(root: string, sourceSpec: string, onlyBuiltDependency?: string): void;
export function verifyBrowserBundleLayout(outputRoot: string): void;
