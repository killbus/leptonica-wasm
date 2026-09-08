export const EXPECTED_EXPORTS: readonly string[];

export interface PackageContractOptions {
  requireManifest?: boolean;
  expectedCommit?: string;
  expectedSourceIdentityKind?: "git-checkout" | "git-commit-archive";
  requireCleanSource?: boolean;
}

export function validatePackageContract(
  packageRoot: string,
  options?: PackageContractOptions,
): string[];
