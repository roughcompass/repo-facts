import { z } from "zod";
import { dump, sha256 } from "../canonical-json.js";

/**
 * The Reference Catalog entry format, `reference_catalog.entry` version 1:
 * what one thing that repositories build on, such as a design system, offers
 * at one version. See docs/reference-catalog.md.
 *
 * Entries are inert data. Every string that Surveyor compares is held to a
 * narrow pattern, such as a component name, an HTML tag, a CSS property, or
 * a package name, so nothing in an entry can be code or become a pattern;
 * every object is strict, so an unknown field is an error. Prose, such as a
 * pattern's summary, is only ever displayed.
 *
 * An entry has three parts:
 * - identity: `kind`, `id`, `version`, and the `packages` it applies to;
 * - provenance: `built_at`, and the `sources` that supplied each section;
 * - content: a `content` object specific to the kind.
 *
 * Its `digest` is the SHA-256 of its canonical JSON without `digest` and
 * `built_at`, so two builds from the same inputs have the same digest.
 */

export const ENTRY_SCHEMA = "reference_catalog.entry";
export const ENTRY_FORMAT_VERSION = 1;

/** The kinds of thing an entry can describe. Only design systems have content in format version 1. */
export const ENTRY_KINDS = ["design_system", "runtime_api", "composition_contract"] as const;
export type EntryKind = (typeof ENTRY_KINDS)[number];

/** The sections of a design-system entry's content, each supplied by exactly one source. */
export const DESIGN_SYSTEM_SECTIONS = [
  "name",
  "token_prefix",
  "class_prefix",
  "theme_stylesheets",
  "providers",
  "components",
  "tokens",
  "icons",
  "patterns",
  "deprecations",
  "guidance",
  "equivalents",
  "neutral_tags",
  "neutral_values",
  "property_families",
  "render_props",
] as const;
export type DesignSystemSection = (typeof DESIGN_SYSTEM_SECTIONS)[number];

const MAX_ITEMS = 20_000;

export const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/;
const version = z.string().max(64).regex(VERSION_PATTERN, "must be a version such as 1.2.3 or 1.2.3-rc.1");
const entryId = z.string().max(64).regex(/^[a-z][a-z0-9-]*$/, "must be a lowercase id, such as salt");
const label = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[A-Za-z0-9][A-Za-z0-9 .-]*$/, "must be a plain name");
const packageName = z
  .string()
  .min(1)
  .max(214)
  .regex(/^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/, "must be a package name");
const moduleName = z
  .string()
  .min(1)
  .max(214)
  .regex(/^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(\/[A-Za-z0-9._-]+)*$/, "must be a package name or package subpath");
const component = z.string().max(120).regex(/^[A-Z][A-Za-z0-9]*$/, "must be a component name, such as Button");
const identifier = z.string().max(120).regex(/^[A-Za-z_$][A-Za-z0-9_$]*$/, "must be a plain identifier");
const tag = z.string().max(64).regex(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/, "must be an HTML tag name");
const property = z.string().max(64).regex(/^-?[a-z][a-z0-9]*(-[a-z0-9]+)*$/, "must be a CSS property name");
const family = z.string().max(32).regex(/^[a-z][a-z_]*$/, "must be a lowercase family name");
const token = z.string().max(160).regex(/^--[A-Za-z][A-Za-z0-9]*(-[A-Za-z0-9]+)*$/, "must be a custom property name");
const tokenPrefix = z.string().max(32).regex(/^--[a-z][a-z0-9]*-$/, "must be a custom property prefix, such as --salt-");
const classPrefix = z.string().max(32).regex(/^[a-z][a-z0-9]*$/, "must be a lowercase class prefix, such as salt");
const neutralValue = z.string().max(32).regex(/^(-?\d+(\.\d+)?%?|[a-z][a-z-]*|[a-z]+[A-Z][A-Za-z]*)$/, "must be a CSS keyword or a plain number");
const propName = z.string().max(80).regex(/^[A-Za-z_$][A-Za-z0-9_$]*(-[A-Za-z0-9_$]+)*$/, "must be a prop name, such as appearance or aria-label");
const propValue = z.string().max(64).regex(/^-?[A-Za-z0-9_][A-Za-z0-9_.:/-]*$/, "must be a plain literal, such as solid, 2, or true");
const itemId = z.string().max(160).regex(/^[a-z0-9][a-z0-9_-]*(\.[a-z0-9_-]+)*$/, "must be a dotted lowercase id");
const region = z.string().max(64).regex(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/, "must be a lowercase region name");
const digest = z.string().regex(/^[0-9a-f]{64}$/, "must be a SHA-256 digest");
const timestamp = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/, "must be a UTC timestamp such as 2026-03-31T14:17:19.965Z");
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be a date such as 2026-03-31");
/** Displayed text: one line, no control characters. Surveyor never reads it. */
const prose = z
  .string()
  .min(1)
  .max(4000)
  .regex(/^[^\p{Cc}]+$/u, "must be one line of text");
