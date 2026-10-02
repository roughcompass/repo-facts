import ts from "typescript";
import { bindingSource, flatten, requiredModule } from "./bindings.js";
import { unwrap } from "./static-value.js";
import type { Binding, SyntaxTree } from "./syntax.js";

/**
 * What a JSX tag refers to, read from the file's own bindings.
 *
 * A tag is resolved within its file only: an import names a module and the
 * member path inside it, and nothing is followed into another file. A
 * lowercase, dashed, or namespaced tag is intrinsic, as JSX defines it. A
 * name bound more than once in the file is never resolved, because which
 * binding a tag sees depends on scope.
 */
export type TagReference =
  | { kind: "intrinsic"; name: string }
  | { kind: "module"; module: string; members: readonly string[] }
  | { kind: "local"; name: string; members: readonly string[]; binding: Binding }
  | { kind: "unbound"; name: string; members: readonly string[] }
  | { kind: "unresolved"; reason: "bound_more_than_once" | "computed"; text: string };

/** What the JSX tag +tagName+ refers to. */
export function resolveTag(tree: SyntaxTree, tagName: ts.JsxTagNameExpression): TagReference {
  if (ts.isJsxNamespacedName(tagName)) return { kind: "intrinsic", name: `${tagName.namespace.text}:${tagName.name.text}` };
  if (ts.isIdentifier(tagName) && isIntrinsicName(tagName.text)) return { kind: "intrinsic", name: tagName.text };
  return resolveReference(tree, tagName);
}

/** A styled-wrapper factory, as a module and the member path of its export (empty for the default export). */
export interface StyledFactory {
  module: string;
  members: readonly string[];
}

/** A component that a styled-wrapper factory made from another component or an intrinsic tag. */
export interface StyledWrapper {
  factory: StyledFactory;
  /** What the wrapper wraps: an intrinsic tag for `styled.div` or `styled("div")`, else the reference it was given. */
  target: TagReference;
  /** The styles: a tagged template, or the arguments of an object call. */
  body: { kind: "template"; template: ts.TemplateLiteral } | { kind: "arguments"; arguments: readonly ts.Expression[] };
  node: ts.Expression;
}

/** Configuration calls that return the same kind of factory, such as `styled(Button).attrs({...})`. */
const FACTORY_CONFIGURATION = new Set(["attrs", "withConfig"]);

/**
 * The styled wrapper +binding+ defines, when it is bound once, by `const`, to
 * a call of one of +factories+: ``styled(Button)`...` ``, `styled(Button)({...})`,
 * ``styled.div`...` ``, or `styled("div")({...})`.
 */
export function styledWrapperOf(tree: SyntaxTree, binding: Binding, factories: readonly StyledFactory[]): StyledWrapper | null {
  if (!binding.constant) return null;
  const node = unwrapExpression(binding.constant);
  let body: StyledWrapper["body"];
  let factoryCall: ts.Expression;
  if (ts.isTaggedTemplateExpression(node)) {
    body = { kind: "template", template: node.template };
    factoryCall = node.tag;
  } else if (ts.isCallExpression(node)) {
    body = { kind: "arguments", arguments: node.arguments };
    factoryCall = node.expression;
  } else return null;

  factoryCall = unwrapExpression(factoryCall);
  while (ts.isCallExpression(factoryCall) && ts.isPropertyAccessExpression(factoryCall.expression) && FACTORY_CONFIGURATION.has(factoryCall.expression.name.text)) {
    factoryCall = unwrapExpression(factoryCall.expression.expression);
  }

  if (ts.isCallExpression(factoryCall)) {
    const factory = factoryOf(tree, factoryCall.expression, factories);
    const [wrapped] = factoryCall.arguments;
    if (!factory || !wrapped) return null;
    const literal = unwrapExpression(wrapped);
    const target: TagReference = ts.isStringLiteral(literal) || ts.isNoSubstitutionTemplateLiteral(literal) ? { kind: "intrinsic", name: literal.text } : resolveReference(tree, wrapped);
    return { factory, target, body, node };
  }
  if (ts.isPropertyAccessExpression(factoryCall)) {
    const factory = factoryOf(tree, factoryCall.expression, factories);
    return factory ? { factory, target: { kind: "intrinsic", name: factoryCall.name.text }, body, node } : null;
  }
  return null;
}

function factoryOf(tree: SyntaxTree, expression: ts.Node, factories: readonly StyledFactory[]): StyledFactory | null {
  const reference = resolveReference(tree, expression);
  if (reference.kind !== "module") return null;
  return factories.find((factory) => factory.module === reference.module && factory.members.length === reference.members.length && factory.members.every((member, index) => reference.members[index] === member)) ?? null;
}

function unwrapExpression(node: ts.Expression): ts.Expression {
  return unwrap(node) as ts.Expression;
}

/** JSX treats a tag as a string, not a reference, when it starts lowercase or contains a dash. */
function isIntrinsicName(name: string): boolean {
  const first = name.charCodeAt(0);
  return (first >= 97 && first <= 122) || name.includes("-");
}

/** What an identifier or member access refers to, through the file's bindings, as a value: no name is intrinsic. */
export function resolveReference(tree: SyntaxTree, expression: ts.Node): TagReference {
  const flat = flatten(expression);
  if (!flat) return { kind: "unresolved", reason: "computed", text: tree.text(expression) };
  const required = requiredModule(flat.root);
  if (required) return { kind: "module", module: required, members: flat.chain };
  if (!ts.isIdentifier(flat.root)) return { kind: "unresolved", reason: "computed", text: tree.text(expression) };

  const name = flat.root.text;
  const binding = tree.binding(name);
  if (!binding) return { kind: "unbound", name, members: flat.chain };
  if (binding.kinds.length !== 1) return { kind: "unresolved", reason: "bound_more_than_once", text: tree.text(expression) };
  const [declaration] = binding.declarations;
  const source = declaration ? bindingSource(declaration) : null;
  if (source) return { kind: "module", module: source.module, members: [...source.members, ...flat.chain] };
  return { kind: "local", name, members: flat.chain, binding };
}
