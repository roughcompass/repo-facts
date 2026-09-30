import { type Value, redactCredentials } from "@repo-facts/contract";
import ts from "typescript";
import { type StaticValue, propertyName, propertyOf, resolveValue, unwrap } from "../static-value.js";
import type { SyntaxTree } from "../syntax.js";
import type { CalleeSpec, CaptureSpec, Rule } from "./schema.js";

/**
 * Evaluates compiled rules against one syntax tree.
 *
 * The tree is walked once to collect the node kinds rules can match. Rules
 * are then evaluated in compiled order, so an `instanceOf` rule sees the
 * matches of the rule it depends on. Matching is structural: comments and
 * string contents are never nodes of these kinds, and a name bound more than
 * once in the file is never resolved to a module or instance.
 */

export interface RuleMatch {
  rule: Rule;
  node: ts.Node;
  /** Captured values, plus `method` when the callee matched a method list. */
  captures: Record<string, StaticValue>;
}

type Target = { kind: "global" | "module" | "instance" | "local"; module?: string; rules?: ReadonlySet<string>; chain: string[]; hasReceiver: boolean };

interface Collected {
  calls: ts.CallExpression[];
  news: ts.NewExpression[];
  tagged: ts.TaggedTemplateExpression[];
  jsx: (ts.JsxOpeningElement | ts.JsxSelfClosingElement)[];
  imports: { node: ts.Node; module: string }[];
}

const GLOBAL_OBJECTS = new Set(["globalThis", "window", "self"]);

export function matchRules(tree: SyntaxTree, rules: readonly Rule[]): RuleMatch[] {
  const collected = collect(tree);
  const matchedBy = new Map<ts.Node, Set<string>>();
  const matches: RuleMatch[] = [];
  const record = (match: RuleMatch) => {
    matches.push(match);
    const ids = matchedBy.get(match.node) ?? new Set<string>();
    ids.add(match.rule.id);
    matchedBy.set(match.node, ids);
  };

  for (const rule of rules) {
    const spec = rule.match;
    if ("call" in spec || "new" in spec || "tagged" in spec) {
      const [callee, nodes] = "call" in spec ? [spec.call, collected.calls] : "new" in spec ? [spec.new, collected.news] : [spec.tagged, collected.tagged];
      for (const node of nodes as readonly (ts.CallExpression | ts.NewExpression | ts.TaggedTemplateExpression)[]) {
        const expression = ts.isTaggedTemplateExpression(node) ? node.tag : node.expression;
        const matched = matchCallee(callee, resolveTarget(tree, expression, matchedBy));
        if (!matched) continue;
        const captures = captureAll(tree, rule, node);
        if (matched.method !== undefined) captures.method = { kind: "string", value: matched.method, node: expression };
        if (satisfies(rule, captures)) record({ rule, node, captures });
      }
    } else if ("jsx" in spec) {
      for (const node of collected.jsx) {
        if (!ts.isIdentifier(node.tagName) || !spec.jsx.element.includes(node.tagName.text)) continue;
        const captures = captureAll(tree, rule, node);
        if (satisfies(rule, captures)) record({ rule, node, captures });
      }
    } else {
      for (const item of collected.imports) {
        if (!spec.import.module.includes(item.module)) continue;
        const captures = captureAll(tree, rule, item.node, item.module);
        if (satisfies(rule, captures)) record({ rule, node: item.node, captures });
      }
    }
  }
  return matches.sort((a, b) => a.node.getStart(tree.file) - b.node.getStart(tree.file) || (a.rule.id < b.rule.id ? -1 : a.rule.id > b.rule.id ? 1 : 0));
}

function collect(tree: SyntaxTree): Collected {
  const collected: Collected = { calls: [], news: [], tagged: [], jsx: [], imports: [] };
  tree.walk((node) => {
    if (ts.isCallExpression(node)) {
      collected.calls.push(node);
      const required = requiredModule(node);
      if (required) collected.imports.push({ node, module: required });
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) collected.imports.push({ node, module: node.arguments[0].text });
    } else if (ts.isNewExpression(node)) collected.news.push(node);
    else if (ts.isTaggedTemplateExpression(node)) collected.tagged.push(node);
    else if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) collected.jsx.push(node);
    else if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) collected.imports.push({ node, module: node.moduleSpecifier.text });
  });
  return collected;
}

/** `require("m")` with a literal specifier, read as syntax; it is never called. */
function requiredModule(node: ts.Node): string | null {
  const call = unwrap(node);
  if (!ts.isCallExpression(call) || !ts.isIdentifier(call.expression) || call.expression.text !== "require" || call.arguments.length !== 1) return null;
  const [argument] = call.arguments;
  return argument && (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)) ? argument.text : null;
}

