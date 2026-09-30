import ts from "typescript";
import type { SyntaxTree } from "./syntax.js";

/**
 * Resolves what an expression denotes from syntax alone: literals, object and
 * array literals, same-file const bindings, string concatenation, template
 * literals, and configuration reads such as process.env.API_URL.
 *
 * Nothing is executed. A value computed at runtime, imported from another
 * file, bound more than once, or otherwise not determined by the syntax is
 * "unresolved" with a reason, never guessed. Every result keeps the node it
 * came from, so evidence can cite the literal as well as its use site.
 */

export type UnresolvedReason = "computed" | "imported" | "parameter" | "reassignable" | "ambiguous_binding" | "unbound" | "cycle" | "depth" | "unsupported";

export type ConfigSource = "process.env" | "import.meta.env";

export type StaticValue =
  | { kind: "string"; value: string; node: ts.Node }
  | { kind: "number"; value: number; node: ts.Node }
  | { kind: "boolean"; value: boolean; node: ts.Node }
  | { kind: "null"; node: ts.Node }
  | { kind: "undefined"; node: ts.Node }
  | { kind: "array"; items: StaticValue[]; complete: boolean; node: ts.Node }
  | { kind: "object"; properties: ReadonlyMap<string, StaticValue>; complete: boolean; node: ts.Node }
  | { kind: "template"; parts: TemplatePart[]; node: ts.Node }
  | { kind: "configured"; source: ConfigSource; key: string; node: ts.Node }
  | { kind: "unresolved"; reason: UnresolvedReason; detail: string; node: ts.Node };

/** A piece of a partly resolved string: literal text, a configuration read, or an unresolved span. */
export type TemplatePart = { kind: "text"; value: string } | Extract<StaticValue, { kind: "configured" | "unresolved" }>;

const MAX_DEPTH = 32;

export function resolveValue(tree: SyntaxTree, expression: ts.Node): StaticValue {
  return new Resolver(tree).resolve(expression, 0, new Set());
}

/** The literal string an expression denotes, or null. */
export function resolveString(tree: SyntaxTree, expression: ts.Node): string | null {
  const value = resolveValue(tree, expression);
  return value.kind === "string" ? value.value : null;
}

/** A property of a resolved object, or undefined when the object lacks it or the value is not an object. */
export function propertyOf(value: StaticValue, name: string): StaticValue | undefined {
  return value.kind === "object" ? value.properties.get(name) : undefined;
}

/** The name of a property, when it is written literally. */
export function propertyName(name: ts.PropertyName | ts.MemberName): string | null {
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) return name.text;
  if (ts.isNumericLiteral(name)) return String(Number(name.text));
  return null;
}

/** Removes parentheses, type assertions, `satisfies`, and non-null assertions, which do not change a value. */
export function unwrap(node: ts.Node): ts.Node {
  let current = node;
  while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isSatisfiesExpression(current) || ts.isTypeAssertionExpression(current) || ts.isNonNullExpression(current)) {
    current = current.expression;
  }
  return current;
}

class Resolver {
  constructor(private readonly tree: SyntaxTree) {}

