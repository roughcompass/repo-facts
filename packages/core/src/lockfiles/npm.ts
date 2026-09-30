import { type Detector, type DetectorContext, type ParsedFile, pointerOf, type Value } from "@repo-facts/contract";
import { readableInputs, unanalyzedInputs } from "../inventory.js";
import { type JsonObject, directoryOf, isObject, manifestsOf } from "../manifests.js";
import { RESOLVED_CATEGORY, type Resolution, relativeDirectory, reportResolutions } from "./resolved.js";

/**
 * Resolved versions from npm lockfiles (package-lock.json and
 * npm-shrinkwrap.json), read as data; npm is never invoked.
 *
 * Versions 2 and 3 record every installed package under `packages`, keyed by
 * its node_modules path, so a direct dependency is found the way Node.js
 * would find it: in the manifest's own node_modules, then each parent's.
 * Workspace links resolve to the linked package's version. Version 1 records
 * only the root package's tree under `dependencies`.
 */

export const NPM_LOCK_RULE = "npm-lock.resolved-version";
const SUPPORTED_VERSIONS = [1, 2, 3];

export const npmLockDetector: Detector = {
  id: "npm-lock",
  version: "1",
  stage: "convention",
  inputs: ["**/package-lock.json", "**/npm-shrinkwrap.json"],
  categories: [RESOLVED_CATEGORY],
  async run(context) {
    const surface: string[] = [];
    const skipped = unanalyzedInputs(context, "npm-lock").map((input) => input.path);
    for (const input of readableInputs(context, "npm-lock")) {
      surface.push(input.path);
      const parsed = await context.parsed(input.path, "json");
      const lock = parsed && readLock(context, input.path, parsed);
      if (!lock) {
        skipped.push(input.path);
        continue;
      }
      for (const manifest of manifestsOf(context).manifests) {
        const relative = relativeDirectory(manifest.directory, lock.root);
        if (relative === null || !lock.covers(relative)) continue;
        reportResolutions(context, input.path, manifest, NPM_LOCK_RULE, (name) => lock.resolve(relative, name));
      }
    }
    context.search({ category: RESOLVED_CATEGORY, rule: NPM_LOCK_RULE, surface, complete: true, skipped });
  },
};

interface NpmLock {
  root: string;
  /** Whether the lockfile records the package in +relative+ ("" for the lockfile's own directory). */
  covers(relative: string): boolean;
  resolve(relative: string, name: string): Resolution[];
}

function readLock(context: DetectorContext, path: string, parsed: ParsedFile): NpmLock | null {
  const document = parsed.value;
  if (!isObject(document)) {
    context.diagnostic(path, "unsupported_shape", "The lockfile is not a JSON object");
    return null;
  }
  const version = document.lockfileVersion;
  if (typeof version !== "number" || !SUPPORTED_VERSIONS.includes(version)) {
    context.diagnostic(path, "unsupported_version", `lockfileVersion ${JSON.stringify(version ?? null)} is not supported; versions 1, 2, and 3 are`);
    return null;
  }
  const root = directoryOf(path);
  const evidence = (...segments: string[]) => context.pointer(parsed.content, NPM_LOCK_RULE, "json", pointerOf(segments));

  if (version === 1) {
    const dependencies = document.dependencies;
    if (dependencies !== undefined && !isObject(dependencies)) {
      context.diagnostic(path, "unsupported_shape", "dependencies is not an object");
      return null;
    }
    return {
      root,
      covers: (relative) => relative === "",
      resolve(_relative, name) {
        const entry = isObject(dependencies) ? dependencies[name] : undefined;
        return isObject(entry) && typeof entry.version === "string" ? [{ version: entry.version, evidence: [evidence("dependencies", name, "version")] }] : [];
      },
    };
  }

  const packages = document.packages;
  if (!isObject(packages)) {
    context.diagnostic(path, "unsupported_shape", `lockfileVersion ${version} requires a packages object`);
    return null;
  }
  return {
    root,
    covers: (relative) => relative === "" || isObject(packages[relative]),
    resolve(relative, name) {
      const key = installedKey(packages, relative, name);
      if (!key) return [];
      const entry = packages[key] as JsonObject;
      if (entry.link === true && typeof entry.resolved === "string") {
        const target = packages[entry.resolved];
        if (!isObject(target) || typeof target.version !== "string") return [];
        return [{ version: target.version, evidence: [evidence("packages", key, "resolved"), evidence("packages", entry.resolved, "version")] }];
      }
      return typeof entry.version === "string" ? [{ version: entry.version, evidence: [evidence("packages", key, "version")] }] : [];
    },
  };
}

/** The `packages` key Node.js would load +name+ from, starting in +relative+ and walking up. */
function installedKey(packages: JsonObject, relative: string, name: string): string | null {
  let directory = relative;
  for (;;) {
    const key = directory ? `${directory}/node_modules/${name}` : `node_modules/${name}`;
    if (isObject(packages[key] as Value | undefined)) return key;
    if (!directory) return null;
    const slash = directory.lastIndexOf("/");
    directory = slash === -1 ? "" : directory.slice(0, slash);
  }
}
