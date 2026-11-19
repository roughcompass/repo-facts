import { type DesignSystemEntry, type DetectorContext, compareCodeUnits } from "@repo-facts/contract";
import { type InventoryInput, inventoryOf } from "@repo-facts/core";
import { ADAPTERS } from "./adapters.generated.js";
import type { AdapterCatalog } from "./catalog-schema.js";

/**
 * What the design-system detectors know about a design system: the parts of
 * one Reference Catalog entry they compare code against. Names are compared
 * for equality and packages by prefix; nothing in an entry becomes a pattern.
 */

/** One design system at the version a repository uses, read from its entry. */
export interface Catalog {
  id: string;
  name: string;
  /** The entry this was read from. */
  entry: { version: string; format_version: number; digest: string };
  /** Package names. Any export of these packages, or their subpaths, is a design-system component. */
  packages: readonly string[];
  providers: readonly { package: string; component: string }[];
  theme_stylesheets: readonly string[];
  token_prefix: string | null;
  class_prefix: string | null;
  equivalents: readonly { tag: string; package: string; component: string }[];
  neutral_tags: readonly string[];
  neutral_values: readonly string[];
  property_families: Readonly<Record<string, readonly string[]>>;
  tokens: readonly string[];
  render_props: readonly string[];
  /** The literal values of each prop that allows only a finite set, by component as `package Name`, then prop. */
  finite_props: ReadonlyMap<string, ReadonlyMap<string, readonly string[]>>;
}

/** The parts of +entry+ the detectors compare against. */
export function catalogFromEntry(entry: DesignSystemEntry): Catalog {
  const { content } = entry;
  const finite = new Map<string, Map<string, readonly string[]>>();
  for (const component of content.components ?? []) {
    const props = new Map(component.props.flatMap((prop) => (prop.values ? [[prop.name, prop.values] as const] : [])));
    if (props.size) finite.set(`${component.package} ${component.name}`, props);
  }
  return {
    id: entry.id,
    name: content.name,
    entry: { version: entry.version, format_version: entry.format_version, digest: entry.digest },
    packages: entry.packages.map((item) => item.name),
    providers: content.providers ?? [],
    theme_stylesheets: content.theme_stylesheets ?? [],
    token_prefix: content.token_prefix ?? null,
    class_prefix: content.class_prefix ?? null,
    equivalents: content.equivalents ?? [],
    neutral_tags: content.neutral_tags ?? [],
    neutral_values: content.neutral_values ?? [],
    property_families: content.property_families ?? {},
    tokens: (content.tokens ?? []).map((token) => token.name),
    render_props: content.render_props ?? [],
    finite_props: finite,
  };
}

/** Whether +module+ is +packageName+ or one of its subpaths. */
export function inPackage(module: string, packageName: string): boolean {
  return module === packageName || module.startsWith(`${packageName}/`);
}

/** The design systems a repository is compared against, and the compiled styling adapters. */
export interface Catalogs {
  catalogs: readonly Catalog[];
  adapters: AdapterCatalog;
}

/** The catalogs for +catalogs+, with the adapters compiled into this release. */
export function catalogsWith(catalogs: readonly Catalog[]): Catalogs {
  return { catalogs, adapters: ADAPTERS };
}

/** The catalog, and its package, that +module+ belongs to. */
export function catalogOf(catalogs: Catalogs, module: string): { catalog: Catalog; packageName: string } | null {
  for (const catalog of catalogs.catalogs) {
    const packageName = catalog.packages.find((candidate) => inPackage(module, candidate));
    if (packageName) return { catalog, packageName };
  }
  return null;
}

/** The UI library +module+ belongs to, when it's one the adapter catalog lists. */
export function uiLibraryOf(catalogs: Catalogs, module: string): string | null {
  return catalogs.adapters.ui_libraries.find((name) => inPackage(module, name)) ?? null;
}

/** A stylesheet import specifier as a module name: webpack's `~` prefix is dropped. */
export function stylesheetModule(url: string): string {
  return url.startsWith("~") ? url.slice(1) : url;
}

/** JavaScript and TypeScript sources, and supported stylesheets, in path order, excluding vendored code. */
export function designSystemInputs(context: DetectorContext): { sources: string[]; stylesheets: InventoryInput[]; unsupportedStylesheets: InventoryInput[] } {
  const inventory = inventoryOf(context);
  const stylesheets = inventory.inputs.filter((input) => input.kind === "stylesheet").sort((a, b) => compareCodeUnits(a.path, b.path));
  return {
    sources: [...inventory.sources].sort(compareCodeUnits),
    stylesheets: stylesheets.filter((input) => input.supported),
    unsupportedStylesheets: stylesheets.filter((input) => !input.supported),
  };
}
