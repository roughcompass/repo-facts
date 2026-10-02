import { type Detector, type Evidence, type JsonObject, compareCodeUnits, pointerOf } from "@repo-facts/contract";
import { DEPENDENCY_FIELDS, isObject, manifestsOf } from "@repo-facts/core";
import { type SyntaxTree, nodeEvidence, resolveTag, stylesheetOf, syntaxOf } from "@repo-facts/syntax";
import ts from "typescript";
import { type Catalogs, SHIPPED, catalogOf, designSystemInputs, stylesheetModule } from "./catalog.js";
import type { Catalog } from "./catalog-schema.js";

/**
 * Which design systems a repository uses, recognized only through catalogs:
 * the catalog packages its manifests declare, whether any source file or
 * stylesheet imports a catalog package or a theme stylesheet, and whether any
 * source file renders a provider. A repository with none of these, after a
 * complete search, reports the category absent.
 */

export const RECOGNIZE = "design-system.recognize";

/** What recognition hands to later detectors: the ids of the catalogs the repository uses. */
export interface Recognized {
  used: string[];
}

interface Sighting {
  packages: { name: string; range: string; manifest: string; field: string }[];
  declared: Evidence | null;
  imported: Evidence | null;
  theme: Evidence | null;
  provider: Evidence | null;
}

export function recognizeDetector(catalogs: Catalogs = SHIPPED): Detector {
  return {
    id: RECOGNIZE,
    version: "1",
    stage: "architecture",
    inputs: ["**/package.json", "**/*.js", "**/*.jsx", "**/*.mjs", "**/*.cjs", "**/*.ts", "**/*.tsx", "**/*.mts", "**/*.cts", "**/*.css"],
    categories: ["design_systems"],
    async run(context) {
      const sightings = new Map<string, Sighting>();
      const sighting = (catalog: Catalog) => {
        let found = sightings.get(catalog.id);
        if (!found) sightings.set(catalog.id, (found = { packages: [], declared: null, imported: null, theme: null, provider: null }));
        return found;
      };

      const { manifests, unanalyzed } = manifestsOf(context);
      const skipped = [...unanalyzed];
      for (const manifest of [...manifests].sort((a, b) => compareCodeUnits(a.path, b.path))) {
        for (const field of DEPENDENCY_FIELDS) {
          const declared = manifest.value[field];
          if (!isObject(declared)) continue;
          for (const name of Object.keys(declared).sort(compareCodeUnits)) {
            const range = declared[name];
            const owner = catalogOf(catalogs, name);
            if (typeof range !== "string" || !owner || owner.packageName !== name) continue;
            const found = sighting(owner.catalog);
            found.packages.push({ name, range, manifest: manifest.path, field });
            found.declared ??= context.pointer(manifest.content, RECOGNIZE, "json", pointerOf([field, name]));
          }
        }
      }

      const { sources, stylesheets } = designSystemInputs(context);
      const imported = (module: string, evidence: () => Evidence) => {
        const owner = catalogOf(catalogs, module);
        if (!owner) return;
        const found = sighting(owner.catalog);
        found.imported ??= evidence();
        if (owner.catalog.theme_stylesheets.includes(module)) found.theme ??= evidence();
      };

      for (const path of sources) {
        const tree = await syntaxOf(context, path);
        if (!tree) {
          skipped.push(path);
          continue;
        }
        for (const { module, node } of importsOf(tree)) imported(module, () => nodeEvidence(context, tree, node, RECOGNIZE));
        tree.walk((node) => {
          if (!ts.isJsxOpeningElement(node) && !ts.isJsxSelfClosingElement(node)) return;
          const reference = resolveTag(tree, node.tagName);
          if (reference.kind !== "module" || reference.members.length !== 1) return;
          for (const catalog of catalogs.catalogs) {
            if (catalog.providers.some((provider) => provider.package === reference.module && provider.component === reference.members[0])) sighting(catalog).provider ??= nodeEvidence(context, tree, node, RECOGNIZE);
          }
        });
      }

      for (const input of stylesheets) {
        const sheet = await stylesheetOf(context, input.path);
        if (!sheet) {
          skipped.push(input.path);
          continue;
        }
        for (const entry of sheet.stylesheet.imports) {
          const line = sheet.stylesheet.lineOf(entry.start);
          imported(stylesheetModule(entry.url), () => context.lines(sheet.content, RECOGNIZE, line, line));
        }
      }

      // The usage detector reads which design systems the repository uses.
      context.shared.set(RECOGNIZE, { used: catalogs.catalogs.filter((catalog) => sightings.has(catalog.id)).map((catalog) => catalog.id) } satisfies Recognized);

      for (const catalog of catalogs.catalogs) {
        const found = sightings.get(catalog.id);
        if (!found) continue;
        const value: JsonObject = {
          catalog: catalog.id,
          catalog_version: catalog.version,
          name: catalog.name,
          packages: found.packages,
          imported: found.imported !== null,
          theme_stylesheet: found.theme !== null,
          provider: found.provider !== null,
        };
        const samples = found.declared ? [found.declared, found.theme, found.provider, found.imported] : [found.imported, found.theme, found.provider];
        context.fact({ category: "design_systems", key: catalog.id, value, basis: "observed", evidence: samples.filter((item): item is Evidence => item !== null).slice(0, 3), rule: RECOGNIZE });
      }

      const surface = [...manifests.map((manifest) => manifest.path), ...unanalyzed, ...sources, ...stylesheets.map((input) => input.path)];
      context.search({ category: "design_systems", rule: RECOGNIZE, surface: [...new Set(surface)].sort(compareCodeUnits), complete: true, skipped: [...new Set(skipped)].sort(compareCodeUnits) });
    },
  };
}

/** Every module a file imports, re-exports, requires, or imports dynamically with a literal specifier. */
export function importsOf(tree: SyntaxTree): { module: string; node: ts.Node }[] {
  const found: { module: string; node: ts.Node }[] = [];
  tree.walk((node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      found.push({ module: node.moduleSpecifier.text, node });
    } else if (ts.isCallExpression(node) && node.arguments.length === 1) {
      const [argument] = node.arguments;
      const literal = argument && (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument));
      const callee = node.expression;
      if (literal && (callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === "require" && !tree.binding("require")))) found.push({ module: argument.text, node });
    }
  });
  return found;
}
