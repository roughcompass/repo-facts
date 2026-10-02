import { type ComponentValue, type StaticValue, type StyledFactory, type StyledWrapper, type SyntaxTree, type TagReference, resolveReference, resolveTag, resolveValue, styledWrapperOf, unwrap } from "@repo-facts/syntax";
import ts from "typescript";
import { type Catalogs, catalogOf, uiLibraryOf } from "./catalog.js";
import type { AdapterRole } from "./catalog-schema.js";
import type { Scope } from "./scope.js";
import type { StyleIndex, Site, StyleSource } from "./styles.js";
import { templateSource } from "./templates.js";
import { cssProperty, styleObjectValue } from "./values.js";

/**
 * One source file's JSX elements, classified where they're written, with the
 * styles each applies; and the styles the file defines in styling-adapter
 * templates, style objects, and styled wrappers.
 *
 * Tags resolve within the file only. A class name is traced to the stylesheet
 * rules that name it: a string literal names global classes, a CSS-module
 * member names that module's class, and a class composer from the adapter
 * catalog applies its arguments' classes, conditionally when behind a
 * condition. Anything else is unresolved.
 */

export const MECHANISMS = ["class_name", "style", "css", "sx", "styled"] as const;
export type Mechanism = (typeof MECHANISMS)[number];

const ATTRIBUTE_MECHANISMS: Readonly<Record<string, Mechanism>> = { className: "class_name", style: "style", css: "css", sx: "sx" };

/** A declaration an element applies, as written. */
export interface AppliedDeclaration {
  property: string;
  text: string;
  site: Site;
}

/** One source of an element's styles: the declarations it applies, or null when they can't be determined. */
export type StylePart = { declarations: readonly AppliedDeclaration[] } | null;

export interface AppliedClass {
  name: string;
  /** The CSS module the class comes from, or null for a global class. */
  module: string | null;
  conditional: boolean;
}

export type ElementKind = { kind: "component"; system: string; name: string; package: string } | { kind: "intrinsic"; tag: string } | { kind: "library"; package: string } | { kind: "other" };

export interface ElementRecord {
  element: ElementKind;
  site: Site;
  scope: Scope;
  mechanisms: ReadonlySet<Mechanism>;
  spread: boolean;
  classes: readonly AppliedClass[];
  /** Every style source the element applies; empty when it applies none. */
  parts: readonly StylePart[];
}

export interface WrapperRecord {
  system: string;
  name: string;
  site: Site;
  scope: Scope;
}

/** A declaration read from a style object: a `style`, `css`, or `sx` object, or an object-syntax adapter call. */
export interface ObjectDeclaration {
  property: string;
  /** Component values, null for a value that isn't a literal, or `unparsed` for CSS the syntax rules discard. */
  value: ComponentValue[] | null | "unparsed";
  site: Site;
  scope: Scope;
}

export interface FileAnalysis {
  elements: ElementRecord[];
  wrappers: WrapperRecord[];
  /** Styling-adapter template bodies, parsed. */
  templates: StyleSource[];
  objects: ObjectDeclaration[];
  /** Template bodies that hit a stylesheet limit. */
  failures: { reason: string; detail: string }[];
}

const MAX_DEPTH = 4;

export function analyzeFile(tree: SyntaxTree, scope: Scope, catalogs: Catalogs, index: StyleIndex): FileAnalysis {
  return new FileAnalyzer(tree, scope, catalogs, index).run();
}

class FileAnalyzer {
  private readonly analysis: FileAnalysis = { elements: [], wrappers: [], templates: [], objects: [], failures: [] };
  /** Bindings of stylesheet imports, by name, to the joined stylesheet path. */
  private readonly stylesheetImports = new Map<string, string>();
  private readonly factories: StyledFactory[];
  /** Style parts by the node that defines them: a style-factory template or call, or a styled wrapper's binding name. */
  private readonly styleNodes = new Map<ts.Node, StylePart>();
  private readonly wrappers = new Map<string, { wrapper: StyledWrapper; part: StylePart }>();
  private readonly counted = new Set<ts.Node>();

  constructor(
    private readonly tree: SyntaxTree,
    private readonly scope: Scope,
    private readonly catalogs: Catalogs,
    private readonly index: StyleIndex,
  ) {
    this.factories = catalogs.adapters.adapters.flatMap((adapter) => adapter.exports.filter((entry) => entry.role === "styled_factory").map((entry) => ({ module: adapter.module, members: entry.name === "default" ? [] : [entry.name] })));
  }

