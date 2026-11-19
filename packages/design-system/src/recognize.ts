import { type DesignSystemEntry, type Detector, type DetectorContext, type Evidence, type JsonObject, compareCodeUnits, pointerOf, readEntry, selectEntry } from "@repo-facts/contract";
import { DEPENDENCY_FIELDS, type Manifest, type ResolvedVersion, isObject, manifestsOf, resolutionsOf } from "@repo-facts/core";
import { type SyntaxTree, nodeEvidence, resolveTag, stylesheetOf, syntaxOf } from "@repo-facts/syntax";
import semver from "semver";
import ts from "typescript";
import { type Catalog, catalogFromEntry, designSystemInputs, inPackage, stylesheetModule } from "./catalog.js";

/**
 * Which design systems a repository uses, recognized only through the
 * Reference Catalog entries supplied for the survey: the packages its
 * manifests declare, whether any source file or stylesheet imports one or a
 * theme stylesheet, and whether any source file renders a provider. A
 * repository with none of these, after a complete search, reports the
 * category absent. With no design-system entries supplied, nothing can be
 * recognized, so the search isn't complete and the category stays unknown.
 *
 * Each design system the repository uses is then compared against one entry:
 * the one `selectEntry` picks for the version the repository wants, which is
 * the version its lockfile resolves, else the highest version its declared
 * range allows, else none (the newest entry).
 */

export const RECOGNIZE = "design-system.recognize";

/** What recognition hands to later detectors: the design systems the repository uses, each at the entry selected for it, in id order. */
export interface Recognized {
  used: Catalog[];
}

/** One design system, as every supplied entry of it describes it. */
interface Described {
  id: string;
  name: string;
  entries: DesignSystemEntry[];
  /** Its packages: the newest entry's in order, then any only older entries list. */
  packages: string[];
  providers: { package: string; component: string }[];
  themes: string[];
}

interface Sighting {
  packages: { name: string; range: string; manifest: string; field: string }[];
  declared: Evidence | null;
  imported: Evidence | null;
  /** The first import of each theme stylesheet, by module, in path order. */
  themes: Map<string, Evidence>;
  /** The first rendering of each provider, as `package Component`, in path order. */
  providers: Map<string, Evidence>;
}

export function recognizeDetector(entries: readonly unknown[] = []): Detector {
  return {
    id: RECOGNIZE,
    version: "3",
    stage: "architecture",
    inputs: ["**/package.json", "**/package-lock.json", "**/npm-shrinkwrap.json", "**/pnpm-lock.yaml", "**/yarn.lock", "**/*.js", "**/*.jsx", "**/*.mjs", "**/*.cjs", "**/*.ts", "**/*.tsx", "**/*.mts", "**/*.cts", "**/*.css", "**/*.scss", "**/*.less"],
    categories: ["design_systems"],
    async run(context) {
      const described = describedSystems(context, entries);
      const owners = packageOwners(context, described);
      const ownerOf = (module: string) => {
        for (const [name, owner] of owners) if (inPackage(module, name)) return { owner, packageName: name };
        return null;
      };

      const sightings = new Map<string, Sighting>();
      const sighting = (system: Described) => {
        let found = sightings.get(system.id);
        if (!found) sightings.set(system.id, (found = { packages: [], declared: null, imported: null, themes: new Map(), providers: new Map() }));
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
            const found = ownerOf(name);
            if (typeof range !== "string" || !found || found.packageName !== name) continue;
            const seen = sighting(found.owner);
            seen.packages.push({ name, range, manifest: manifest.path, field });
            seen.declared ??= context.pointer(manifest.content, RECOGNIZE, "json", pointerOf([field, name]));
          }
        }
      }

      const { sources, stylesheets } = designSystemInputs(context);
      const imported = (module: string, evidence: () => Evidence) => {
        const found = ownerOf(module);
        if (!found) return;
        const seen = sighting(found.owner);
        seen.imported ??= evidence();
        if (found.owner.themes.includes(module) && !seen.themes.has(module)) seen.themes.set(module, evidence());
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
          for (const system of described) {
            const key = `${reference.module} ${reference.members[0]}`;
            if (system.providers.some((provider) => `${provider.package} ${provider.component}` === key) && !sighting(system).providers.has(key)) sighting(system).providers.set(key, nodeEvidence(context, tree, node, RECOGNIZE));
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

      const resolutions = resolutionsOf(context);
      const used: Catalog[] = [];
      for (const system of described) {
        const found = sightings.get(system.id);
        if (!found) continue;
        const wanted = wantedVersion(system, manifests, resolutions);
        const entry = selectEntry(system.entries, { kind: "design_system", id: system.id, package: wanted.package, version: wanted.version });
        const catalog = entry ? catalogFromEntry(entry) : null;
        if (catalog) used.push(catalog);
        context.catalogEntry({ kind: "design_system", id: system.id, version: entry?.version ?? null, format_version: entry?.format_version ?? null, digest: entry?.digest ?? null, wanted });

        // The theme stylesheets and providers of the entry in use; every entry's, when none applies.
        const themes = catalog?.theme_stylesheets ?? system.themes;
        const providers = (catalog?.providers ?? system.providers).map((provider) => `${provider.package} ${provider.component}`);
        const theme = [...found.themes].find(([module]) => themes.includes(module))?.[1] ?? null;
        const provider = [...found.providers].find(([key]) => providers.includes(key))?.[1] ?? null;
        const value: JsonObject = {
          catalog: system.id,
          name: catalog?.name ?? system.name,
          entry: entry ? { version: entry.version, digest: entry.digest } : null,
          packages: found.packages,
          imported: found.imported !== null,
          theme_stylesheet: theme !== null,
          provider: provider !== null,
        };
        const samples = found.declared ? [found.declared, theme, provider, found.imported] : [found.imported, theme, provider];
        context.fact({ category: "design_systems", key: system.id, value, basis: "observed", evidence: samples.filter((item): item is Evidence => item !== null).slice(0, 3), rule: RECOGNIZE });
      }

      // The usage detector compares against the entries selected here.
      context.shared.set(RECOGNIZE, { used } satisfies Recognized);

      if (!described.length) context.diagnostic("", "no_catalog_entries", "No Reference Catalog entries for design systems were supplied, so no design system could be recognized");
      const surface = [...manifests.map((manifest) => manifest.path), ...unanalyzed, ...sources, ...stylesheets.map((input) => input.path)];
      context.search({ category: "design_systems", rule: RECOGNIZE, surface: [...new Set(surface)].sort(compareCodeUnits), complete: described.length > 0, skipped: [...new Set(skipped)].sort(compareCodeUnits) });
    },
  };
}

