import { StructuredParseError, compareCodeUnits, digestOf, dump, parseCanonical, parseYaml } from "@repo-facts/contract";
import { type AdapterCatalog, adapterCatalogSchema } from "./catalog-schema.js";

/**
 * Compiles the adapter catalog (YAML text) into validated, canonical data.
 * Every problem is reported together. Lists are sorted, so the compiled data
 * and its digest depend only on what the file says, not on how it's ordered.
 */

export interface CatalogSource {
  path: string;
  text: string;
}

export type AdapterCompileResult = { ok: true; adapters: AdapterCatalog; digest: string } | { ok: false; problems: string[] };

const byCodeUnits = (a: string, b: string) => compareCodeUnits(a, b);
const sorted = (values: readonly string[]) => [...values].sort(byCodeUnits);

/** Compiles the adapter catalog. */
export function compileAdapters(source: CatalogSource): AdapterCompileResult {
  const problems: string[] = [];
  let document: unknown;
  try {
    document = parseYaml(source.text);
  } catch (error) {
    if (!(error instanceof StructuredParseError)) throw error;
    return { ok: false, problems: [`${source.path}: ${error.message}`] };
  }
  const parsed = adapterCatalogSchema.safeParse(document);
  if (!parsed.success) return { ok: false, problems: parsed.error.issues.map((issue) => `${source.path}: ${issue.path.join(".") || "(file)"}: ${issue.message}`) };
  checkAdapters(source.path, parsed.data, problems);
  if (problems.length) return { ok: false, problems };

  // Round-trip through canonical JSON so compiled adapters are plain, inert data.
  const adapters = parseCanonical(dump(normalizeAdapters(parsed.data))) as unknown as AdapterCatalog;
  return { ok: true, adapters, digest: adaptersDigest(adapters) };
}

export function adaptersDigest(adapters: AdapterCatalog): string {
  return digestOf({ adapters }).digest;
}

/** Each value that appears more than once in +values+. */
function duplicates(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const value of values) (seen.has(value) ? repeated : seen).add(value);
  return sorted([...repeated]);
}

function checkAdapters(path: string, adapters: AdapterCatalog, problems: string[]) {
  const report = (message: string) => problems.push(`${path}: ${message}`);
  for (const name of duplicates(adapters.adapters.map((adapter) => adapter.module))) report(`module ${name} is listed more than once`);
  for (const adapter of adapters.adapters) {
    for (const name of duplicates(adapter.exports.map((entry) => entry.name))) report(`export ${name} of ${adapter.module} is listed more than once`);
  }
  for (const name of duplicates(adapters.ui_libraries)) report(`UI library ${name} is listed more than once`);
}

function normalizeAdapters(adapters: AdapterCatalog): AdapterCatalog {
  return {
    ...adapters,
    adapters: [...adapters.adapters].sort((a, b) => compareCodeUnits(a.module, b.module)).map((adapter) => ({ module: adapter.module, exports: [...adapter.exports].sort((a, b) => compareCodeUnits(a.name, b.name)) })),
    ui_libraries: sorted(adapters.ui_libraries),
  };
}