  resolve(input: ts.Node, depth: number, resolving: Set<string>): StaticValue {
    const node = unwrap(input);
    if (depth > MAX_DEPTH) return unresolved("depth", "The value is nested too deeply to resolve", node);

    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return { kind: "string", value: node.text, node };
    if (ts.isNumericLiteral(node)) return { kind: "number", value: Number(node.text), node };
    if (node.kind === ts.SyntaxKind.TrueKeyword) return { kind: "boolean", value: true, node };
    if (node.kind === ts.SyntaxKind.FalseKeyword) return { kind: "boolean", value: false, node };
    if (node.kind === ts.SyntaxKind.NullKeyword) return { kind: "null", node };
    if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(node.operand)) return { kind: "number", value: -Number(node.operand.text), node };
    if (ts.isIdentifier(node)) return this.identifier(node, depth, resolving);
    if (ts.isTemplateExpression(node)) return this.template(node, depth, resolving);
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) return this.concatenation(node, depth, resolving);
    if (ts.isArrayLiteralExpression(node)) return this.array(node, depth, resolving);
    if (ts.isObjectLiteralExpression(node)) return this.object(node, depth, resolving);
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) return this.member(node, depth, resolving);
    if (ts.isTaggedTemplateExpression(node)) return unresolved("computed", "A tagged template is computed by its tag function", node);
    if (ts.isCallExpression(node) || ts.isNewExpression(node) || ts.isAwaitExpression(node)) return unresolved("computed", "The value is computed at runtime", node);
    if (ts.isConditionalExpression(node) || ts.isBinaryExpression(node)) return unresolved("computed", "The value depends on a runtime condition", node);
    return unresolved("unsupported", `${ts.SyntaxKind[node.kind]} is not resolved statically`, node);
  }

  private identifier(node: ts.Identifier, depth: number, resolving: Set<string>): StaticValue {
    if (node.text === "undefined") return { kind: "undefined", node };
    const binding = this.tree.binding(node.text);
    if (!binding) return unresolved("unbound", `${node.text} is not bound in this file`, node);
    if (binding.kinds.length > 1) return unresolved("ambiguous_binding", `${node.text} is bound more than once in this file`, node);
    if (binding.constant) {
      if (resolving.has(node.text)) return unresolved("cycle", `${node.text} refers to itself`, node);
      resolving.add(node.text);
      try {
        return this.resolve(binding.constant, depth + 1, resolving);
      } finally {
        resolving.delete(node.text);
      }
    }
    const [kind] = binding.kinds;
    if (kind === "import") return unresolved("imported", `${node.text} is imported from another module`, node);
    if (kind === "parameter" || kind === "catch") return unresolved("parameter", `${node.text} is supplied by a caller`, node);
    if (kind === "let" || kind === "var") return unresolved("reassignable", `${node.text} can be reassigned`, node);
    return unresolved("computed", `${node.text} is not a constant value`, node);
  }

  private template(node: ts.TemplateExpression, depth: number, resolving: Set<string>): StaticValue {
    const parts: TemplatePart[] = [{ kind: "text", value: node.head.text }];
    for (const span of node.templateSpans) {
      parts.push(...this.stringParts(span.expression, depth, resolving));
      parts.push({ kind: "text", value: span.literal.text });
    }
    return fromParts(parts, node);
  }

  private concatenation(node: ts.BinaryExpression, depth: number, resolving: Set<string>): StaticValue {
    const left = this.resolve(node.left, depth + 1, resolving);
    const right = this.resolve(node.right, depth + 1, resolving);
    const stringy = (value: StaticValue) => value.kind === "string" || value.kind === "template" || value.kind === "configured";
    if (!stringy(left) && !stringy(right)) return unresolved("computed", "The value is computed from non-string operands", node);
    return fromParts([...toParts(left), ...toParts(right)], node);
  }

  /** Parts for a value interpolated into a string. */
  private stringParts(expression: ts.Node, depth: number, resolving: Set<string>): TemplatePart[] {
    return toParts(this.resolve(expression, depth + 1, resolving));
  }

  private array(node: ts.ArrayLiteralExpression, depth: number, resolving: Set<string>): StaticValue {
    const items: StaticValue[] = [];
    let complete = true;
    for (const element of node.elements) {
      if (ts.isSpreadElement(element) || ts.isOmittedExpression(element)) complete = false;
      else items.push(this.resolve(element, depth + 1, resolving));
    }
    return { kind: "array", items, complete, node };
  }

  private object(node: ts.ObjectLiteralExpression, depth: number, resolving: Set<string>): StaticValue {
    const properties = new Map<string, StaticValue>();
    let complete = true;
    for (const property of node.properties) {
      if (ts.isPropertyAssignment(property)) {
        const name = propertyName(property.name);
        if (name === null || name === "__proto__") complete = false;
        else properties.set(name, this.resolve(property.initializer, depth + 1, resolving));
      } else if (ts.isShorthandPropertyAssignment(property)) {
        properties.set(property.name.text, this.resolve(property.name, depth + 1, resolving));
      } else if (ts.isMethodDeclaration(property)) {
        const name = propertyName(property.name);
        if (name === null) complete = false;
        else properties.set(name, unresolved("computed", `${name} is a method`, property));
      } else {
        // Spreads and accessors can add or override any property.
        complete = false;
      }
    }
    return { kind: "object", properties, complete, node };
  }

  private member(node: ts.PropertyAccessExpression | ts.ElementAccessExpression, depth: number, resolving: Set<string>): StaticValue {
    const name = ts.isPropertyAccessExpression(node) ? node.name.text : literalKey(node.argumentExpression);
    const target = unwrap(node.expression);
    const source = configSource(target);
    if (source) {
      return name === null ? unresolved("computed", `The ${source} key is computed`, node) : { kind: "configured", source, key: name, node };
    }
    if (name === null) return unresolved("computed", "The property name is computed", node);

    const object = this.resolve(target, depth + 1, resolving);
    if (object.kind === "unresolved") return unresolved(object.reason, `${object.detail} (reading ${name})`, node);
    if (object.kind === "object") {
      const value = object.properties.get(name);
      if (value) return value;
      return object.complete ? { kind: "undefined", node } : unresolved("computed", `${name} may come from a spread or accessor`, node);
    }
    if (object.kind === "array" && /^(0|[1-9][0-9]*)$/.test(name)) {
      const item = object.complete ? object.items[Number(name)] : undefined;
      return item ?? unresolved("computed", `Element ${name} is not determined statically`, node);
    }
    return unresolved("unsupported", `Reading ${name} from a ${object.kind} value is not resolved statically`, node);
  }
}

