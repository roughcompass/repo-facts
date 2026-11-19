/**
 * Why a build failed. A failed build produces no entry, so the entries in use
 * stay as they were.
 */
export const BUILD_FAILURES = ["registry_unreachable", "not_found", "integrity_mismatch", "invalid_package", "invalid_rules", "invalid_entry"] as const;
export type BuildFailure = (typeof BUILD_FAILURES)[number];

export class CatalogBuildError extends Error {
  override name = "CatalogBuildError";

  constructor(
    readonly reason: BuildFailure,
    message: string,
    /** Every problem found, for an entry or rules file that fails validation. */
    readonly problems: readonly string[] = [],
  ) {
    super(message);
  }
}
