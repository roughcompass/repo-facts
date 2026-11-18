/**
 * Lockfiles, by file name. A lockfile records every installed package, so it
 * routinely outgrows the per-file budget for source; the read policy gives
 * lockfiles their own per-file budget instead. Names match at any depth and
 * are compared exactly.
 */

export const LOCKFILE_NAMES: ReadonlySet<string> = new Set([
  // JavaScript and TypeScript
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "deno.lock",
  // Other ecosystems, recognized but not analyzed
  "go.sum",
  "Cargo.lock",
  "gradle.lockfile",
  "Pipfile.lock",
  "poetry.lock",
  "uv.lock",
  "pdm.lock",
  "Gemfile.lock",
  "gems.locked",
  "composer.lock",
  "packages.lock.json",
  "mix.lock",
  "pubspec.lock",
  "Package.resolved",
  "Podfile.lock",
]);

export function isLockfilePath(path: string): boolean {
  return LOCKFILE_NAMES.has(path.slice(path.lastIndexOf("/") + 1));
}
