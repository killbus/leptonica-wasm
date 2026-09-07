export const EXPECTED_EXPORTS: readonly string[];

export interface PackageContractOptions {
  requireManifest?: boolean;
  expectedCommit?: string;
  requireCleanSource?: boolean;
}

export function validatePackageContract(
  packageRoot: string,
  options?: PackageContractOptions,
): string[];
