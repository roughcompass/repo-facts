import semver from "semver";
import { type Detector, type DetectorContext, type ParsedFile, pointerOf, type Value } from "@repo-facts/contract";
import { readableInputs, unanalyzedInputs } from "../inventory.js";
import { type Manifest, directoryOf, isObject, manifestsOf } from "../manifests.js";
import { RESOLVED_CATEGORY, type Resolution, relativeDirectory, reportResolutions } from "./resolved.js";

/**
 * Resolved versions from pnpm-lock.yaml, read as YAML data; pnpm is never
 * invoked. Lockfile formats 5 (pnpm 7), 6 (pnpm 8), and 9 (pnpm 9 and 10) are
 * supported. Each workspace project is an importer keyed by its directory.
 * Peer-dependency suffixes are removed from versions, and `link:` versions
 * resolve to the linked workspace package's declared version.
 */

export const PNPM_LOCK_RULE = "pnpm-lock.resolved-version";
const SUPPORTED_MAJORS = [5, 6, 9];
const IMPORTER_FIELDS = ["dependencies", "devDependencies", "optionalDependencies"] as const;

export const pnpmLockDetector: Detector = {
  id: "pnpm-lock",
  version: "1",
  stage: "convention",
  inputs: ["**/pnpm-lock.yaml"],
  categories: [RESOLVED_CATEGORY],
  async run(context) {
    const surface: string[] = [];
    const skipped = unanalyzedInputs(context, "pnpm-lock").map((input) => input.path);
    const { manifests } = manifestsOf(context);
    for (const input of readableInputs(context, "pnpm-lock")) {
      surface.push(input.path);
      const parsed = await context.parsed(input.path, "yaml");
      const lock = parsed && readLock(context, input.path, parsed);
      if (!lock) {
        skipped.push(input.path);
        continue;
      }
      for (const manifest of manifests) {
        const relative = relativeDirectory(manifest.directory, lock.root);
        const importer = relative === null ? undefined : lock.importers.get(relative || ".");
        if (!importer) continue;
        reportResolutions(context, input.path, manifest, PNPM_LOCK_RULE, (name) => resolve(context, lock, importer, name, manifests));
      }
    }
    context.search({ category: RESOLVED_CATEGORY, rule: PNPM_LOCK_RULE, surface, complete: true, skipped });
  },
};

interface Locked {
  version: string;
  pointer: string;
}

interface Importer {
  directory: string;
  dependencies: Map<string, Locked[]>;
}

interface PnpmLock {
  root: string;
  content: ParsedFile["content"];
  importers: Map<string, Importer>;
}

function readLock(context: DetectorContext, path: string, parsed: ParsedFile): PnpmLock | null {
  const document = parsed.value;
  if (!isObject(document)) {
    context.diagnostic(path, "unsupported_shape", "The lockfile is not a YAML mapping");
    return null;
  }
  const major = Number.parseInt(String(document.lockfileVersion ?? ""), 10);
  if (!SUPPORTED_MAJORS.includes(major)) {
    context.diagnostic(path, "unsupported_version", `lockfileVersion ${JSON.stringify(document.lockfileVersion ?? null)} is not supported; formats 5, 6, and 9 are`);
    return null;
  }

  // A single-project lockfile keeps the root importer's fields at the top level.
  const raw: [string, Value, string[]][] = isObject(document.importers)
    ? Object.keys(document.importers).map((key) => [key, (document.importers as Record<string, Value>)[key]!, ["importers", key]])
    : [[".", document, []]];

  const importers = new Map<string, Importer>();
  for (const [key, value, prefix] of raw) {
    if (!isObject(value)) {
      context.diagnostic(path, "unsupported_shape", `Importer ${key} is not a mapping`);
      return null;
    }
    const dependencies = new Map<string, Locked[]>();
    for (const field of IMPORTER_FIELDS) {
      const block = value[field];
      if (block === undefined) continue;
      if (!isObject(block)) {
        context.diagnostic(path, "unsupported_shape", `${field} of importer ${key} is not a mapping`);
        return null;
      }
      for (const name of Object.keys(block).sort()) {
        const entry = block[name];
        // Format 5 stores the version directly; formats 6 and 9 store { specifier, version }.
        const [version, pointer] = typeof entry === "string" ? [entry, pointerOf([...prefix, field, name])] : isObject(entry) && typeof entry.version === "string" ? [entry.version, pointerOf([...prefix, field, name, "version"])] : [null, ""];
        if (version === null) continue;
        dependencies.set(name, [...(dependencies.get(name) ?? []), { version: withoutPeers(version, major), pointer }]);
      }
    }
    importers.set(key, { directory: key, dependencies });
  }
  return { root: directoryOf(path), content: parsed.content, importers };
}

/** Removes the peer-dependency suffix pnpm appends to a resolved version. */
function withoutPeers(version: string, major: number): string {
  if (major >= 6) {
    const paren = version.indexOf("(");
    return paren > 0 ? version.slice(0, paren) : version;
  }
  const [head] = version.split("_");
  return semver.valid(head!) ? head! : version;
}

function resolve(context: DetectorContext, lock: PnpmLock, importer: Importer, name: string, manifests: readonly Manifest[]): Resolution[] {
  const resolutions: Resolution[] = [];
  for (const locked of importer.dependencies.get(name) ?? []) {
    const evidence = context.pointer(lock.content, PNPM_LOCK_RULE, "yaml", locked.pointer);
    if (!locked.version.startsWith("link:")) {
      resolutions.push({ version: locked.version, evidence: [evidence] });
      continue;
    }
    const target = linkedDirectory(lock.root, importer.directory, locked.version.slice("link:".length));
    const linked = target === null ? undefined : manifests.find((manifest) => manifest.directory === target);
    if (linked && typeof linked.value.version === "string") {
      resolutions.push({ version: linked.value.version, evidence: [evidence, context.pointer(linked.content, PNPM_LOCK_RULE, "json", "/version")] });
    }
  }
  return resolutions;
}

/** The repository directory a `link:` path names, or null when it leaves the repository. */
function linkedDirectory(root: string, importer: string, link: string): string | null {
  const segments = [...(root === "." ? [] : root.split("/")), ...(importer === "." ? [] : importer.split("/"))];
  for (const segment of link.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) return null;
      segments.pop();
    } else {
      segments.push(segment);
    }
  }
  return segments.length ? segments.join("/") : ".";
}