const list = <T extends z.ZodType>(item: T, max = MAX_ITEMS) => z.array(item).max(max);

/** A source supplies sections: a package at its version, a design system's published data, or the team's rules (version `sha256:<digest>`). */
const sourceSchema = z.strictObject({
  name: z.union([packageName, z.string().regex(/^catalog-rules\/[a-z][a-z0-9-]*\.yaml$/, "must be a package name or catalog-rules/<id>.yaml")]),
  version: z.union([version, z.string().regex(/^sha256:[0-9a-f]{64}$/, "must be a version or sha256:<digest>")]),
  /** For data built from a snapshot rather than a release, the snapshot's date. */
  snapshot_date: date.optional(),
  /** The content sections it supplied; empty for a source that supplied only a version, as for the reserved kinds. */
  sections: list(z.string().max(64).regex(/^[a-z][a-z_]*$/, "must be a section name"), 64),
});

const packageSchema = z.strictObject({
  name: packageName,
  /** The version the entry was built from, when a source supplied it. */
  version: version.optional(),
});

const propSchema = z.strictObject({
  name: propName,
  /** The prop's literal values, when the declarations allow only a finite set. */
  values: list(propValue, 256).min(1).optional(),
  deprecated: z.literal(true).optional(),
});

/** What a design system offers. Every section is optional: an entry lists what its sources provide. */
export const designSystemContentSchema = z.strictObject({
  name: label,
  token_prefix: tokenPrefix.optional(),
  class_prefix: classPrefix.optional(),
  /** Stylesheet imports that apply the theme, such as `@salt-ds/theme/index.css`. */
  theme_stylesheets: list(moduleName, 64).optional(),
  /** Components that provide the theme; rendering any of them counts. */
  providers: list(z.strictObject({ package: packageName, component }), 64).optional(),
  /** Components, the package each comes from, and their props. Any export of the entry's packages counts as a component. */
  components: list(z.strictObject({ name: component, package: packageName, props: list(propSchema, 512) })).optional(),
  tokens: list(z.strictObject({ name: token, deprecated: z.literal(true).optional() })).optional(),
  icons: list(z.strictObject({ name: component, package: packageName })).optional(),
  patterns: list(
    z.strictObject({
      id: itemId,
      name: prose,
      summary: prose.optional(),
      composed_of: list(component, 256),
      regions: list(region, 64),
    }),
    1_000,
  ).optional(),
  deprecations: list(
    z.strictObject({
      id: itemId,
      package: packageName,
      kind: z.enum(["component", "prop", "type"]),
      component: component.optional(),
      name: identifier,
      deprecated_in: version,
      removed_in: version.optional(),
      replacement: identifier.optional(),
      notes: prose.optional(),
    }),
    5_000,
  ).optional(),
  guidance: z
    .strictObject({
      components: list(z.strictObject({ component, summary: prose.optional(), when_to_use: list(prose, 64), when_not_to_use: list(prose, 64) }), 5_000),
      guides: list(z.strictObject({ id: itemId, name: prose, summary: prose }), 1_000),
    })
    .optional(),
  /** The component each intrinsic tag can be replaced by. */
  equivalents: list(z.strictObject({ tag, package: packageName, component }), 512).optional(),
  /** Tags that are acceptable when unstyled, and replaceable by a layout component when they only lay out. */
  neutral_tags: list(tag, 512).optional(),
  /** Values that need no token, such as `inherit`, `auto`, `0`, and `100%`. */
  neutral_values: list(neutralValue, 512).optional(),
  /** CSS properties by family; each property is in at most one. Unlisted properties are in the family `other`. */
  property_families: z.record(family, list(property, 1_000).min(1)).optional(),
  /** Props through which a component renders a caller's element as its own root, such as Salt's `render`. */
  render_props: list(propName, 64).optional(),
});

const identity = {
  schema: z.literal(ENTRY_SCHEMA),
  format_version: z.literal(ENTRY_FORMAT_VERSION),
  id: entryId,
  /** The thing's version: the version of its first package. */
  version,
  /** The packages the entry applies to. The first is the thing's own, whose version the entry carries. */
  packages: list(packageSchema, 256).min(1),
  built_at: timestamp,
  sources: list(sourceSchema, 64).min(1),
  digest,
};

export const designSystemEntrySchema = z.strictObject({ ...identity, kind: z.literal("design_system"), content: designSystemContentSchema });
/** Runtime APIs and composition contracts are reserved: format version 1 defines no content for them. */
const reservedEntrySchema = (kind: "runtime_api" | "composition_contract") => z.strictObject({ ...identity, kind: z.literal(kind), content: z.strictObject({}) });

