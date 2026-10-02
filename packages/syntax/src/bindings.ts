import ts from "typescript";
import { propertyName, unwrap } from "./static-value.js";

/**
 * What a file's import and `require` bindings refer to, read as syntax.
 * The rules engine and tag resolution share these, so a callee and a JSX tag
 * bound the same way resolve the same way.
 */

/** The module and member path a binding refers to, for imports and `require` bindings. */
export function bindingSource(declaration: ts.Node): { module: string; members: string[] } | null {
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
export function requireChain(node: ts.Node): { module: string; members: string[] } | null {
  const flat = flatten(node);
  if (!flat) return null;
  const module = requiredModule(flat.root);
  return module ? { module, members: flat.chain } : null;
}

/** `require("m")` with a literal specifier, read as syntax; it is never called. */
export function requiredModule(node: ts.Node): string | null {
  const call = unwrap(node);
  if (!ts.isCallExpression(call) || !ts.isIdentifier(call.expression) || call.expression.text !== "require" || call.arguments.length !== 1) return null;
  const [argument] = call.arguments;
  return argument && (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)) ? argument.text : null;
}

/** Splits `a.b["c"].d` into its root and member names. */
export function flatten(expression: ts.Node): { root: ts.Node; chain: string[] } | null {
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