  run(): FileAnalysis {
    const { tree } = this;
    const declarations: ts.VariableDeclaration[] = [];
    const styleCalls: (ts.TaggedTemplateExpression | ts.CallExpression)[] = [];
    const elements: (ts.JsxOpeningElement | ts.JsxSelfClosingElement)[] = [];
    tree.walk((node) => {
      if (ts.isImportDeclaration(node)) this.recordImport(node);
      else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) declarations.push(node);
      else if (ts.isTaggedTemplateExpression(node) || ts.isCallExpression(node)) styleCalls.push(node);
      else if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) elements.push(node);
    });

    for (const node of styleCalls) {
      const callee = ts.isTaggedTemplateExpression(node) ? node.tag : node.expression;
      if (this.adapterRole(callee) !== "style_factory") continue;
      this.styleNodes.set(node, ts.isTaggedTemplateExpression(node) ? this.template(node.template) : this.objects(node.arguments));
    }
    for (const declaration of declarations) this.recordWrapper((declaration.name as ts.Identifier).text, declaration);
    for (const element of elements) this.element(element);
    return this.analysis;
  }

  private site(node: ts.Node): Site {
    const offset = node.getStart(this.tree.file);
    return { path: this.tree.path, content: this.tree.content, line: this.tree.lines(node).start, offset };
  }

  private recordImport(node: ts.ImportDeclaration) {
    if (!ts.isStringLiteral(node.moduleSpecifier)) return;
    const specifier = node.moduleSpecifier.text;
    if (!specifier.toLowerCase().endsWith(".css") || !specifier.startsWith(".")) return;
    const path = joinPath(this.tree.path, specifier);
    const clause = node.importClause;
    if (!clause || clause.isTypeOnly) return;
    if (clause.name) this.stylesheetImports.set(clause.name.text, path);
    if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) this.stylesheetImports.set(clause.namedBindings.name.text, path);
  }

  /** The adapter role of the export +expression+ refers to, when the adapter catalog lists it. */
  private adapterRole(expression: ts.Node): AdapterRole | null {
    const reference = resolveReference(this.tree, expression);
    if (reference.kind !== "module" || reference.members.length > 1) return null;
    const name = reference.members[0] ?? "default";
    const adapter = this.catalogs.adapters.adapters.find((candidate) => candidate.module === reference.module);
    return adapter?.exports.find((entry) => entry.name === name)?.role ?? null;
  }

  private recordWrapper(name: string, declaration: ts.VariableDeclaration) {
    const binding = this.tree.binding(name);
    if (!binding || binding.declarations[0] !== declaration) return;
    const wrapper = styledWrapperOf(this.tree, binding, this.factories);
    if (!wrapper) return;
    const part = wrapper.body.kind === "template" ? this.template(wrapper.body.template) : this.objects(wrapper.body.arguments);
    this.wrappers.set(name, { wrapper, part });
    const component = this.componentOf(wrapper.target, 0);
    if (component) this.analysis.wrappers.push({ system: component.system, name: component.name, site: this.site(declaration), scope: this.scope });
  }

  /** The design-system component a reference resolves to, through same-file styled wrappers. */
  private componentOf(reference: TagReference, depth: number): Extract<ElementKind, { kind: "component" }> | null {
    if (reference.kind === "module") {
      const owner = catalogOf(this.catalogs, reference.module);
      return owner ? { kind: "component", system: owner.catalog.id, name: reference.members.join(".") || "default", package: owner.packageName } : null;
    }
    if (reference.kind === "local" && reference.members.length === 0 && depth < MAX_DEPTH) {
      const wrapper = this.wrappers.get(reference.name);
      return wrapper ? this.componentOf(wrapper.wrapper.target, depth + 1) : null;
    }
    return null;
  }

  /** The style parts a local wrapper applies, through wrappers of wrappers. */
  private wrapperParts(name: string, depth = 0): StylePart[] {
    const wrapper = this.wrappers.get(name);
    if (!wrapper || depth >= MAX_DEPTH) return [];
    const { target } = wrapper.wrapper;
    return [wrapper.part, ...(target.kind === "local" && target.members.length === 0 ? this.wrapperParts(target.name, depth + 1) : [])];
  }

  private element(node: ts.JsxOpeningElement | ts.JsxSelfClosingElement) {
    const reference = resolveTag(this.tree, node.tagName);
    let element: ElementKind = { kind: "other" };
    const mechanisms = new Set<Mechanism>();
    const parts: StylePart[] = [];
    if (reference.kind === "intrinsic") element = { kind: "intrinsic", tag: reference.name };
    else if (reference.kind === "module") {
      const library = uiLibraryOf(this.catalogs, reference.module);
      element = this.componentOf(reference, 0) ?? (library ? { kind: "library", package: library } : { kind: "other" });
    } else if (reference.kind === "local" && reference.members.length === 0) {
      const component = this.componentOf(reference, 0);
      if (component) {
        element = component;
        mechanisms.add("styled");
        parts.push(...this.wrapperParts(reference.name));
      }
    }

    let spread = false;
    const classes: AppliedClass[] = [];
    for (const attribute of node.attributes.properties) {
      if (ts.isJsxSpreadAttribute(attribute)) {
        spread = true;
        continue;
      }
      if (!ts.isIdentifier(attribute.name)) continue;
      const mechanism = ATTRIBUTE_MECHANISMS[attribute.name.text];
      if (!mechanism) continue;
      mechanisms.add(mechanism);
      const expression = attributeExpression(attribute);
      if (mechanism === "class_name") {
        const traced = expression ? this.classes(expression, false, 0) : { classes: [], unresolved: true };
        classes.push(...traced.classes);
        for (const applied of traced.classes) parts.push(this.classPart(applied));
        if (traced.unresolved) parts.push(null);
      } else {
        parts.push(expression ? this.inlineStyles(expression, mechanism) : null);
      }
    }
    this.analysis.elements.push({ element, site: this.site(node), scope: this.scope, mechanisms, spread, classes, parts });
  }

  private classPart(applied: AppliedClass): StylePart {
    const declarations = applied.module === null ? this.index.globalClasses.get(applied.name) : this.index.isModule(applied.module) ? (this.index.moduleClass(applied.module, applied.name) ?? []) : undefined;
    if (!declarations?.length) return null;
    return { declarations: declarations.map(({ declaration, site }) => ({ property: declaration.property, text: declaration.text, site })) };
  }

  /** The classes +expression+ applies, and whether any part of it is unresolved. */
  private classes(input: ts.Node, conditional: boolean, depth: number): { classes: AppliedClass[]; unresolved: boolean } {
    const expression = unwrap(input);
    const none = { classes: [] as AppliedClass[], unresolved: false };
    const unresolved = { classes: [] as AppliedClass[], unresolved: true };
    if (depth > MAX_DEPTH) return unresolved;
    const merge = (...results: { classes: AppliedClass[]; unresolved: boolean }[]) => ({ classes: results.flatMap((result) => result.classes), unresolved: results.some((result) => result.unresolved) });
    const words = (text: string) => text.split(/\s+/).filter(Boolean).map((name) => ({ name, module: null, conditional }));

    if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) return { classes: words(expression.text), unresolved: false };
    if (ts.isTemplateExpression(expression)) {
      // Words that touch an interpolation are partial names, and unresolved.
      const pieces = [expression.head.text, ...expression.templateSpans.map((span) => span.literal.text)];
      const results = [{ classes: [] as AppliedClass[], unresolved: false }];
      pieces.forEach((piece, position) => {
        const parts = piece.split(/\s+/);
        const whole = parts.filter((part, index) => part && !(index === 0 && position > 0 && !/^\s/.test(piece)) && !(index === parts.length - 1 && position < pieces.length - 1 && !/\s$/.test(piece)));
        results.push({ classes: whole.map((name) => ({ name, module: null, conditional })), unresolved: whole.length < parts.filter(Boolean).length });
      });
      for (const span of expression.templateSpans) results.push(this.classes(span.expression, conditional, depth + 1));
      return merge(...results);
    }
    if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
      const root = unwrap(expression.expression);
      const key = ts.isPropertyAccessExpression(expression) ? expression.name.text : ts.isStringLiteral(unwrap(expression.argumentExpression)) ? (unwrap(expression.argumentExpression) as ts.StringLiteral).text : null;
      const module = ts.isIdentifier(root) && this.tree.binding(root.text)?.kinds.length === 1 ? this.stylesheetImports.get(root.text) : undefined;
      return module && key !== null ? { classes: [{ name: key, module, conditional }], unresolved: false } : unresolved;
    }
    if (ts.isConditionalExpression(expression)) return merge(this.classes(expression.whenTrue, true, depth + 1), this.classes(expression.whenFalse, true, depth + 1));
    if (ts.isBinaryExpression(expression)) {
      const operator = expression.operatorToken.kind;
      if (operator === ts.SyntaxKind.AmpersandAmpersandToken) return this.classes(expression.right, true, depth + 1);
      if (operator === ts.SyntaxKind.BarBarToken || operator === ts.SyntaxKind.QuestionQuestionToken) return merge(this.classes(expression.left, true, depth + 1), this.classes(expression.right, true, depth + 1));
      if (operator === ts.SyntaxKind.PlusToken) return merge(this.classes(expression.left, conditional, depth + 1), this.classes(expression.right, conditional, depth + 1));
      return unresolved;
    }
    if (ts.isArrayLiteralExpression(expression)) return merge(...expression.elements.map((element) => this.classes(element, conditional, depth + 1)));
    if (ts.isObjectLiteralExpression(expression)) {
      // A composer's object argument: each key is a class, applied when its value is truthy.
      return merge(
        ...expression.properties.map((property) => {
          if (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) {
            if (ts.isComputedPropertyName(property.name)) return this.classes(property.name.expression, true, depth + 1);
            const name = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) ? property.name.text : null;
            return name ? { classes: words(name).map((item) => ({ ...item, conditional: true })), unresolved: false } : unresolved;
          }
          return unresolved;
        }),
      );
    }
    if (ts.isCallExpression(expression)) {
      if (this.adapterRole(expression.expression) === "class_composer") return merge(...expression.arguments.map((argument) => this.composerArgument(argument, conditional, depth)));
      // A variant from a class composer, such as `const button = cva("base", {...})`, applies its definition's classes.
      const callee = unwrap(expression.expression);
      const binding = ts.isIdentifier(callee) ? this.tree.binding(callee.text) : undefined;
      const definition = binding?.constant ? unwrap(binding.constant) : null;
      if (definition && ts.isCallExpression(definition) && this.adapterRole(definition.expression) === "class_composer") return merge(...definition.arguments.map((argument, index) => this.composerArgument(argument, conditional || index > 0, depth)));
      return unresolved;
    }
    if (ts.isIdentifier(expression)) {
      if (expression.text === "undefined") return none;
      const binding = this.tree.binding(expression.text);
      return binding?.constant ? this.classes(binding.constant, conditional, depth + 1) : unresolved;
    }
    if (expression.kind === ts.SyntaxKind.NullKeyword || expression.kind === ts.SyntaxKind.FalseKeyword || expression.kind === ts.SyntaxKind.TrueKeyword || ts.isNumericLiteral(expression)) return none;
    return unresolved;
  }

  /** The classes a class composer's argument applies: a condition guards what follows it, and nested objects are variants. */
  private composerArgument(argument: ts.Node, conditional: boolean, depth: number): { classes: AppliedClass[]; unresolved: boolean } {
    const expression = unwrap(argument);
    if (ts.isObjectLiteralExpression(expression) && expression.properties.some((property) => ts.isPropertyAssignment(property) && ts.isIdentifier(property.name) && (property.name.text === "variants" || property.name.text === "compoundVariants"))) {
      // A variant configuration, such as cva's `{ variants: { intent: { primary: "..." } } }`.
      return this.variantClasses(expression, depth + 1);
    }
    return this.classes(expression, conditional, depth + 1);
  }

  /**
   * The classes in a variant configuration, each conditional: the values of
   * `variants`, and the `class` or `className` of each compound variant.
   * Default variants name variant values, not classes.
   */
  private variantClasses(configuration: ts.ObjectLiteralExpression, depth: number): { classes: AppliedClass[]; unresolved: boolean } {
    const results: { classes: AppliedClass[]; unresolved: boolean }[] = [];
    const strings = (node: ts.Node, level: number): void => {
      const expression = unwrap(node);
      if (level > MAX_DEPTH) results.push({ classes: [], unresolved: true });
      else if (ts.isObjectLiteralExpression(expression)) {
        for (const property of expression.properties) if (ts.isPropertyAssignment(property)) strings(property.initializer, level + 1);
      }
      else if (ts.isArrayLiteralExpression(expression)) for (const element of expression.elements) strings(element, level + 1);
      else if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression) || ts.isTemplateExpression(expression) || ts.isPropertyAccessExpression(expression)) results.push(this.classes(expression, true, depth + 1));
    };
    for (const property of configuration.properties) {
      if (!ts.isPropertyAssignment(property)) continue;
      const key = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) ? property.name.text : null;
      if (key === "variants") strings(property.initializer, 0);
      else if (key === "compoundVariants" && ts.isArrayLiteralExpression(unwrap(property.initializer))) {
        for (const element of (unwrap(property.initializer) as ts.ArrayLiteralExpression).elements) {
          const compound = unwrap(element);
          if (!ts.isObjectLiteralExpression(compound)) continue;
          for (const entry of compound.properties) {
            if (ts.isPropertyAssignment(entry) && ts.isIdentifier(entry.name) && (entry.name.text === "class" || entry.name.text === "className")) strings(entry.initializer, 0);
          }
        }
      }
    }
    return { classes: results.flatMap((result) => result.classes), unresolved: results.some((result) => result.unresolved) };
  }

  /** The declarations a `style`, `css`, or `sx` attribute applies. */
  private inlineStyles(input: ts.Node, mechanism: Mechanism): StylePart {
    const expression = unwrap(input);
    const defined = this.styleNodes.get(expression);
    if (defined !== undefined) return defined;
    if (ts.isIdentifier(expression)) {
      const binding = this.tree.binding(expression.text);
      const constant = binding?.constant ? unwrap(binding.constant) : null;
      const fromBinding = constant ? this.styleNodes.get(constant) : undefined;
      if (fromBinding !== undefined) return fromBinding;
    }
    if (mechanism !== "style" && ts.isArrayLiteralExpression(expression)) {
      const parts = expression.elements.map((element) => this.inlineStyles(element, mechanism));
      return parts.every((part) => part !== null) ? { declarations: parts.flatMap((part) => part!.declarations) } : null;
    }
    return this.objects([expression]);
  }

  /** Declarations from style objects, such as `style={{ minHeight: 220 }}` or `styled.div({ display: "flex" })`. */
  private objects(nodes: readonly ts.Node[]): StylePart {
    const declarations: AppliedDeclaration[] = [];
    let resolved = true;
    for (const node of nodes) {
      const value = resolveValue(this.tree, node);
      if (value.kind !== "object") {
        resolved = false;
        continue;
      }
      if (!value.complete) resolved = false;
      this.objectDeclarations(value, declarations, 0);
    }
    return resolved ? { declarations } : null;
  }

  private objectDeclarations(value: Extract<StaticValue, { kind: "object" }>, into: AppliedDeclaration[], depth: number) {
    for (const [key, item] of value.properties) {
      // A nested object is a selector or media block, such as `"&:hover": {...}`.
      if (item.kind === "object") {
        if (depth < MAX_DEPTH) this.objectDeclarations(item, into, depth + 1);
        continue;
      }
      const property = cssProperty(key);
      if (property.startsWith("--")) continue;
      const site = this.site(item.node);
      // A style object bound once and applied in several places is written, and counted, once.
      if (!this.counted.has(item.node)) {
        this.counted.add(item.node);
        const parsed = item.kind === "string" || item.kind === "number" ? styleObjectValue(property, item.value) : null;
        this.analysis.objects.push({ property, value: parsed, site, scope: this.scope });
      }
      into.push({ property, text: this.tree.text(item.node), site });
    }
  }

  private template(template: ts.TemplateLiteral): StylePart {
    const built = templateSource(this.tree, template, this.scope);
    if ("failure" in built) {
      this.analysis.failures.push(built.failure);
      return null;
    }
    this.analysis.templates.push(built.source);
    const declarations: AppliedDeclaration[] = [];
    const collect = (list: readonly { property: string; text: string; start: number; custom: boolean }[]) => {
      for (const declaration of list) {
        if (declaration.custom) continue;
        const at = built.source.base + declaration.start;
        declarations.push({ property: declaration.property, text: declaration.text, site: { path: this.tree.path, content: this.tree.content, line: built.source.lineAt(at), offset: at } });
      }
    };
    collect(built.source.stylesheet.declarations);
    const stack = [...built.source.stylesheet.rules];
    while (stack.length) {
      const rule = stack.pop()!;
      collect(rule.declarations);
      stack.push(...rule.rules);
    }
    return { declarations };
  }
}

function attributeExpression(attribute: ts.JsxAttribute): ts.Expression | null {
  const initializer = attribute.initializer;
  if (!initializer) return null;
  if (ts.isStringLiteral(initializer)) return initializer;
  if (ts.isJsxExpression(initializer)) return initializer.expression ?? null;
  return null;
}

/** Joins a relative import specifier to the importing file's directory. No module resolution is involved. */
export function joinPath(from: string, specifier: string): string {
  const segments = from.split("/").slice(0, -1);
  for (const part of specifier.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") segments.pop();
    else segments.push(part);
  }
  return segments.join("/");
}
