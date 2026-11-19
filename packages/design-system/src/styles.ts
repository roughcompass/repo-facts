import type { BlobContent } from "@repo-facts/contract";
import { type ComponentValue, type CssComplexSelector, type CssDeclaration, type CssNode, type Stylesheet, walkStylesheet } from "@repo-facts/syntax";
import type { Catalog } from "./catalog.js";
import type { Scope } from "./scope.js";

/**
 * The stylesheet index: every style declaration in the repository's supported
 * stylesheets and styling-adapter templates, the classes each stylesheet
 * defines, custom-property definitions, and adherence findings.
 *
 * A class is associated with every rule whose selector names it, in any
 * compound, and with the rules nested inside that rule. That's deliberately
 * conservative: an element counts as styled when any matching rule applies.
 * A nested rule whose selectors all add a parent suffix, as `&__label` does,
 * names other classes, so it isn't associated with the parent's.
 * A class whose rules apply an SCSS or Less mixin or extend has declarations
 * defined elsewhere, so its declarations aren't known. A mixin's own body
 * isn't any class's, and isn't a global element selector: it applies only
 * where it's included.
 */

/** Where a declaration or finding is, for sample evidence. */
export interface Site {
  path: string;
  content: BlobContent;
  line: number;
  /** The offset in the file, so samples sort in position order. */
  offset: number;
}

export interface StyleSource {
  path: string;
  scope: Scope;
  content: BlobContent;
  /** A CSS module, a global stylesheet, or the body of a styling-adapter template. */
  kind: "module" | "global" | "template";
  stylesheet: Stylesheet;
  /** The file offset of offset 0 in the stylesheet's text: nonzero for a template body. */
  base: number;
  /** The 1-based file line of a file offset. */
  lineAt(offset: number): number;
  /** Spans of the stylesheet's text that were template interpolations. */
  interpolations: readonly (readonly [number, number])[];
}

export interface IndexedDeclaration {
  declaration: CssDeclaration;
  source: StyleSource;
  site: Site;
}

export const FINDING_KINDS = ["redefinition", "unknown-token", "internal-selector", "element-selector", "important"] as const;
export type FindingKind = (typeof FINDING_KINDS)[number];

export interface Finding {
  kind: FindingKind;
  /** The fact key, such as `redefinition:--salt-palette-accent` or `important`. */
  key: string;
  scope: Scope;
  site: Site;
}

/** CSS-module interchange blocks: `:export { name: value }` hands values to JavaScript and `:import` takes them; neither styles an element. */
const INTERCHANGE_PSEUDOS = new Set(["export", "import"]);

/** Descriptor at-rules: their declarations describe a font, property, or counter, not an element's style. */
const DESCRIPTOR_AT_RULES = new Set(["font-face", "property", "counter-style", "font-feature-values", "font-palette-values", "view-transition"]);
/** SCSS at-rules whose bodies are applied where they're included, not where they're written. */
const DEFINITION_AT_RULES = new Set(["mixin", "function"]);

export class StyleIndex {
  /** Style declarations, excluding custom-property definitions. */
  readonly declarations: IndexedDeclaration[] = [];
  /** Custom-property definitions, by name, repository-wide. */
  readonly definitions = new Map<string, IndexedDeclaration[]>();
  /** Declarations each module class applies, by module path. */
  readonly moduleClasses = new Map<string, Map<string, IndexedDeclaration[]>>();
  /** Declarations each global class applies, across every global stylesheet. */
  readonly globalClasses = new Map<string, IndexedDeclaration[]>();
  /** Classes whose rules apply mixins or extends, by module path, or "" for global classes. */
  private readonly incomplete = new Map<string, Set<string>>();
  readonly findings: Finding[] = [];
  /** The CSS modules indexed, so a class missing from one is known to be missing. */
  readonly modules = new Set<string>();
  /** Declarations the CSS syntax rules discarded, with the property when known. */
  readonly unparsed: { property: string | null; source: StyleSource; site: Site }[] = [];

  private readonly tokens: ReadonlyMap<string, ReadonlySet<string>>;

  /** +catalogs+ supply token names and prefixes; +used+ are the catalogs whose equivalents make element selectors findings. */
  constructor(
    private readonly catalogs: readonly Catalog[],
    private readonly used: readonly Catalog[],
  ) {
    this.tokens = new Map(catalogs.map((catalog) => [catalog.id, new Set(catalog.tokens)]));
  }