export const referenceCatalogEntrySchema = z.discriminatedUnion("kind", [designSystemEntrySchema, reservedEntrySchema("runtime_api"), reservedEntrySchema("composition_contract")]);

export type ReferenceCatalogEntry = z.output<typeof referenceCatalogEntrySchema>;
export type DesignSystemEntry = Extract<ReferenceCatalogEntry, { kind: "design_system" }>;
export type DesignSystemContent = z.output<typeof designSystemContentSchema>;
export type EntrySource = z.output<typeof sourceSchema>;
export type EntryPackage = z.output<typeof packageSchema>;
/** An entry before its digest is computed. */
export type UnsealedEntry = Omit<DesignSystemEntry, "digest"> | Omit<Exclude<ReferenceCatalogEntry, DesignSystemEntry>, "digest">;

/** The SHA-256 of an entry's canonical JSON, leaving out `digest` and `built_at`. */
export function entryDigest(entry: UnsealedEntry | ReferenceCatalogEntry): string {
  const { digest: _digest, built_at: _builtAt, ...rest } = entry as ReferenceCatalogEntry;
  return sha256(dump(rest));
}

/** The entry with its digest. */
export function sealEntry(entry: UnsealedEntry): ReferenceCatalogEntry {
  return { ...entry, digest: entryDigest(entry) } as ReferenceCatalogEntry;
}

/** An entry's canonical JSON: sorted keys and no insignificant whitespace, as stored. */
export function canonicalEntry(entry: ReferenceCatalogEntry): string {
  return dump(entry);
}

/** What an entry says about itself, read without validating it, for diagnostics. */
export interface EntryLabel {
  kind: string | null;
  id: string | null;
  version: string | null;
  format_version: number | null;
}

export function entryLabel(value: unknown): EntryLabel {
  const record = typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const text = (key: string) => (typeof record[key] === "string" ? (record[key] as string).slice(0, 80) : null);
  return { kind: text("kind"), id: text("id"), version: text("version"), format_version: Number.isSafeInteger(record.format_version) ? (record.format_version as number) : null };
}

/** `salt 1.75.0`, or what can be read of it. */
export function describeEntry(label: EntryLabel): string {
  return [label.id ?? "an unnamed entry", label.version].filter(Boolean).join(" ");
}

export type EntryReadResult = { ok: true; entry: ReferenceCatalogEntry } | { ok: false; reason: "unsupported_entry_format" | "invalid_entry"; detail: string; label: EntryLabel };

/**
 * Reads a stored entry. An entry of another schema or format version is
 * unsupported and never interpreted; an entry of this format that fails
 * validation is invalid.
 */
export function readEntry(value: unknown): EntryReadResult {
  const label = entryLabel(value);
  const record = typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  if (record.schema !== ENTRY_SCHEMA || record.format_version !== ENTRY_FORMAT_VERSION) {
    const format = record.schema === ENTRY_SCHEMA ? `format version ${label.format_version ?? JSON.stringify(record.format_version ?? null)}` : `schema ${JSON.stringify(typeof record.schema === "string" ? record.schema.slice(0, 80) : (record.schema ?? null))}`;
    return { ok: false, reason: "unsupported_entry_format", detail: `Reference Catalog entry ${describeEntry(label)} has ${format}; this release reads ${ENTRY_SCHEMA} format version ${ENTRY_FORMAT_VERSION}`, label };
  }
  const problems = entryProblems(value);
  if (problems.length) return { ok: false, reason: "invalid_entry", detail: `Reference Catalog entry ${describeEntry(label)} is invalid: ${problems.slice(0, 3).join("; ")}`, label };
  return { ok: true, entry: value as ReferenceCatalogEntry };
}

/** Each value that appears more than once in +values+. */
function duplicates(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const value of values) (seen.has(value) ? repeated : seen).add(value);
  return [...repeated].sort();
}

/**
 * Structural and semantic validation of an entry. Returns every problem
 * found, or an empty list. Beyond the schema:
 * - the first package carries the entry's version, and packages are unique;
 * - every content section is supplied by exactly one source, and no source claims a section the content lacks;
 * - references between sections name the entry's packages and components;
 * - the digest matches the content.
 */
