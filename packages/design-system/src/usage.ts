import { type Detector, type DetectorContext, type Evidence, type JsonObject, compareCodeUnits } from "@repo-facts/contract";
import { SYNTAX_LAYER, stylesheetOf, syntaxOf } from "@repo-facts/syntax";
import { type Catalogs, SHIPPED, designSystemInputs } from "./catalog.js";
import { type Catalog, LAYOUT_FAMILY } from "./catalog-schema.js";
import { type AppliedDeclaration, type ElementRecord, type FileAnalysis, MECHANISMS, type Mechanism, analyzeFile } from "./elements.js";
import { RECOGNIZE, type Recognized } from "./recognize.js";
import { SCOPES, type Scope, perScope, scopeOf } from "./scope.js";
import { type Site, StyleIndex } from "./styles.js";
import { VALUE_KINDS, ValueClassifier, type ValueKind } from "./values.js";

/**
 * How a repository uses its design systems, in one pass: every JSX element
 * classified where it's written, how design-system components are
 * customized, how intrinsic elements compare with the design system, and how
 * every style declaration's value is written.
 *
 * Counts are split by scope. Each fact cites at most SAMPLES evidence
 * records, the first in path and position order. Shares are whole numbers,
 * rounded down, and omitted when there's nothing to divide.
 */

export const USAGE = "design-system.usage";
export const SAMPLES = 3;

const RULES = {
  elements: "design-system.elements",
  layoutOnly: "design-system.layout-only",
  declarations: "design-system.declarations",
  aliases: "design-system.token-aliases",
  findings: "design-system.findings",
  summary: "design-system.summary",
} as const;

const OBSERVED_KINDS = VALUE_KINDS.filter((kind) => kind !== "token_alias") as Exclude<ValueKind, "token_alias">[];
const REASONING_LIMIT = 5;

/** Counts per scope for one fact key, with the sites it can cite. */
class Tally<T extends Record<string, unknown>> {
  readonly scopes: Record<Scope, T>;
  readonly sites: Site[] = [];

  constructor(make: () => T) {
    this.scopes = perScope(make);
  }

  samples(): Site[] {
    return [...this.sites].sort((a, b) => compareCodeUnits(a.path, b.path) || a.offset - b.offset).slice(0, SAMPLES);
  }
}

const counts = <const K extends string>(keys: readonly K[]) => () => Object.fromEntries(keys.map((key) => [key, 0])) as Record<K, number>;
const share = (part: number, whole: number) => (whole > 0 ? Math.floor((part * 100) / whole) : undefined);
const byKey = <V>(map: ReadonlyMap<string, V>) => [...map.entries()].sort(([a], [b]) => compareCodeUnits(a, b));

export function usageDetector(catalogs: Catalogs = SHIPPED): Detector {
  return {
    id: USAGE,
    version: "1",
    stage: "architecture",
    inputs: ["**/*.js", "**/*.jsx", "**/*.mjs", "**/*.cjs", "**/*.ts", "**/*.tsx", "**/*.mts", "**/*.cts", "**/*.css", "**/*.scss", "**/*.sass", "**/*.less"],
    categories: ["ui_elements", "style_values"],
    async run(context) {
      const recognized = context.shared.get(RECOGNIZE) as Recognized | undefined;
      const used = catalogs.catalogs.filter((catalog) => recognized?.used.includes(catalog.id));
      const primary = used[0] ?? catalogs.catalogs[0]!;
      const { sources, stylesheets, unsupportedStylesheets } = designSystemInputs(context);
      const skipped = unsupportedStylesheets.map((input) => input.path);

      const index = new StyleIndex(catalogs.catalogs, used);
      for (const input of stylesheets) {
        const sheet = await stylesheetOf(context, input.path);
        if (!sheet) {
          skipped.push(input.path);
          continue;
        }
        const { stylesheet } = sheet;
        index.add({ path: input.path, scope: scopeOf(input.path), content: sheet.content, kind: input.format === "css-module" ? "module" : "global", stylesheet, base: 0, lineAt: (offset) => stylesheet.lineOf(offset), interpolations: [] });
      }

      const files: FileAnalysis[] = [];
      for (const path of sources) {
        const tree = await syntaxOf(context, path);
        if (!tree) {
          skipped.push(path);
          continue;
        }
        const analysis = analyzeFile(tree, scopeOf(path), catalogs, index);
        for (const template of analysis.templates) index.add(template);
        // A template body over a stylesheet limit leaves the file partly unread.
        const [failure] = analysis.failures;
        if (failure) {
          context.diagnostic(path, failure.reason, `A styling-adapter template: ${failure.detail}`, { detector: SYNTAX_LAYER });
          skipped.push(path);
        }
        files.push(analysis);
      }

      const classifier = new ValueClassifier(primary, catalogs.catalogs, index);
      reportElements(context, files, used, primary, classifier);
      reportValues(context, index, files, used, classifier);

      const surface = [...sources, ...stylesheets.map((input) => input.path), ...unsupportedStylesheets.map((input) => input.path)].sort(compareCodeUnits);
      for (const category of ["ui_elements", "style_values"]) context.search({ category, rule: USAGE, surface, complete: true, skipped: [...new Set(skipped)].sort(compareCodeUnits) });
    },
  };
}

