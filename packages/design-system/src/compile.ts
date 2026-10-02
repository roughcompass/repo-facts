import { StructuredParseError, compareCodeUnits, digestOf, dump, parseCanonical, parseYaml } from "@repo-facts/contract";
import type { z } from "zod";
import { type AdapterCatalog, type Catalog, adapterCatalogSchema, catalogSchema } from "./catalog-schema.js";

/**
 * Compiles catalog files (YAML text) into validated, canonical data. Every
 * problem across every file is reported together. Lists are sorted, so the
 * compiled data and its digest depend only on what the files say, not on how
 * they're ordered.
 */

export interface CatalogSource {
  path: string;
  text: string;
}

export type CatalogCompileResult = { ok: true; catalogs: Catalog[]; adapters: AdapterCatalog; digest: string } | { ok: false; problems: string[] };

const byCodeUnits = (a: string, b: string) => compareCodeUnits(a, b);
const sorted = (values: readonly string[]) => [...values].sort(byCodeUnits);

/** Compiles the design-system catalogs and the adapter catalog. */
export function compileCatalogs(input: { catalogs: readonly CatalogSource[]; adapters: CatalogSource }): CatalogCompileResult {
  const problems: string[] = [];
  const catalogs: Catalog[] = [];
  for (const source of [...input.catalogs].sort((a, b) => compareCodeUnits(a.path, b.path))) {
    const catalog = load(source, catalogSchema, problems);
    if (catalog) {
      checkCatalog(source.path, catalog, problems);
      catalogs.push(normalizeCatalog(catalog));
    }
  }
  const adapters = load(input.adapters, adapterCatalogSchema, problems);
  if (adapters) checkAdapters(input.adapters.path, adapters, catalogs, problems);
  checkAcrossCatalogs(catalogs, problems);
  if (problems.length || !adapters) return { ok: false, problems };

  catalogs.sort((a, b) => compareCodeUnits(a.id, b.id));
  // Round-trip through canonical JSON so compiled catalogs are plain, inert data.
  const data = parseCanonical(dump({ catalogs, adapters: normalizeAdapters(adapters) })) as unknown as { catalogs: Catalog[]; adapters: AdapterCatalog };
  return { ok: true, catalogs: data.catalogs, adapters: data.adapters, digest: catalogsDigest(data.catalogs, data.adapters) };
}

export function catalogsDigest(catalogs: readonly Catalog[], adapters: AdapterCatalog): string {
  return digestOf({ catalogs, adapters }).digest;
}

function load<T extends z.ZodType>(source: CatalogSource, schema: T, problems: string[]): z.output<T> | null {
  let document: unknown;
  try {
    document = parseYaml(source.text);
  } catch (error) {
    if (!(error instanceof StructuredParseError)) throw error;
    problems.push(`${source.path}: ${error.message}`);
    return null;
  }
  const parsed = schema.safeParse(document);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) problems.push(`${source.path}: ${issue.path.join(".") || "(file)"}: ${issue.message}`);
    return null;
  }
  return parsed.data;
}

/** Each value that appears more than once in +values+. */
function duplicates(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const value of values) (seen.has(value) ? repeated : seen).add(value);
  return sorted([...repeated]);
}