/**
 * The design systems the supplied entries describe, in id order. An entry in
 * a format this release doesn't read, or that fails validation, isn't used,
 * and a diagnostic names it. Entries of other kinds aren't design systems.
 */
function describedSystems(context: DetectorContext, supplied: readonly unknown[]): Described[] {
  const byId = new Map<string, DesignSystemEntry[]>();
  for (const value of supplied) {
    const read = readEntry(value);
    if (!read.ok) {
      context.diagnostic("", read.reason, read.detail);
      continue;
    }
    if (read.entry.kind !== "design_system") continue;
    byId.set(read.entry.id, [...(byId.get(read.entry.id) ?? []), read.entry]);
  }
  return [...byId.entries()]
    .sort(([a], [b]) => compareCodeUnits(a, b))
    .map(([id, entries]) => {
      const newest = [...entries].sort((a, b) => semver.compare(b.version, a.version) || compareCodeUnits(b.built_at, a.built_at))[0]!;
      const unique = <T>(items: readonly T[], key: (item: T) => string) => [...new Map(items.map((item) => [key(item), item])).values()];
      const others = entries.flatMap((entry) => entry.packages.map((item) => item.name)).filter((name) => !newest.packages.some((item) => item.name === name));
      return {
        id,
        name: newest.content.name,
        entries,
        packages: [...newest.packages.map((item) => item.name), ...[...new Set(others)].sort(compareCodeUnits)],
        providers: unique(entries.flatMap((entry) => entry.content.providers ?? []), (provider) => `${provider.package} ${provider.component}`),
        themes: [...new Set(entries.flatMap((entry) => entry.content.theme_stylesheets ?? []))],
      };
    });
}

/** Each package to the design system whose entries list it. A package two design systems claim goes to the first by id, with a diagnostic. */
function packageOwners(context: DetectorContext, described: readonly Described[]): Map<string, Described> {
  const owners = new Map<string, Described>();
  for (const system of described) {
    for (const name of system.packages) {
      const owner = owners.get(name);
      if (owner) context.diagnostic("", "conflicting_catalog_entries", `Both ${owner.id} and ${system.id} entries list ${name}; it's counted as ${owner.id}`);
      else owners.set(name, system);
    }
  }
  return owners;
}

/**
 * The version of +system+ the repository wants, and the package it's read
 * from: the highest version a lockfile resolves for the first of its
 * packages that any lockfile resolves; else, for the first of its packages
 * any manifest declares, the highest version a declared range allows among
 * the versions the entries record, or the lowest version the range allows
 * when no entry is in range. Packages are tried in the order the newest entry
 * lists them, so the design system's own package comes first. With neither,
 * no version is wanted, and the newest entry applies.
 */
export function wantedVersion(system: Pick<Described, "entries" | "packages">, manifests: readonly Manifest[], resolutions: readonly ResolvedVersion[]): { package: string; version: string | null } {
  const highest = (versions: readonly string[]) => [...versions].sort(semver.rcompare)[0] ?? null;
  for (const name of system.packages) {
    const resolved = highest(resolutions.filter((resolution) => resolution.name === name).flatMap((resolution) => semver.valid(resolution.version) ?? []));
    if (resolved) return { package: name, version: resolved };
  }
  for (const name of system.packages) {
    const recorded = system.entries.flatMap((entry) => semver.valid(entry.packages.find((item) => item.name === name)?.version ?? "") ?? []);
    const allowed = manifests.flatMap((manifest) =>
      DEPENDENCY_FIELDS.flatMap((field) => {
        const declared = manifest.value[field];
        const specifier = isObject(declared) ? declared[name] : undefined;
        const range = typeof specifier === "string" && specifier.length <= 256 ? semver.validRange(specifier, { loose: true }) : null;
        if (range === null) return [];
        const inRange = highest(recorded.filter((version) => semver.satisfies(version, range)));
        return inRange ?? semver.minVersion(range)?.version ?? [];
      }),
    );
    const version = highest(allowed);
    if (version) return { package: name, version };
  }
  return { package: system.packages[0]!, version: null };
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