function evidenceOf(context: DetectorContext, sites: readonly Site[], rule: string): Evidence[] {
  return sites.map((site) => context.lines(site.content, rule, site.line, site.line));
}

function perScopeValue<T extends Record<string, unknown>>(tally: Tally<T>, shape: (counts: T) => JsonObject = (value) => value as JsonObject): JsonObject {
  return Object.fromEntries(SCOPES.map((scope) => [scope, shape(tally.scopes[scope])]));
}

const COMPONENT_COUNTS = ["sites", "as_is", "customized", "unknown"] as const;
const STYLE_STATES = ["resolved", "partial", "unresolved"] as const;
type ComponentCounts = Record<(typeof COMPONENT_COUNTS)[number], number> & { mechanisms: Record<Mechanism, number>; styles: Record<(typeof STYLE_STATES)[number], number> };
type IntrinsicCounts = { sites: number; unstyled: number; styled: number; custom_styled: number; styled_unresolved: number };
type SummaryCounts = { elements: number; design_system: number; customized: number; adoptable: number };

function reportElements(context: DetectorContext, files: readonly FileAnalysis[], used: readonly Catalog[], primary: Catalog, classifier: ValueClassifier) {
  const components = new Map<string, { package: string; tally: Tally<ComponentCounts> }>();
  const wrappers = new Map<string, Tally<{ definitions: number }>>();
  const intrinsic = new Map<string, { group: string; equivalent: string | null; tally: Tally<IntrinsicCounts> }>();
  const layoutOnly = new Map<string, { tally: Tally<{ sites: number }>; declarations: AppliedDeclaration[] }>();
  const libraries = new Map<string, Tally<{ sites: number }>>();
  const other = new Tally(counts(["sites"]));
  const summaries = new Map(used.map((catalog) => [catalog.id, new Tally<SummaryCounts>(counts(["elements", "design_system", "customized", "adoptable"]))]));
  const elementsByScope = perScope(() => 0);
  const allSites: Site[] = [];

  const equivalentOf = (tag: string) => {
    for (const catalog of used) {
      const equivalent = catalog.equivalents.find((candidate) => candidate.tag === tag);
      if (equivalent) return { system: catalog.id, name: equivalent.component };
    }
    return null;
  };

  for (const file of files) {
    for (const wrapper of file.wrappers) {
      const key = `wrapper:${wrapper.system}:${wrapper.name}`;
      const tally = wrappers.get(key) ?? new Tally(counts(["definitions"]));
      wrappers.set(key, tally);
      tally.scopes[wrapper.scope].definitions++;
      tally.sites.push(wrapper.site);
    }
    for (const record of file.elements) {
      elementsByScope[record.scope]++;
      allSites.push(record.site);
      const { element } = record;
      if (element.kind === "component") {
        const key = `component:${element.system}:${element.name}`;
        const entry = components.get(key) ?? { package: element.package, tally: new Tally<ComponentCounts>(() => ({ ...counts(COMPONENT_COUNTS)(), mechanisms: counts(MECHANISMS)(), styles: counts(STYLE_STATES)() })) };
        components.set(key, entry);
        const scoped = entry.tally.scopes[record.scope];
        entry.tally.sites.push(record.site);
        scoped.sites++;
        for (const mechanism of record.mechanisms) scoped.mechanisms[mechanism]++;
        const customized = record.mechanisms.size > 0;
        if (customized) {
          scoped.customized++;
          scoped.styles[styleState(record)]++;
        } else if (record.spread) scoped.unknown++;
        else scoped.as_is++;
        const summary = summaries.get(element.system);
        if (summary) {
          summary.scopes[record.scope].design_system++;
          if (customized) summary.scopes[record.scope].customized++;
          summary.sites.push(record.site);
        }
      } else if (element.kind === "intrinsic") {
        const equivalent = equivalentOf(element.tag);
        const group = equivalent ? "equivalent" : primary.neutral_tags.includes(element.tag) ? "neutral" : "other";
        const entry = intrinsic.get(element.tag) ?? { group, equivalent: equivalent ? `${equivalent.system}:${equivalent.name}` : null, tally: new Tally<IntrinsicCounts>(counts(["sites", "unstyled", "styled", "custom_styled", "styled_unresolved"])) };
        intrinsic.set(element.tag, entry);
        const scoped = entry.tally.scopes[record.scope];
        entry.tally.sites.push(record.site);
        scoped.sites++;
        const styled = record.mechanisms.size > 0 || record.spread;
        if (!styled) scoped.unstyled++;
        else scoped.styled++;
        if (group === "neutral" && styled) {
          const container = containerStyle(record, classifier);
          if (container.kind === "layout") {
            const layout = layoutOnly.get(element.tag) ?? { tally: new Tally(counts(["sites"])), declarations: [] };
            layoutOnly.set(element.tag, layout);
            layout.tally.scopes[record.scope].sites++;
            layout.tally.sites.push(record.site);
            layout.declarations.push(...container.declarations);
          } else if (container.kind === "custom") scoped.custom_styled++;
          else scoped.styled_unresolved++;
        }
        if (equivalent) {
          const summary = summaries.get(equivalent.system)!;
          summary.scopes[record.scope].adoptable++;
          summary.sites.push(record.site);
        }
      } else if (element.kind === "library") {
        const tally = libraries.get(element.package) ?? new Tally(counts(["sites"]));
        libraries.set(element.package, tally);
        tally.scopes[record.scope].sites++;
        tally.sites.push(record.site);
      } else {
        other.scopes[record.scope].sites++;
        other.sites.push(record.site);
      }
    }
  }

  const fact = (key: string, value: JsonObject, sites: readonly Site[], rule: string = RULES.elements) => context.fact({ category: "ui_elements", key, value, basis: "observed", evidence: evidenceOf(context, sites, rule), rule });
  for (const [key, entry] of byKey(components)) fact(key, { package: entry.package, ...perScopeValue(entry.tally) }, entry.tally.samples());
  for (const [key, tally] of byKey(wrappers)) fact(key, perScopeValue(tally), tally.samples());
  for (const [tag, entry] of byKey(intrinsic)) {
    const shape = (scoped: IntrinsicCounts): JsonObject => (entry.group === "neutral" ? scoped : { sites: scoped.sites, unstyled: scoped.unstyled, styled: scoped.styled });
    fact(`intrinsic:${tag}`, { group: entry.group, equivalent: entry.equivalent, ...perScopeValue(entry.tally, shape) }, entry.tally.samples());
  }
  for (const [tag, entry] of byKey(layoutOnly)) {
    const systems = used.map((catalog) => catalog.name);
    context.fact({
      category: "ui_elements",
      key: `layout-only:${tag}`,
      value: perScopeValue(entry.tally),
      basis: "inferred",
      evidence: evidenceOf(context, entry.tally.samples(), RULES.layoutOnly),
      rule: RULES.layoutOnly,
      reasoning: `Each of these <${tag}> elements is styled only with layout declarations, which ${systems.length ? `a ${systems.join(" or ")} layout component` : "a design-system layout component"} could apply instead: ${declarationList(entry.declarations)}.`,
    });
  }
  for (const [name, tally] of byKey(libraries)) fact(`library:${name}`, perScopeValue(tally), tally.samples());
  if (SCOPES.some((scope) => other.scopes[scope].sites > 0)) fact("other", perScopeValue(other), other.samples());

  if (!allSites.length) return;
  for (const [system, tally] of byKey(summaries)) {
    const samples = tally.sites.length ? tally.samples() : [...allSites].sort((a, b) => compareCodeUnits(a.path, b.path) || a.offset - b.offset).slice(0, SAMPLES);
    const value = Object.fromEntries(
      SCOPES.map((scope) => {
        const scoped = tally.scopes[scope];
        const summary: JsonObject = { elements: elementsByScope[scope], design_system: scoped.design_system };
        const customized = share(scoped.customized, scoped.design_system);
        const adoption = share(scoped.design_system, scoped.design_system + scoped.adoptable);
        if (customized !== undefined) summary.customized_share = customized;
        if (adoption !== undefined) summary.adoption_share = adoption;
        return [scope, summary];
      }),
    );
    fact(`summary:${system}`, value, samples, RULES.summary);
  }
}