export function entryProblems(value: unknown): string[] {
  const parsed = referenceCatalogEntrySchema.safeParse(value);
  if (!parsed.success) return parsed.error.issues.map((issue) => `${issue.path.join(".") || "entry"}: ${issue.message}`);
  const entry = parsed.data;
  const problems: string[] = [];

  const [first] = entry.packages;
  if (first!.version !== entry.version) problems.push(`packages: the first package, ${first!.name}, must carry the entry's version ${entry.version}`);
  for (const name of duplicates(entry.packages.map((item) => item.name))) problems.push(`packages: ${name} is listed more than once`);
  for (const name of duplicates(entry.sources.map((source) => source.name))) problems.push(`sources: ${name} is listed more than once`);

  const present = Object.keys(entry.content);
  const claimed = entry.sources.flatMap((source) => source.sections);
  for (const section of duplicates(claimed)) problems.push(`sources: more than one source supplies ${section}`);
  for (const section of present) if (!claimed.includes(section)) problems.push(`sources: no source supplies ${section}`);
  for (const section of new Set(claimed)) if (!present.includes(section)) problems.push(`sources: ${section} is claimed but the content has no such section`);

  if (entry.kind === "design_system") problems.push(...designSystemProblems(entry));
  if (entry.digest !== entryDigest(entry)) problems.push("digest: does not match the entry's content");
  return problems;
}

function designSystemProblems(entry: DesignSystemEntry): string[] {
  const problems: string[] = [];
  const report = (message: string) => problems.push(message);
  const { content } = entry;
  const packages = new Set(entry.packages.map((item) => item.name));
  const inPackage = (name: string, where: string) => {
    if (!packages.has(name)) report(`${where} names ${name}, which is not one of the entry's packages`);
  };
  const components = new Set((content.components ?? []).map((item) => `${item.package} ${item.name}`));
  const isComponent = (packageName: string, name: string, where: string) => {
    inPackage(packageName, where);
    if (content.components?.some((item) => item.package === packageName) && !components.has(`${packageName} ${name}`)) report(`${where} names ${name}, which ${packageName} does not list`);
  };

  for (const name of duplicates([...components])) report(`components: ${name} is listed more than once`);
  for (const item of content.components ?? []) {
    inPackage(item.package, `components.${item.name}`);
    for (const name of duplicates(item.props.map((prop) => prop.name))) report(`components.${item.name}: prop ${name} is listed more than once`);
    for (const prop of item.props) for (const value of duplicates(prop.values ?? [])) report(`components.${item.name}.${prop.name}: value ${value} is listed more than once`);
  }
  for (const provider of content.providers ?? []) isComponent(provider.package, provider.component, "a provider");
  for (const equivalent of content.equivalents ?? []) isComponent(equivalent.package, equivalent.component, `the equivalent for ${equivalent.tag}`);
  for (const name of duplicates((content.equivalents ?? []).map((item) => item.tag))) report(`equivalents: tag ${name} has more than one equivalent`);
  for (const name of duplicates(content.neutral_tags ?? [])) report(`neutral_tags: ${name} is listed more than once`);
  for (const name of content.neutral_tags ?? []) if (content.equivalents?.some((item) => item.tag === name)) report(`neutral_tags: ${name} is both neutral and replaced by a component`);
  for (const name of duplicates(content.neutral_values ?? [])) report(`neutral_values: ${name} is listed more than once`);
  for (const name of duplicates(content.render_props ?? [])) report(`render_props: ${name} is listed more than once`);
  for (const stylesheet of content.theme_stylesheets ?? []) if (![...packages].some((name) => stylesheet.startsWith(`${name}/`))) report(`theme_stylesheets: ${stylesheet} is not in one of the entry's packages`);
  for (const name of duplicates(content.theme_stylesheets ?? [])) report(`theme_stylesheets: ${name} is listed more than once`);

  const families = Object.entries(content.property_families ?? {});
  for (const name of duplicates(families.flatMap(([, properties]) => properties))) report(`property_families: ${name} is in more than one family, or listed twice`);
  if (content.property_families && Object.hasOwn(content.property_families, "other")) report("property_families: the family other holds every unlisted property and can't be listed");

  for (const name of duplicates((content.tokens ?? []).map((item) => item.name))) report(`tokens: ${name} is listed more than once`);
  if (content.tokens?.length && !content.token_prefix) report("tokens: an entry that lists tokens names their token_prefix");
  for (const item of content.tokens ?? []) if (content.token_prefix && !item.name.startsWith(content.token_prefix)) report(`tokens: ${item.name} does not carry the prefix ${content.token_prefix}`);
  for (const item of content.icons ?? []) inPackage(item.package, `icons.${item.name}`);
  for (const name of duplicates((content.icons ?? []).map((item) => `${item.package} ${item.name}`))) report(`icons: ${name} is listed more than once`);
  for (const name of duplicates((content.patterns ?? []).map((item) => item.id))) report(`patterns: ${name} is listed more than once`);
  for (const name of duplicates((content.deprecations ?? []).map((item) => item.id))) report(`deprecations: ${name} is listed more than once`);
  return problems;
}
