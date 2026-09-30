import type { BlobContent, Detector, DetectorContext, Value } from "@repo-facts/contract";
import { readableInputs, unanalyzedInputs } from "./inventory.js";

/**
 * The parse stage for package manifests: every readable package.json and
 * pnpm-workspace.yaml, parsed as data. Later stages read the shared result
 * instead of parsing again. Nothing in a manifest is run: scripts, lifecycle
 * hooks, and specifiers are only data.
 */

export const MANIFESTS = "manifests";

export type JsonObject = { [key: string]: Value };

export interface Manifest {
  path: string;
  /** The manifest's directory, "." for the repository root. */
  directory: string;
  content: BlobContent;
  value: JsonObject;
}

export interface PnpmWorkspace {
  path: string;
  directory: string;
  content: BlobContent;
  packages: { pattern: string; index: number }[];
}

export interface ParsedManifests {
  manifests: readonly Manifest[];
  pnpmWorkspaces: readonly PnpmWorkspace[];
  /** Manifest and workspace paths that could not be read or parsed as expected. */
  unanalyzed: readonly string[];
}

export const manifestsDetector: Detector = {
  id: MANIFESTS,
  version: "1",
  stage: "parse",
  inputs: ["**/package.json", "**/pnpm-workspace.yaml"],
  categories: [],
  async run(context) {
    const unanalyzed = unanalyzedInputs(context, "package-json", "pnpm-workspace").map((input) => input.path);
    const manifests: Manifest[] = [];
    for (const input of readableInputs(context, "package-json")) {
      const parsed = await context.parsed(input.path, "json");
      if (!parsed) {
        unanalyzed.push(input.path);
        continue;
      }
      if (!isObject(parsed.value)) {
        context.diagnostic(input.path, "unsupported_shape", "package.json is not a JSON object");
        unanalyzed.push(input.path);
        continue;
      }
      manifests.push({ path: input.path, directory: directoryOf(input.path), content: parsed.content, value: parsed.value });
    }

    const pnpmWorkspaces: PnpmWorkspace[] = [];
    for (const input of readableInputs(context, "pnpm-workspace")) {
      const parsed = await context.parsed(input.path, "yaml");
      if (!parsed) {
        unanalyzed.push(input.path);
        continue;
      }
      const packages = isObject(parsed.value) ? parsed.value.packages : undefined;
      if (packages !== undefined && !(Array.isArray(packages) && packages.every((pattern) => typeof pattern === "string"))) {
        context.diagnostic(input.path, "unsupported_shape", "packages must be a list of strings");
        unanalyzed.push(input.path);
        continue;
      }
      pnpmWorkspaces.push({
        path: input.path,
        directory: directoryOf(input.path),
        content: parsed.content,
        packages: ((packages ?? []) as string[]).map((pattern, index) => ({ pattern, index })),
      });
    }

    context.shared.set(MANIFESTS, { manifests, pnpmWorkspaces, unanalyzed: [...new Set(unanalyzed)].sort() } satisfies ParsedManifests);
  },
};

export function manifestsOf(context: DetectorContext): ParsedManifests {
  const parsed = context.shared.get(MANIFESTS) as ParsedManifests | undefined;
  if (!parsed) throw new Error("The manifest parse stage has not run");
  return parsed;
}

export function isObject(value: Value | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Own string-valued entries of an object field, in code-unit order of their keys. */
export function stringEntries(value: Value | undefined): [string, string][] {
  if (!isObject(value)) return [];
  return Object.keys(value)
    .sort()
    .flatMap((key) => (typeof value[key] === "string" ? [[key, value[key] as string] as [string, string]] : []));
}

export function directoryOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "." : path.slice(0, slash);
}

/**
 * Matches a directory against a workspace glob as npm, Yarn, and pnpm
 * interpret them: `*` within one segment, `**` across segments. Patterns are
 * matched directly and are never compiled into regular expressions.
 */
export function matchesWorkspacePattern(directory: string, pattern: string): boolean {
  const normalized = normalizePattern(pattern);
  if (normalized === null) return false;
  return matchSegments(normalized.split("/"), directory.split("/"));
}

/** Strips `./`, trailing slashes, and a trailing `/package.json`; returns null for patterns that escape the root. */
export function normalizePattern(pattern: string): string | null {
  let text = pattern.trim();
  while (text.startsWith("./")) text = text.slice(2);
  while (text.endsWith("/")) text = text.slice(0, -1);
  if (text.endsWith("/package.json")) text = text.slice(0, -"/package.json".length);
  if (!text || text.startsWith("/") || text.split("/").some((segment) => segment === ".." || segment === "." || segment === "")) return null;
  return text;
}

function matchSegments(pattern: readonly string[], segments: readonly string[]): boolean {
  // Positions reachable in the pattern after consuming each prefix of the path.
  let states = new Set<number>([0]);
  const expand = (positions: Set<number>) => {
    for (const position of positions) if (pattern[position] === "**") positions.add(position + 1);
    return positions;
  };
  states = expand(states);
  for (const segment of segments) {
    const next = new Set<number>();
    for (const position of states) {
      const part = pattern[position];
      if (part === undefined) continue;
      if (part === "**") next.add(position);
      else if (matchWildcard(part, segment)) next.add(position + 1);
    }
    states = expand(next);
    if (states.size === 0) return false;
  }
  return states.has(pattern.length);
}

/** `*` matches any run of characters and `?` one character, within a single segment. */
function matchWildcard(pattern: string, text: string): boolean {
  let p = 0;
  let t = 0;
  let star = -1;
  let resume = 0;
  while (t < text.length) {
    if (p < pattern.length && (pattern[p] === "?" || pattern[p] === text[t])) {
      p++;
      t++;
    } else if (p < pattern.length && pattern[p] === "*") {
      star = p++;
      resume = t;
    } else if (star !== -1) {
      p = star + 1;
      t = ++resume;
    } else {
      return false;
    }
  }
  while (pattern[p] === "*") p++;
  return p === pattern.length;
}