  add(source: StyleSource): void {
    const site = (offset: number): Site => {
      const at = source.base + offset;
      return { path: source.path, content: source.content, line: source.lineAt(at), offset: at };
    };
    const { stylesheet } = source;
    if (source.kind === "module") this.modules.add(source.path);
    for (const entry of stylesheet.unparsed) {
      if (source.interpolations.some(([start, end]) => entry.start >= start && entry.end <= end)) continue;
      this.unparsed.push({ property: entry.property, source, site: site(entry.start) });
    }
    this.declare(source, stylesheet.declarations, site);

    const classesOf = new Map<CssNode, string[]>();
    walkStylesheet(stylesheet.rules, (node, ancestors) => {
      if (ancestors.some((ancestor) => ancestor.kind === "at-rule" && DESCRIPTOR_AT_RULES.has(ancestor.name)) || (node.kind === "at-rule" && DESCRIPTOR_AT_RULES.has(node.name)) || isInterchange(node)) return;
      const parent = ancestors[ancestors.length - 1];
      // A parent suffix, as in `&__label`, names a class of its own rather than a descendant of the parent's.
      const suffixed = node.kind === "rule" && node.selectors.length > 0 && node.selectors.every((selector) => selector.compounds.some((compound) => compound.suffix !== null));
      const inherited = parent && !suffixed ? (classesOf.get(parent) ?? []) : [];
      const own = node.kind === "rule" ? node.selectors.flatMap((selector) => selector.compounds.flatMap((compound) => [...compound.classes, ...compound.argumentClasses])) : [];
      const classes = [...new Set([...inherited, ...own])];
      classesOf.set(node, classes);

      if (node.kind === "rule") {
        for (const selector of node.selectors) this.selectorFindings(source, selector, ancestors, site(node.start));
      }
      const declared = this.declare(source, node.declarations, site);
      if (source.kind === "template" || !classes.length || isDefinition(node, ancestors)) return;
      const key = source.kind === "module" ? source.path : "";
      for (const name of classes) {
        const map = source.kind === "module" ? this.moduleMap(source.path) : this.globalClasses;
        map.set(name, [...(map.get(name) ?? []), ...declared]);
        if (node.includes.length) {
          const names = this.incomplete.get(key) ?? new Set<string>();
          this.incomplete.set(key, names.add(name));
        }
      }
    });
  }

  private moduleMap(path: string): Map<string, IndexedDeclaration[]> {
    let map = this.moduleClasses.get(path);
    if (!map) this.moduleClasses.set(path, (map = new Map()));
    return map;
  }

  /** Records +declarations+ and their findings, returning the style declarations. */
  private declare(source: StyleSource, declarations: readonly CssDeclaration[], site: (offset: number) => Site): IndexedDeclaration[] {
    const style: IndexedDeclaration[] = [];
    for (const declaration of declarations) {
      const indexed: IndexedDeclaration = { declaration, source, site: site(declaration.start) };
      if (declaration.custom) {
        this.definitions.set(declaration.property, [...(this.definitions.get(declaration.property) ?? []), indexed]);
        const catalog = this.catalogs.find((candidate) => candidate.token_prefix !== null && declaration.property.startsWith(candidate.token_prefix));
        if (catalog) this.finding("redefinition", `redefinition:${declaration.property}`, source, indexed.site);
      } else {
        style.push(indexed);
        this.declarations.push(indexed);
      }
      for (const reference of varReferences(declaration.value)) {
        const catalog = this.catalogs.find((candidate) => candidate.token_prefix !== null && reference.name.startsWith(candidate.token_prefix));
        if (catalog && !this.tokens.get(catalog.id)!.has(reference.name)) this.finding("unknown-token", `unknown-token:${reference.name}`, source, site(reference.start));
      }
      if (declaration.important) this.finding("important", "important", source, indexed.site);
    }
    return style;
  }