/** Whether a customized component's styles were all, partly, or not at all traced to declarations. */
function styleState(record: ElementRecord): (typeof STYLE_STATES)[number] {
  const known = record.parts.filter((part) => part !== null).length;
  if (known === record.parts.length && !record.spread) return "resolved";
  return known === 0 ? "unresolved" : "partial";
}

/** A styled neutral container: custom-styled when it applies a declaration outside layout, layout-only when every declaration is resolved and in layout. */
function containerStyle(record: ElementRecord, classifier: ValueClassifier): { kind: "custom" | "unresolved" } | { kind: "layout"; declarations: AppliedDeclaration[] } {
  const declarations = record.parts.flatMap((part) => (part ? part.declarations : []));
  if (declarations.some((declaration) => classifier.familyOf(declaration.property) !== LAYOUT_FAMILY)) return { kind: "custom" };
  const complete = !record.spread && record.parts.every((part) => part !== null);
  return complete && declarations.length ? { kind: "layout", declarations } : { kind: "unresolved" };
}

function declarationList(declarations: readonly AppliedDeclaration[]): string {
  const seen = new Map<string, Site>();
  for (const declaration of [...declarations].sort((a, b) => compareCodeUnits(a.site.path, b.site.path) || a.site.offset - b.site.offset)) {
    const text = `${declaration.property}: ${declaration.text}`;
    if (!seen.has(text)) seen.set(text, declaration.site);
  }
  const listed = [...seen.entries()].slice(0, REASONING_LIMIT).map(([text, site]) => `${text} (${site.path}:${site.line})`);
  return seen.size > REASONING_LIMIT ? `${listed.join("; ")}; and ${seen.size - REASONING_LIMIT} more` : listed.join("; ");
}

