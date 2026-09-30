import { compareCodeUnits, type DetectorContext, type Evidence, redactCredentials } from "@repo-facts/contract";
import { DEPENDENCY_FIELDS } from "../knowledge.js";
import { type Manifest, isObject } from "../manifests.js";

/**
 * Shared reporting for lockfile readers. Each reader answers one question:
 * which version does this lockfile resolve for a manifest's direct
 * dependency? The answer becomes a resolved_dependencies fact keyed by
 * manifest and package name, so two lockfiles that disagree about one
 * dependency produce a conflict rather than a silent choice.
 */

export interface Resolution {
  version: string;
  evidence: readonly Evidence[];
}

export const RESOLVED_CATEGORY = "resolved_dependencies";
const MISSING_EXAMPLES = 5;

/** Direct dependency names a manifest declares, across every dependency field. */
export function directDependencies(manifest: Manifest): string[] {
  return [...new Set(declaredSpecifiers(manifest).map(([name]) => name))].sort(compareCodeUnits);
}

/** Every [name, specifier] pair a manifest declares, across dependency fields. */
export function declaredSpecifiers(manifest: Manifest): [string, string][] {
  const pairs: [string, string][] = [];
  for (const field of DEPENDENCY_FIELDS) {
    const declared = manifest.value[field];
    if (!isObject(declared)) continue;
    for (const [name, specifier] of Object.entries(declared)) if (typeof specifier === "string") pairs.push([name, specifier]);
  }
  return pairs;
}

/**
 * Reports each direct dependency of +manifest+ that +resolve+ can answer for,
 * and one note listing the dependencies the lockfile does not lock. A lockfile
 * that resolves one dependency more than one way yields a conflict.
 */
export function reportResolutions(context: DetectorContext, lockfile: string, manifest: Manifest, rule: string, resolve: (name: string) => readonly Resolution[]) {
  const missing: string[] = [];
  for (const name of directDependencies(manifest)) {
    const resolutions = resolve(name);
    if (resolutions.length === 0) missing.push(name);
    for (const resolution of resolutions) {
      context.fact({
        category: RESOLVED_CATEGORY,
        key: `${manifest.path}#${name}`,
        value: { manifest: manifest.path, name, version: redactCredentials(resolution.version) },
        basis: "observed",
        evidence: resolution.evidence,
        rule,
      });
    }
  }
  if (missing.length) {
    const examples = missing.slice(0, MISSING_EXAMPLES).join(", ");
    const more = missing.length > MISSING_EXAMPLES ? `, and ${missing.length - MISSING_EXAMPLES} more` : "";
    context.diagnostic(lockfile, "unlocked_dependency", `${manifest.path} declares ${missing.length} ${missing.length === 1 ? "dependency" : "dependencies"} this lockfile does not lock: ${examples}${more}`);
  }
}

/** The directory of +path+ relative to +root+ ("" when equal), or null when it is not inside +root+. */
export function relativeDirectory(directory: string, root: string): string | null {
  if (directory === root) return "";
  if (root === ".") return directory;
  return directory.startsWith(`${root}/`) ? directory.slice(root.length + 1) : null;
}
