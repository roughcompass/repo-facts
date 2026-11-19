import fs from "node:fs";
import path from "node:path";
import { type DesignSystemContent, type DesignSystemEntry, type EntrySource, type UnsealedEntry, digestOf, entryProblems, parseYaml, sealEntry } from "@repo-facts/contract";

/**
 * Reference Catalog entries for tests, converted from catalog fixtures: the
 * design-system catalog format that releases up to 0.6.0 compiled in, plus
 * `render_props` and the `props` of a few components. Releases no longer
 * contain catalogs; surveys are given entries, and these stand in for the
 * ones the Catalog Builder writes.
 *
 * The first package in `generated_from` is the design system's own, and its
 * version is the entry's. Its components come from it; tokens come from the
 * other generated package, when there is one; the curated sections come from
 * the team's rules.
 */

export const CATALOG_FIXTURES = import.meta.dirname;
export const FIXTURE_BUILT_AT = "2026-11-19T00:00:00.000Z";

interface CatalogFixture {
  id: string;
  name: string;
  generated_from: Record<string, string>;
  packages: { name: string; components?: string[] }[];
  providers?: { package: string; component: string }[];
  theme_stylesheets?: string[];
  token_prefix?: string;
  class_prefix?: string;
  equivalents?: { tag: string; package: string; component: string }[];
  neutral_tags?: string[];
  neutral_values?: string[];
  property_families?: Record<string, string[]>;
  tokens?: string[];
  render_props?: string[];
  props?: Record<string, Record<string, string[] | null>>;
}

/** The sections a catalog fixture's curated part supplies, in the order the old catalog listed them. */
export const CURATED_SECTIONS = ["name", "providers", "theme_stylesheets", "token_prefix", "class_prefix", "equivalents", "neutral_tags", "neutral_values", "property_families", "render_props"] as const;

/** The entry a catalog fixture's text describes. +change+ edits the entry before it's sealed. */
export function entryFromCatalog(text: string, change: (entry: UnsealedEntry & { content: DesignSystemContent }) => void = () => {}): DesignSystemEntry {
  const catalog = parseYaml(text) as unknown as CatalogFixture;
  const generated = Object.entries(catalog.generated_from);
  const [[ownPackage, version]] = generated as [[string, string]];
  const versions = new Map(generated);
  const names = [ownPackage, ...generated.slice(1).map(([name]) => name), ...catalog.packages.map((item) => item.name).filter((name) => !versions.has(name))];
  const tokensFrom = generated[1]?.[0] ?? ownPackage;

  const content: DesignSystemContent = {
    name: catalog.name,
    ...(catalog.providers?.length && { providers: catalog.providers }),
    ...(catalog.theme_stylesheets?.length && { theme_stylesheets: catalog.theme_stylesheets }),
    ...(catalog.token_prefix && { token_prefix: catalog.token_prefix }),
    ...(catalog.class_prefix && { class_prefix: catalog.class_prefix }),
    ...(catalog.equivalents && { equivalents: catalog.equivalents }),
    ...(catalog.neutral_tags && { neutral_tags: catalog.neutral_tags }),
    ...(catalog.neutral_values && { neutral_values: catalog.neutral_values }),
    ...(catalog.property_families && { property_families: catalog.property_families }),
    ...(catalog.render_props && { render_props: catalog.render_props }),
    components: catalog.packages.flatMap((item) =>
      (item.components ?? []).map((name) => ({
        name,
        package: item.name,
        props: Object.entries((item.name === ownPackage && catalog.props?.[name]) || {}).map(([prop, values]) => ({ name: prop, ...(values && { values: [...values].sort() }) })),
      })),
    ),
    ...(catalog.tokens && { tokens: catalog.tokens.map((token) => ({ name: token })) }),
  };
  const curated = CURATED_SECTIONS.filter((section) => section in content);
  const sources: EntrySource[] = [
    { name: ownPackage, version, sections: tokensFrom === ownPackage && content.tokens ? ["components", "tokens"] : ["components"] },
    ...generated.slice(1).map(([name, packageVersion]) => ({ name, version: packageVersion, sections: name === tokensFrom && content.tokens ? ["tokens"] : [] })),
    // Versioned by what the curated sections say, as the Catalog Builder versions rules, so comments don't matter.
    { name: `catalog-rules/${catalog.id}.yaml`, version: `sha256:${digestOf(Object.fromEntries(curated.map((section) => [section, content[section]]))).digest}`, sections: curated },
  ];
  const entry = {
    schema: "reference_catalog.entry",
    format_version: 1,
    kind: "design_system",
    id: catalog.id,
    version,
    packages: names.map((name) => (versions.has(name) ? { name, version: versions.get(name)! } : { name })),
    built_at: FIXTURE_BUILT_AT,
    sources,
    content,
  } as UnsealedEntry & { content: DesignSystemContent };
  change(entry);
  const sealed = sealEntry(entry) as DesignSystemEntry;
  const problems = entryProblems(sealed);
  if (problems.length) throw new Error(`The catalog fixture for ${catalog.id} ${version} isn't a valid entry:\n${problems.join("\n")}`);
  return sealed;
}

const cache = new Map<string, DesignSystemEntry>();

/** The entry for test/catalog/<name>.yaml, such as `salt-1.75.0`. */
export function fixtureEntry(name: string): DesignSystemEntry {
  let entry = cache.get(name);
  if (!entry) cache.set(name, (entry = entryFromCatalog(fs.readFileSync(path.join(CATALOG_FIXTURES, `${name}.yaml`), "utf8"))));
  return entry;
}

/** The names of every catalog fixture. */
export function fixtureNames(): string[] {
  return fs
    .readdirSync(CATALOG_FIXTURES)
    .filter((file) => file.endsWith(".yaml"))
    .map((file) => file.slice(0, -".yaml".length))
    .sort();
}

/** Every fixture entry: Salt 1.50.0 and 1.75.0, and MUI 6.1.0. Golden fixtures are surveyed with all of them. */
export function fixtureEntries(): DesignSystemEntry[] {
  return fixtureNames().map(fixtureEntry);
}