/** Splits `a.b["c"].d` into its root and member names. */
function flatten(expression: ts.Node): { root: ts.Node; chain: string[] } | null {
  let node = unwrap(expression);
  const chain: string[] = [];
  for (;;) {
    if (ts.isPropertyAccessExpression(node)) {
      chain.unshift(node.name.text);
      node = unwrap(node.expression);
    } else if (ts.isElementAccessExpression(node)) {
      const key = unwrap(node.argumentExpression);
      if (!(ts.isStringLiteral(key) || ts.isNoSubstitutionTemplateLiteral(key))) return null;
      chain.unshift(key.text);
      node = unwrap(node.expression);
    } else {
      return { root: node, chain };
    }
  }
}

function resolveTarget(tree: SyntaxTree, expression: ts.Node, matchedBy: ReadonlyMap<ts.Node, ReadonlySet<string>>): Target | null {
  const flat = flatten(expression);
  if (!flat) return null;
  const hasReceiver = flat.chain.length > 0;
  const required = requiredModule(flat.root);
  if (required) return { kind: "module", module: required, chain: flat.chain, hasReceiver };
  if (!ts.isIdentifier(flat.root)) return { kind: "local", chain: flat.chain, hasReceiver };

  const name = flat.root.text;
  const binding = tree.binding(name);
  if (!binding) {
    const chain = [name, ...flat.chain];
    while (chain.length > 1 && GLOBAL_OBJECTS.has(chain[0]!)) chain.shift();
    return { kind: "global", chain, hasReceiver };
  }
  if (binding.kinds.length !== 1) return { kind: "local", chain: flat.chain, hasReceiver };
  const [declaration] = binding.declarations;
  const source = declaration ? bindingSource(declaration) : null;
  if (source) return { kind: "module", module: source.module, chain: [...source.members, ...flat.chain], hasReceiver };
  if (binding.constant) {
    const rules = matchedBy.get(unwrapAwait(binding.constant));
    if (rules) return { kind: "instance", rules, chain: flat.chain, hasReceiver };
  }
  return { kind: "local", chain: flat.chain, hasReceiver };
}

function unwrapAwait(node: ts.Node): ts.Node {
  const inner = unwrap(node);
  return ts.isAwaitExpression(inner) ? unwrap(inner.expression) : inner;
}

/** The module and member path a binding refers to, for imports and `require` bindings. */
function bindingSource(declaration: ts.Node): { module: string; members: string[] } | null {
  if (ts.isImportClause(declaration) || ts.isNamespaceImport(declaration) || ts.isImportSpecifier(declaration)) {
    const importDeclaration = ts.findAncestor(declaration, ts.isImportDeclaration);
    if (!importDeclaration || !ts.isStringLiteral(importDeclaration.moduleSpecifier)) return null;
    const module = importDeclaration.moduleSpecifier.text;
    if (ts.isImportSpecifier(declaration)) {
      const imported = (declaration.propertyName ?? declaration.name).text;
      // A named import is the default export's member of that name, as CommonJS interop presents it.
      return { module, members: imported === "default" ? [] : [imported] };
    }
    return { module, members: [] };
  }
  if (ts.isImportEqualsDeclaration(declaration) && ts.isExternalModuleReference(declaration.moduleReference) && ts.isStringLiteral(declaration.moduleReference.expression)) {
    return { module: declaration.moduleReference.expression.text, members: [] };
  }
  if (ts.isVariableDeclaration(declaration) && declaration.initializer && ts.isIdentifier(declaration.name)) {
    return requireChain(declaration.initializer);
  }
  if (ts.isBindingElement(declaration) && ts.isObjectBindingPattern(declaration.parent) && ts.isVariableDeclaration(declaration.parent.parent) && declaration.parent.parent.initializer) {
    const base = requireChain(declaration.parent.parent.initializer);
    const key = declaration.propertyName ? propertyName(declaration.propertyName as ts.PropertyName) : ts.isIdentifier(declaration.name) ? declaration.name.text : null;
    return base && key !== null ? { module: base.module, members: [...base.members, key] } : null;
  }
  return null;
}

/** `require("m")` followed by literal member accesses. */
function requireChain(node: ts.Node): { module: string; members: string[] } | null {
  const flat = flatten(node);
  if (!flat) return null;
  const module = requiredModule(flat.root);
  return module ? { module, members: flat.chain } : null;
}

function matchCallee(spec: CalleeSpec, target: Target | null): { method?: string } | null {
  if (!target) return null;
  const members = spec.members ?? [];
  const tail = (chain: readonly string[]): { method?: string } | null => {
    if (spec.method) {
      if (chain.length !== members.length + 1 || !members.every((name, index) => chain[index] === name)) return null;
      const method = chain[chain.length - 1]!;
      return spec.method.includes(method) ? { method } : null;
    }
    return chain.length === members.length && members.every((name, index) => chain[index] === name) ? {} : null;
  };
  if (spec.global !== undefined) return target.kind === "global" && target.chain[0] === spec.global ? tail(target.chain.slice(1)) : null;
  if (spec.module !== undefined) return target.kind === "module" && spec.module.includes(target.module!) ? tail(target.chain) : null;
  if (spec.instanceOf !== undefined) return target.kind === "instance" && target.rules!.has(spec.instanceOf) ? tail(target.chain) : null;
  const method = target.chain[target.chain.length - 1];
  return target.hasReceiver && method !== undefined && spec.method!.includes(method) ? { method } : null;
}

