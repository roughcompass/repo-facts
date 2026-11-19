import semver from "semver";
import { type PackageFiles, textOf } from "./tarball.js";

/**
 * Salt's own published data: the registry its MCP server and CLI ship, in
 * `@salt-ds/mcp`'s `generated/*.json`. It's built from Salt's main branch, not
 * from a release, so the entry records the snapshot's date, and nothing
 * version-specific comes from it: components, props, tokens, and icons come
 * only from the release's packages. It supplies:
 * - patterns, each with the components it's composed of and its regions;
 * - deprecations, kept when the release's version of their package has them;
 * - guidance: each component's summary and when to use it, and the guides.
 */

export interface SaltDataSections {
  patterns: { id: string; name: string; summary?: string; composed_of: string[]; regions: string[] }[];
  deprecations: { id: string; package: string; kind: "component" | "prop" | "type"; component?: string; name: string; deprecated_in: string; removed_in?: string; replacement?: string; notes?: string }[];
  guidance: { components: { component: string; summary?: string; when_to_use: string[]; when_not_to_use: string[] }[]; guides: { id: string; name: string; summary: string }[] };
}

export interface SaltData {
  /** The snapshot's date, such as 2026-03-31. */
  snapshotDate: string | null;
  sections: Partial<SaltDataSections>;
}

const COMPONENT = /^[A-Z][A-Za-z0-9]*$/;
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const ITEM_ID = /^[a-z0-9][a-z0-9_-]*(\.[a-z0-9_-]+)*$/;
const REGION = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const PACKAGE = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const MAX_PROSE = 4000;

/**
 * Reads Salt's published data from +pkg+, against the release: +components+
 * are the names a pattern or guidance may refer to, and +versions+ the
 * release's version of each package, which decide the deprecations it has.
 */
export function readSaltData(pkg: PackageFiles, components: ReadonlySet<string>, versions: ReadonlyMap<string, string>): SaltData {
  const json = (name: string): Record<string, unknown> | null => {
    const text = textOf(pkg, `generated/${name}.json`);
    if (text === null) return null;
    try {
      const value = JSON.parse(text) as unknown;
      return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };
  const list = (document: Record<string, unknown> | null, key: string) => (Array.isArray(document?.[key]) ? (document[key] as unknown[]).filter(isRecord) : []);
  const sections: Partial<SaltDataSections> = {};

  const patterns = list(json("patterns"), "patterns").flatMap((pattern): SaltDataSections["patterns"] => {
    const id = text(pattern.id);
    const name = prose(pattern.name);
    if (!id || !ITEM_ID.test(id) || !name) return [];
    const composedOf = unique(list(pattern, "composed_of").map((item) => componentName(item.component)).filter((item): item is string => item !== null && components.has(item)));
    const scaffold = isRecord(pattern.starter_scaffold) ? pattern.starter_scaffold : {};
    const regions = unique((Array.isArray(scaffold.regions) ? scaffold.regions : []).filter((item): item is string => typeof item === "string" && REGION.test(item)));
    const summary = prose(pattern.summary);
    return [{ id, name, ...(summary && { summary }), composed_of: composedOf, regions }];
  });
  if (patterns.length) sections.patterns = patterns.sort((a, b) => compare(a.id, b.id));

  const deprecations = list(json("deprecations"), "deprecations").flatMap((item): SaltDataSections["deprecations"] => {
    const id = text(item.id);
    const packageName = text(item.package);
    const kind = item.kind === "component" || item.kind === "prop" || item.kind === "type" ? item.kind : null;
    const name = text(item.name);
    const deprecatedIn = semver.valid(text(item.deprecated_in) ?? "");
    const removedIn = semver.valid(text(item.removed_in) ?? "");
    const release = packageName ? versions.get(packageName) : undefined;
    // Only what the release's version of the package had deprecated, and hadn't removed.
    if (!id || !ITEM_ID.test(id) || !packageName || !PACKAGE.test(packageName) || !kind || !name || !IDENTIFIER.test(name) || !deprecatedIn || !release) return [];
    if (semver.gt(deprecatedIn, release) || (removedIn && semver.lte(removedIn, release))) return [];
    // The component a deprecated prop belongs to, when the release has it.
    const named = componentName(item.component);
    const component = named && components.has(named) ? named : null;
    const replacement = isRecord(item.replacement) ? text(item.replacement.name) : null;
    const notes = isRecord(item.replacement) ? prose(item.replacement.notes) : null;
    return [{ id, package: packageName, kind, ...(component && { component }), name, deprecated_in: deprecatedIn, ...(removedIn && { removed_in: removedIn }), ...(replacement && IDENTIFIER.test(replacement) && { replacement }), ...(notes && { notes }) }];
  });
  if (deprecations.length) sections.deprecations = deprecations.sort((a, b) => compare(a.id, b.id));

  const guidanceComponents = list(json("components"), "components").flatMap((item) => {
    const component = componentName(item.name);
    if (!component) return [];
    const summary = prose(item.summary);
    return [{ component, ...(summary && { summary }), when_to_use: proseList(item.when_to_use), when_not_to_use: proseList(item.when_not_to_use) }];
  });
  const guides = list(json("guides"), "guides").flatMap((item) => {
    const id = text(item.id);
    const name = prose(item.name);
    const summary = prose(item.summary);
    return id && ITEM_ID.test(id) && name && summary ? [{ id, name, summary }] : [];
  });
  if (guidanceComponents.length || guides.length) {
    sections.guidance = {
      components: [...new Map(guidanceComponents.map((item) => [item.component, item])).values()].sort((a, b) => compare(a.component, b.component)),
      guides: guides.sort((a, b) => compare(a.id, b.id)),
    };
  }

  return { snapshotDate: snapshotDate(pkg, json("metadata")), sections };
}

/** The snapshot's date: from a snapshot version such as `0.0.0-snapshot-20260331141637`, else from when the data was generated. */
function snapshotDate(pkg: PackageFiles, metadata: Record<string, unknown> | null): string | null {
  const fromVersion = /-snapshot-(\d{4})(\d{2})(\d{2})/.exec(pkg.version);
  if (fromVersion) return `${fromVersion[1]}-${fromVersion[2]}-${fromVersion[3]}`;
  const generated = text(metadata?.generated_at);
  return generated && /^\d{4}-\d{2}-\d{2}T/.test(generated) ? generated.slice(0, 10) : null;
}

/** A display name, such as `Navigation item`, as the component it names, `NavigationItem`. */
export function componentName(value: unknown): string | null {
  const words = typeof value === "string" ? value.split(/[^A-Za-z0-9]+/).filter(Boolean) : [];
  const name = words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join("");
  return COMPONENT.test(name) ? name : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 160 ? value : null;
}

/** One line of displayed text: control characters and runs of whitespace become single spaces. */
function prose(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const line = value.replace(/[\p{Cc}\s]+/gu, " ").trim();
  return line ? line.slice(0, MAX_PROSE).trim() : null;
}

function proseList(value: unknown): string[] {
  return Array.isArray(value) ? value.map(prose).filter((item): item is string => item !== null).slice(0, 64) : [];
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