function checkCatalog(path: string, catalog: Catalog, problems: string[]) {
  const report = (message: string) => problems.push(`${path}: ${message}`);
  const packages = new Map(catalog.packages.map((entry) => [entry.name, entry]));
  for (const name of duplicates(catalog.packages.map((entry) => entry.name))) report(`package ${name} is listed more than once`);
  for (const name of duplicates(catalog.packages.flatMap((entry) => entry.components ?? []))) report(`component ${name} is listed more than once`);

  const isComponent = (packageName: string, component: string, where: string) => {
    const entry = packages.get(packageName);
    if (!entry) report(`${where} names ${packageName}, which is not one of the catalog's packages`);
    else if (entry.components && !entry.components.includes(component)) report(`${where} names ${component}, which ${packageName} does not list`);
  };
  for (const provider of catalog.providers) isComponent(provider.package, provider.component, "a provider");
  for (const name of duplicates(catalog.providers.map((provider) => `${provider.package} ${provider.component}`))) report(`provider ${name} is listed more than once`);
  for (const equivalent of catalog.equivalents) isComponent(equivalent.package, equivalent.component, `the equivalent for ${equivalent.tag}`);
  for (const tag of duplicates(catalog.equivalents.map((equivalent) => equivalent.tag))) report(`tag ${tag} has more than one equivalent`);
  for (const tag of duplicates(catalog.neutral_tags)) report(`neutral tag ${tag} is listed more than once`);
  for (const tag of catalog.neutral_tags) if (catalog.equivalents.some((equivalent) => equivalent.tag === tag)) report(`tag ${tag} is both neutral and replaced by a component`);
  for (const value of duplicates(catalog.neutral_values)) report(`neutral value ${value} is listed more than once`);

  for (const stylesheet of catalog.theme_stylesheets) {
    if (![...packages.keys()].some((name) => stylesheet.startsWith(`${name}/`))) report(`theme stylesheet ${stylesheet} is not in one of the catalog's packages`);
  }
  for (const stylesheet of duplicates(catalog.theme_stylesheets)) report(`theme stylesheet ${stylesheet} is listed more than once`);

  const families = Object.entries(catalog.property_families);
  for (const name of duplicates(families.flatMap(([, properties]) => properties))) report(`property ${name} is in more than one family, or listed twice`);
  if (Object.hasOwn(catalog.property_families, "other")) report("the family other holds every unlisted property and can't be listed");

  for (const name of duplicates(catalog.tokens)) report(`token ${name} is listed more than once`);
  for (const name of catalog.tokens) if (!name.startsWith(catalog.token_prefix)) report(`token ${name} does not carry the prefix ${catalog.token_prefix}`);
}

function checkAdapters(path: string, adapters: AdapterCatalog, catalogs: readonly Catalog[], problems: string[]) {
  const report = (message: string) => problems.push(`${path}: ${message}`);
  for (const name of duplicates(adapters.adapters.map((adapter) => adapter.module))) report(`module ${name} is listed more than once`);
  for (const adapter of adapters.adapters) {
    for (const name of duplicates(adapter.exports.map((entry) => entry.name))) report(`export ${name} of ${adapter.module} is listed more than once`);
  }
  for (const name of duplicates(adapters.ui_libraries)) report(`UI library ${name} is listed more than once`);
  const cataloged = new Set(catalogs.flatMap((catalog) => catalog.packages.map((entry) => entry.name)));
  for (const name of adapters.ui_libraries) if (cataloged.has(name)) report(`UI library ${name} is a cataloged design-system package`);
}

function checkAcrossCatalogs(catalogs: readonly Catalog[], problems: string[]) {
  for (const id of duplicates(catalogs.map((catalog) => catalog.id))) problems.push(`catalog ${id} is defined more than once`);
  for (const name of duplicates(catalogs.flatMap((catalog) => catalog.packages.map((entry) => entry.name)))) problems.push(`package ${name} is in more than one catalog`);
  for (const prefix of duplicates(catalogs.map((catalog) => catalog.token_prefix))) problems.push(`token prefix ${prefix} is used by more than one catalog`);
}

function normalizeCatalog(catalog: Catalog): Catalog {
  return {
    ...catalog,
    packages: [...catalog.packages].sort((a, b) => compareCodeUnits(a.name, b.name)).map((entry) => (entry.components ? { name: entry.name, components: sorted(entry.components) } : { name: entry.name })),
    providers: [...catalog.providers].sort((a, b) => compareCodeUnits(a.package, b.package) || compareCodeUnits(a.component, b.component)),
    theme_stylesheets: sorted(catalog.theme_stylesheets),
    equivalents: [...catalog.equivalents].sort((a, b) => compareCodeUnits(a.tag, b.tag)),
    neutral_tags: sorted(catalog.neutral_tags),
    neutral_values: sorted(catalog.neutral_values),
    property_families: Object.fromEntries(Object.entries(catalog.property_families).map(([name, properties]) => [name, sorted(properties)])),
    tokens: sorted(catalog.tokens),
  };
}

function normalizeAdapters(adapters: AdapterCatalog): AdapterCatalog {
  return {
    ...adapters,
    adapters: [...adapters.adapters].sort((a, b) => compareCodeUnits(a.module, b.module)).map((adapter) => ({ module: adapter.module, exports: [...adapter.exports].sort((a, b) => compareCodeUnits(a.name, b.name)) })),
    ui_libraries: sorted(adapters.ui_libraries),
  };
}