function captureAll(tree: SyntaxTree, rule: Rule, node: ts.Node, module?: string): Record<string, StaticValue> {
  const captures: Record<string, StaticValue> = {};
  for (const [name, spec] of Object.entries(rule.capture ?? {})) captures[name] = capture(tree, spec, node, module);
  return captures;
}

function capture(tree: SyntaxTree, spec: CaptureSpec, node: ts.Node, module?: string): StaticValue {
  if ("argument" in spec) {
    const args = ts.isCallExpression(node) || ts.isNewExpression(node) ? (node.arguments ?? []) : [];
    // A spread at or before this position makes the argument unknowable.
    const spread = args.slice(0, spec.argument + 1).find(ts.isSpreadElement);
    if (spread) return { kind: "unresolved", reason: "computed", detail: "Arguments come from a spread", node: spread };
    const argument = args[spec.argument];
    if (!argument) return { kind: "undefined", node };
    let value = resolveValue(tree, argument);
    for (const key of spec.property ?? []) {
      if (value.kind === "object") value = propertyOf(value, key) ?? (value.complete ? { kind: "undefined", node: value.node } : { kind: "unresolved", reason: "computed", detail: `${key} may come from a spread`, node: value.node });
      else if (value.kind !== "unresolved") value = { kind: "unresolved", reason: "unsupported", detail: `Reading ${key} from a ${value.kind} value`, node: value.node };
    }
    return value;
  }
  if ("attribute" in spec) {
    const attributes = ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node) ? node.attributes.properties : ts.factory.createNodeArray<ts.JsxAttributeLike>();
    const attribute = attributes.find((item): item is ts.JsxAttribute => ts.isJsxAttribute(item) && ts.isIdentifier(item.name) && item.name.text === spec.attribute);
    if (!attribute) return attributes.some(ts.isJsxSpreadAttribute) ? { kind: "unresolved", reason: "computed", detail: "Attributes come from a spread", node } : { kind: "undefined", node };
    if (!attribute.initializer) return { kind: "boolean", value: true, node: attribute };
    if (ts.isStringLiteral(attribute.initializer)) return { kind: "string", value: attribute.initializer.text, node: attribute.initializer };
    if (ts.isJsxExpression(attribute.initializer) && attribute.initializer.expression) return resolveValue(tree, attribute.initializer.expression);
    return { kind: "unresolved", reason: "unsupported", detail: "The attribute value is not an expression", node: attribute };
  }
  if ("template" in spec) {
    return ts.isTaggedTemplateExpression(node) ? resolveValue(tree, node.template) : { kind: "undefined", node };
  }
  return module !== undefined ? { kind: "string", value: module, node } : { kind: "undefined", node };
}

function satisfies(rule: Rule, captures: Record<string, StaticValue>): boolean {
  return (rule.where ?? []).every((condition) => {
    const value = captures[condition.capture];
    return value !== undefined && (value.kind === "string" || value.kind === "number" || value.kind === "boolean") && value.value === condition.equals;
  });
}

/**
 * The canonical JSON form of a captured value, for fact values and service
 * facts. Strings are redacted of credentials; fractions are unsupported.
 */
export function captureValue(value: StaticValue): Value {
  switch (value.kind) {
    case "string":
      return { kind: "literal", value: redactCredentials(value.value) };
    case "number":
      return Number.isSafeInteger(value.value) ? { kind: "literal", value: value.value } : { kind: "unresolved", reason: "unsupported", detail: "Only integer numbers are recorded" };
    case "boolean":
      return { kind: "literal", value: value.value };
    case "null":
      return { kind: "literal", value: null };
    case "undefined":
      return { kind: "absent" };
    case "array":
      return { kind: "array", items: value.items.map(captureValue), complete: value.complete };
    case "object":
      return { kind: "object", properties: Object.fromEntries([...value.properties.entries()].map(([key, item]) => [key, captureValue(item)])), complete: value.complete };
    case "template":
      return { kind: "template", parts: value.parts.map((part) => (part.kind === "text" ? { kind: "text", value: redactCredentials(part.value) } : captureValue(part))) };
    case "configured":
      return { kind: "configured", source: value.source, key: value.key };
    case "unresolved":
      return { kind: "unresolved", reason: value.reason, detail: redactCredentials(value.detail) };
  }
}

/** A captured value's literal text, when it is a string or integer. */
export function literalText(value: StaticValue | undefined): string | null {
  if (value?.kind === "string") return redactCredentials(value.value);
  if (value?.kind === "number" && Number.isSafeInteger(value.value)) return String(value.value);
  return null;
}
