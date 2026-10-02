import { type DetectorContext, compareCodeUnits } from "@repo-facts/contract";
import { type InventoryInput, inventoryOf } from "@repo-facts/core";
import type { AdapterCatalog, Catalog } from "./catalog-schema.js";
import { ADAPTERS, CATALOGS } from "./catalogs.generated.js";

/**
 * Lookups into the compiled catalogs, and the inputs the design-system
 * detectors read. Names are compared for equality and packages by prefix;
 * nothing in a catalog becomes a pattern.
 */

/** Whether +module+ is +packageName+ or one of its subpaths. */
export function inPackage(module: string, packageName: string): boolean {
  return module === packageName || module.startsWith(`${packageName}/`);
}

export interface Catalogs {
  catalogs: readonly Catalog[];
  adapters: AdapterCatalog;
}

export const SHIPPED: Catalogs = { catalogs: CATALOGS, adapters: ADAPTERS };

/** The catalog, and its package, that +module+ belongs to. */
export function catalogOf(catalogs: Catalogs, module: string): { catalog: Catalog; packageName: string } | null {
  for (const catalog of catalogs.catalogs) {
    const entry = catalog.packages.find((candidate) => inPackage(module, candidate.name));
    if (entry) return { catalog, packageName: entry.name };
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