  private selectorFindings(source: StyleSource, selector: CssComplexSelector, ancestors: readonly CssNode[], at: Site) {
    for (const catalog of this.catalogs) {
      const prefix = catalog.class_prefix;
      const internal = prefix !== null && selector.compounds.some((compound) => [...compound.classes, ...compound.argumentClasses].some((name) => hasClassPrefix(name, prefix)));
      if (internal) this.finding("internal-selector", `internal-selector:${catalog.id}`, source, at);
    }
    // A global element selector: an unqualified tag, outside any rule, keyframes, and mixin.
    if (source.kind === "template" || ancestors.some((ancestor) => ancestor.kind === "rule" || ancestor.name === "keyframes" || DEFINITION_AT_RULES.has(ancestor.name))) return;
    const qualified = selector.compounds.some((compound) => compound.classes.length || compound.ids.length || compound.attributes.length || compound.argumentClasses.length || compound.placeholders.length || compound.nesting || compound.unresolved);
    const subject = selector.compounds[selector.compounds.length - 1];
    if (qualified || !subject?.type) return;
    if (this.used.some((catalog) => catalog.equivalents.some((equivalent) => equivalent.tag === subject.type))) this.finding("element-selector", `element-selector:${subject.type}`, source, at);
  }

  private finding(kind: FindingKind, key: string, source: StyleSource, site: Site) {
    this.findings.push({ kind, key, scope: source.scope, site });
  }

  /** The declarations a module class applies, from the module at +path+; undefined when they aren't all known. */
  moduleClass(path: string, name: string): IndexedDeclaration[] | undefined {
    return this.incomplete.get(path)?.has(name) ? undefined : this.moduleClasses.get(path)?.get(name);
  }

  /** The declarations a global class applies; undefined when they aren't all known. */
  globalClass(name: string): IndexedDeclaration[] | undefined {
    return this.incomplete.get("")?.has(name) ? undefined : this.globalClasses.get(name);
  }

  isModule(path: string): boolean {
    return this.modules.has(path);
  }
}

/** A class carries a prefix when it is the prefix, or continues it with an uppercase letter or a dash, as `saltButton` and `salt-theme` do. */
export function hasClassPrefix(name: string, prefix: string): boolean {
  if (!name.startsWith(prefix)) return false;
  const next = name.charAt(prefix.length);
  return next === "" || next === "-" || (next >= "A" && next <= "Z");
}

/** Every `var()` reference in +values+, including those in fallbacks, in order. */
export function varReferences(values: readonly ComponentValue[]): { name: string; start: number; fallback: ComponentValue[] }[] {
  const found: { name: string; start: number; fallback: ComponentValue[] }[] = [];
  const stack = [...values].reverse();
  while (stack.length) {
    const value = stack.pop()!;
    if (value.kind === "token") continue;
    if (value.kind === "function" && value.name.toLowerCase() === "var") {
      const parts = value.value.filter((part) => !(part.kind === "token" && part.token.type === "whitespace"));
      const [first, second] = parts;
      // A name continued by interpolation, as in `var(--salt-#{$name})`, isn't known.
      const interpolated = second?.kind === "token" && (second.token.type === "interpolation" || second.token.type === "variable") && second.start === first?.end;
      if (first?.kind === "token" && first.token.type === "ident" && first.token.value.startsWith("--") && !interpolated) {
        const comma = value.value.findIndex((part) => part.kind === "token" && part.token.type === "comma");
        found.push({ name: first.token.value, start: value.start, fallback: comma === -1 ? [] : value.value.slice(comma + 1) });
      }
    }
    for (let index = value.value.length - 1; index >= 0; index--) stack.push(value.value[index]!);
  }
  return found;
}

/** Whether +node+ is inside, or is, an SCSS mixin or function body. */
function isDefinition(node: CssNode, ancestors: readonly CssNode[]): boolean {
  return [...ancestors, node].some((item) => item.kind === "at-rule" && DEFINITION_AT_RULES.has(item.name));
}

/** Whether +node+ is a CSS-module `:export` or `:import` block. */
function isInterchange(node: CssNode): boolean {
  if (node.kind !== "rule" || !node.selectors.length) return false;
  return node.selectors.every((selector) => {
    const [compound, ...rest] = selector.compounds;
    return !rest.length && compound !== undefined && !compound.type && !compound.classes.length && compound.pseudoClasses.length === 1 && INTERCHANGE_PSEUDOS.has(compound.pseudoClasses[0]!);
  });
}
