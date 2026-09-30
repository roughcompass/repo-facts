import type { BlobContent, Detector, DetectorContext } from "@repo-facts/contract";
import { readableInputs, unanalyzedInputs } from "../inventory.js";
import { type Manifest, directoryOf, manifestsOf } from "../manifests.js";
import { RESOLVED_CATEGORY, type Resolution, declaredSpecifiers, relativeDirectory, reportResolutions } from "./resolved.js";

/**
 * Resolved versions from Yarn classic (v1) lockfiles, read line by line;
 * Yarn is never invoked. Each entry's header lists the `name@range`
 * specifiers it satisfies, so a direct dependency resolves through the exact
 * specifier its manifest declares. Workspace packages are not locked by Yarn
 * classic; they resolve to the member manifest's declared version. Lockfiles
 * written by Yarn 2 and later are recognized and reported as unsupported.
 */

export const YARN_LOCK_RULE = "yarn-lock.resolved-version";
export const YARN_WORKSPACE_RULE = "yarn-lock.workspace-package";

export interface YarnEntry {
  specifiers: string[];
  version: string | null;
  /** 1-based lines of the entry header and its version field. */
  headerLine: number;
  versionLine: number | null;
}

export type YarnParse = { ok: true; entries: YarnEntry[] } | { ok: false; reason: "unsupported_version" | "parse_failed"; detail: string };

export const yarnLockDetector: Detector = {
  id: "yarn-lock",
  version: "1",
  stage: "convention",
  inputs: ["**/yarn.lock"],
  categories: [RESOLVED_CATEGORY],
  async run(context) {
    const surface: string[] = [];
    const skipped = unanalyzedInputs(context, "yarn-lock").map((input) => input.path);
    const lockfiles = readableInputs(context, "yarn-lock");
    const { manifests } = manifestsOf(context);

    for (const input of lockfiles) {
      surface.push(input.path);
      const content = await context.text(input.path);
      const parsed = content ? parseYarnLock(content.text!) : null;
      if (!content || !parsed || !parsed.ok) {
        if (parsed && !parsed.ok) context.diagnostic(input.path, parsed.reason, parsed.detail);
        skipped.push(input.path);
        continue;
      }
      const root = directoryOf(input.path);
      const bySpecifier = new Map<string, YarnEntry[]>();
      for (const entry of parsed.entries) for (const specifier of entry.specifiers) bySpecifier.set(specifier, [...(bySpecifier.get(specifier) ?? []), entry]);

      for (const manifest of manifests) {
        if (relativeDirectory(manifest.directory, root) === null || nearestLockRoot(manifest, lockfiles.map((lock) => directoryOf(lock.path))) !== root) continue;
        const members = manifests.filter((member) => member !== manifest && relativeDirectory(member.directory, root) !== null);
        reportResolutions(context, input.path, manifest, YARN_LOCK_RULE, (name) => resolve(context, content, bySpecifier, manifest, members, name));
      }
    }
    context.search({ category: RESOLVED_CATEGORY, rule: YARN_LOCK_RULE, surface, complete: true, skipped });
  },
};

function resolve(context: DetectorContext, content: BlobContent, bySpecifier: Map<string, YarnEntry[]>, manifest: Manifest, members: readonly Manifest[], name: string): Resolution[] {
  const resolutions: Resolution[] = [];
  for (const [declared, specifier] of declaredSpecifiers(manifest)) {
    if (declared !== name) continue;
    for (const entry of bySpecifier.get(`${name}@${specifier}`) ?? []) {
      if (entry.version === null || entry.versionLine === null) continue;
      resolutions.push({ version: entry.version, evidence: [context.lines(content, YARN_LOCK_RULE, entry.headerLine, entry.versionLine)] });
    }
  }
  if (resolutions.length) return resolutions;

  const member = members.find((candidate) => candidate.value.name === name && typeof candidate.value.version === "string");
  return member ? [{ version: member.value.version as string, evidence: [context.pointer(member.content, YARN_WORKSPACE_RULE, "json", "/version")] }] : [];
}

/** The directory of the lockfile nearest to +manifest+, at or above it. */
function nearestLockRoot(manifest: Manifest, roots: readonly string[]): string | null {
  const covering = roots.filter((root) => relativeDirectory(manifest.directory, root) !== null);
  return covering.sort((a, b) => b.length - a.length || (a === "." ? 1 : -1))[0] ?? null;
}

/**
 * Parses the Yarn v1 lockfile format: unindented `specifier, specifier:`
 * headers, each followed by two-space-indented fields. Only each entry's
 * specifiers and `version` are kept.
 */
export function parseYarnLock(text: string): YarnParse {
  const entries: YarnEntry[] = [];
  let current: YarnEntry | null = null;
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!.replace(/\r$/, "");
    const number = index + 1;
    if (line === "" || line.startsWith("#")) continue;
    if (line === "__metadata:") return { ok: false, reason: "unsupported_version", detail: "Lockfiles written by Yarn 2 or later are not supported by this detector release" };

    if (!line.startsWith(" ")) {
      if (!line.endsWith(":")) return { ok: false, reason: "parse_failed", detail: `Line ${number}: expected an entry header ending in a colon` };
      const specifiers = splitHeader(line.slice(0, -1));
      if (!specifiers) return { ok: false, reason: "parse_failed", detail: `Line ${number}: the entry header is malformed` };
      current = { specifiers, version: null, headerLine: number, versionLine: null };
      entries.push(current);
      continue;
    }
    if (!current) return { ok: false, reason: "parse_failed", detail: `Line ${number}: a field appears before any entry` };
    if (line.startsWith("  version ") && !line.startsWith("   ")) {
      const version = unquote(line.slice("  version ".length).trim());
      if (version === null) return { ok: false, reason: "parse_failed", detail: `Line ${number}: the version is malformed` };
      current.version = version;
      current.versionLine = number;
    }
  }
  return { ok: true, entries };
}

/** Splits `"a@^1", b@^2` into specifiers, honoring quotes. */
function splitHeader(header: string): string[] | null {
  const specifiers: string[] = [];
  for (const part of splitOutsideQuotes(header)) {
    const specifier = unquote(part.trim());
    if (!specifier) return null;
    specifiers.push(specifier);
  }
  return specifiers.length ? specifiers : null;
}

function splitOutsideQuotes(text: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let quoted = false;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (character === "\\" && quoted) index++;
    else if (character === '"') quoted = !quoted;
    else if (character === "," && !quoted) {
      parts.push(text.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

function unquote(text: string): string | null {
  if (!text.startsWith('"')) return text.includes('"') ? null : text;
  if (!text.endsWith('"') || text.length < 2) return null;
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}