/** `process.env` or `import.meta.env`, the configuration sources a key can be read from. */
function configSource(node: ts.Node): ConfigSource | null {
  if (!ts.isPropertyAccessExpression(node) || node.name.text !== "env") return null;
  const target = unwrap(node.expression);
  if (ts.isIdentifier(target) && target.text === "process") return "process.env";
  if (ts.isMetaProperty(target) && target.keywordToken === ts.SyntaxKind.ImportKeyword && target.name.text === "meta") return "import.meta.env";
  return null;
}

function literalKey(node: ts.Expression): string | null {
  const key = unwrap(node);
  if (ts.isStringLiteral(key) || ts.isNoSubstitutionTemplateLiteral(key)) return key.text;
  if (ts.isNumericLiteral(key)) return String(Number(key.text));
  return null;
}

function toParts(value: StaticValue): TemplatePart[] {
  switch (value.kind) {
    case "string":
      return [{ kind: "text", value: value.value }];
    case "number":
    case "boolean":
      return [{ kind: "text", value: String(value.value) }];
    case "null":
      return [{ kind: "text", value: "null" }];
    case "template":
      return value.parts;
    case "configured":
    case "unresolved":
      return [value];
    default:
      return [unresolved("computed", `A ${value.kind} value is converted to text at runtime`, value.node)];
  }
}

/** Joins adjacent text and collapses a fully literal result to a string. */
function fromParts(parts: readonly TemplatePart[], node: ts.Node): StaticValue {
  const merged: TemplatePart[] = [];
  for (const part of parts) {
    const last = merged.at(-1);
    if (part.kind === "text" && last?.kind === "text") merged[merged.length - 1] = { kind: "text", value: last.value + part.value };
    else if (part.kind !== "text" || part.value !== "") merged.push(part);
  }
  if (merged.every((part) => part.kind === "text")) return { kind: "string", value: merged.map((part) => (part as { value: string }).value).join(""), node };
  return { kind: "template", parts: merged, node };
}

function unresolved(reason: UnresolvedReason, detail: string, node: ts.Node): StaticValue & { kind: "unresolved" } {
  return { kind: "unresolved", reason, detail, node };
}