type KindCounts = Record<Exclude<ValueKind, "token_alias"> | "unparsed", number>;

function reportValues(context: DetectorContext, index: StyleIndex, files: readonly FileAnalysis[], used: readonly Catalog[], classifier: ValueClassifier) {
  const families = new Map<string, Tally<KindCounts>>();
  const aliases = new Map<string, { tally: Tally<{ declarations: number }>; names: Map<Scope, Set<string>>; all: Set<string> }>();
  const findings = new Map<string, Tally<{ count: number }>>();
  const summaries = new Map(used.map((catalog) => [catalog.id, { tally: new Tally(counts(["token_capable", "tokenized"])), aliased: false }]));
  const tokenCapable = perScope(() => 0);
  const capableSites: Site[] = [];

  const family = (name: string) => {
    let tally = families.get(name);
    if (!tally) families.set(name, (tally = new Tally(counts([...OBSERVED_KINDS, "unparsed"]))));
    return tally;
  };
  const count = (result: { family: string; observed: ValueKind; resolved: ValueKind; systems: ReadonlySet<string>; aliases: ReadonlySet<string> }, scope: Scope, site: Site) => {
    const tally = family(result.family);
    tally.scopes[scope][result.observed as Exclude<ValueKind, "token_alias">]++;
    tally.sites.push(site);
    if (result.resolved === "token_alias") {
      const entry = aliases.get(result.family) ?? { tally: new Tally(counts(["declarations"])), names: new Map(), all: new Set<string>() };
      aliases.set(result.family, entry);
      entry.tally.scopes[scope].declarations++;
      entry.tally.sites.push(site);
      const names = entry.names.get(scope) ?? new Set<string>();
      entry.names.set(scope, names);
      for (const name of result.aliases) {
        names.add(name);
        entry.all.add(name);
      }
    }
    if (!classifier.isTokenCapable(result.family)) return;
    tokenCapable[scope]++;
    capableSites.push(site);
    for (const [system, summary] of summaries) {
      summary.tally.scopes[scope].token_capable++;
      if ((result.resolved === "token" || result.resolved === "token_alias") && result.systems.has(system)) {
        summary.tally.scopes[scope].tokenized++;
        summary.tally.sites.push(site);
        if (result.resolved === "token_alias") summary.aliased = true;
      }
    }
  };

  for (const item of index.declarations) count(classifier.classifyDeclaration(item.declaration, item.source), item.source.scope, item.site);
  for (const file of files) {
    for (const object of file.objects) {
      if (object.value === "unparsed") {
        family(classifier.familyOf(object.property)).scopes[object.scope].unparsed++;
        family(classifier.familyOf(object.property)).sites.push(object.site);
      } else count(classifier.classify({ property: object.property, value: object.value }), object.scope, object.site);
    }
  }
  for (const entry of index.unparsed) {
    const tally = family(entry.property ? classifier.familyOf(entry.property) : "other");
    tally.scopes[entry.source.scope].unparsed++;
    tally.sites.push(entry.site);
  }
  for (const finding of index.findings) {
    const tally = findings.get(finding.key) ?? new Tally(counts(["count"]));
    findings.set(finding.key, tally);
    tally.scopes[finding.scope].count++;
    tally.sites.push(finding.site);
  }

  const fact = (key: string, value: JsonObject, sites: readonly Site[], rule: string) => context.fact({ category: "style_values", key, value, basis: "observed", evidence: evidenceOf(context, sites, rule), rule });
  for (const [name, tally] of byKey(families)) fact(`declarations:${name}`, perScopeValue(tally), tally.samples(), RULES.declarations);
  for (const [name, entry] of byKey(aliases)) {
    const value = Object.fromEntries(SCOPES.map((scope) => [scope, { declarations: entry.tally.scopes[scope].declarations, aliases: entry.names.get(scope)?.size ?? 0 }]));
    context.fact({ category: "style_values", key: `token-aliases:${name}`, value, basis: "inferred", evidence: evidenceOf(context, entry.tally.samples(), RULES.aliases), rule: RULES.aliases, reasoning: aliasReasoning(entry.all, classifier) });
  }
  for (const [key, tally] of byKey(findings)) fact(key, perScopeValue(tally), tally.samples(), RULES.findings);

  if (!capableSites.length) return;
  for (const [system, summary] of byKey(summaries)) {
    const value = Object.fromEntries(
      SCOPES.map((scope) => {
        const { token_capable, tokenized } = summary.tally.scopes[scope];
        const tokenShare = share(tokenized, token_capable);
        return [scope, { token_capable, tokenized, ...(tokenShare !== undefined && { token_share: tokenShare }) }];
      }),
    );
    const samples = summary.tally.sites.length ? summary.tally.samples() : [...capableSites].sort((a, b) => compareCodeUnits(a.path, b.path) || a.offset - b.offset).slice(0, SAMPLES);
    const basis = summary.aliased ? "inferred" : "observed";
    context.fact({
      category: "style_values",
      key: `summary:${system}`,
      value,
      basis,
      evidence: evidenceOf(context, samples, RULES.summary),
      rule: RULES.summary,
      ...(summary.aliased && { reasoning: `The tokenized counts include declarations that use token aliases. ${aliasReasoning(aliasNames(aliases), classifier)}` }),
    });
  }
}

function aliasNames(aliases: ReadonlyMap<string, { all: Set<string> }>): Set<string> {
  return new Set([...aliases.values()].flatMap((entry) => [...entry.all]));
}

function aliasReasoning(names: ReadonlySet<string>, classifier: ValueClassifier): string {
  const sorted = [...names].sort(compareCodeUnits);
  const described = sorted.slice(0, REASONING_LIMIT).map((name) => {
    const definitions = classifier.aliasDefinitions(name);
    const places = definitions.slice(0, 3).map((definition) => `${definition.site.path}:${definition.site.line}`);
    return `${name}, defined as ${[...new Set(definitions.map((definition) => definition.declaration.text))].slice(0, 2).join(" and ")} (${places.join(", ")})`;
  });
  const more = sorted.length > REASONING_LIMIT ? `; and ${sorted.length - REASONING_LIMIT} more` : "";
  return `Every definition of these custom properties resolves to design-system tokens: ${described.join("; ")}${more}.`;
}
