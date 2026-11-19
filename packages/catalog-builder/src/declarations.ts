import path from "node:path";
import ts from "typescript";
import { type PackageFiles, textOf } from "./tarball.js";

/**
 * Components and their props, read from a package's TypeScript declarations.
 * The declarations are type-checked in memory: nothing is written, run, or
 * resolved outside the package, apart from TypeScript's own standard library,
 * so types from other packages, such as React's, stay unresolved and their
 * props aren't listed.
 *
 * A component is an export whose declared type is a React component: a
 * forwardRef, memo, or other exotic component, a function component, a
 * function or call signature that returns an element, or a class extending
 * Component. A prop's values are listed when its declared type allows only
 * a finite set of literals, such as `"solid" | "bordered"` or `boolean`.
 */

export interface DeclaredProp {
  name: string;
  values?: string[];
  deprecated?: true;
}

export interface DeclaredComponent {
  name: string;
  props: DeclaredProp[];
}

const COMPONENT_TYPES = /\b(ForwardRefExoticComponent|NamedExoticComponent|MemoExoticComponent|ExoticComponent|LazyExoticComponent|FunctionComponent|FC|ComponentType|VoidFunctionComponent|VFC)\b/;
const RENDERS = /\b(JSX\.Element|ReactElement|ReactNode|ReactPortal)\b/;
const COMPONENT_NAME = /^[A-Z][A-Za-z0-9]*$/;
const PROP_NAME = /^[A-Za-z_$][A-Za-z0-9_$]*(-[A-Za-z0-9_$]+)*$/;
const PROP_VALUE = /^-?[A-Za-z0-9_][A-Za-z0-9_.:/-]*$/;
const MAX_VALUES = 256;
const MAX_DEPTH = 6;

/** The virtual directory the package's files are read from. */
const ROOT = "/package";

/** The components +pkg+ exports, by name, with their props. */
export function declaredComponents(pkg: PackageFiles): DeclaredComponent[] {
  const program = programFor(pkg);
  if (!program) return [];
  const checker = program.program.getTypeChecker();
  const components: DeclaredComponent[] = [];
  for (const [name, declaration] of program.exports) {
    if (!COMPONENT_NAME.test(name)) continue;
    const props = componentProps(checker, declaration);
    if (props === null) continue;
    components.push({ name, props });
  }
  return components.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** The type-checked program for +pkg+'s declarations, and its entry point's value exports by name. */
function programFor(pkg: PackageFiles): { program: ts.Program; exports: Map<string, ts.Declaration> } | null {
  const typings = typeof pkg.manifest.types === "string" ? pkg.manifest.types : typeof pkg.manifest.typings === "string" ? pkg.manifest.typings : "index.d.ts";
  const entry = path.posix.join(ROOT, path.posix.normalize(typings));
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, lib: ["lib.es2022.d.ts"], types: [], noEmit: true, skipLibCheck: true, strict: true };
  const libDirectory = path.dirname(ts.getDefaultLibFilePath(options));
  const readFile = (fileName: string): string | undefined => {
    if (fileName.startsWith(`${ROOT}/`)) return textOf(pkg, fileName.slice(ROOT.length + 1)) ?? undefined;
    // TypeScript's own standard library, for utility types such as Omit and Pick.
    if (path.dirname(fileName) === libDirectory && path.basename(fileName).startsWith("lib.")) return ts.sys.readFile(fileName);
    return undefined;
  };
  const host: ts.CompilerHost = {
    getSourceFile: (fileName, languageVersion) => {
      const text = readFile(fileName);
      return text === undefined ? undefined : ts.createSourceFile(fileName, text, languageVersion, true);
    },
    getDefaultLibFileName: (compilerOptions) => path.join(libDirectory, ts.getDefaultLibFileName(compilerOptions)),
    getDefaultLibLocation: () => libDirectory,
    writeFile: () => {},
    getCurrentDirectory: () => ROOT,
    getDirectories: () => [],
    directoryExists: (directory) => directory === ROOT || directory.startsWith(`${ROOT}/`) || directory === libDirectory,
    fileExists: (fileName) => readFile(fileName) !== undefined,
    readFile,
    getCanonicalFileName: (fileName) => fileName,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
  };
  if (readFile(entry) === undefined) return null;
  const program = ts.createProgram({ rootNames: [entry], options, host });
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(entry);
  const module = source && checker.getSymbolAtLocation(source);
  if (!module) return null;
  const exports = new Map<string, ts.Declaration>();
  for (const exported of checker.getExportsOfModule(module)) {
    const symbol = exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
    const declaration = symbol.valueDeclaration ?? symbol.declarations?.find((item) => ts.isClassDeclaration(item) || ts.isFunctionDeclaration(item) || ts.isVariableDeclaration(item));
    if (declaration && symbol.flags & ts.SymbolFlags.Value) exports.set(exported.name, declaration);
  }
  return { program, exports };
}

/** The props of the component +declaration+ declares, or null when it isn't a component. */
function componentProps(checker: ts.TypeChecker, declaration: ts.Declaration): DeclaredProp[] | null {
  if (ts.isClassDeclaration(declaration)) {
    const extendsComponent = (declaration.heritageClauses ?? []).some((clause) => /\b(Component|PureComponent)\b/.test(clause.getText()));
    if (!extendsComponent) return null;
    const heritage = declaration.heritageClauses?.flatMap((clause) => clause.types).find((type) => /\b(Component|PureComponent)\b/.test(type.expression.getText()));
    return propsOfNode(checker, heritage?.typeArguments?.[0]);
  }
  if (ts.isFunctionDeclaration(declaration)) {
    if (!declaration.type || !rendersElement(declaration.type)) return null;
    return propsOfNode(checker, declaration.parameters[0]?.type);
  }
  if (ts.isVariableDeclaration(declaration) && declaration.type) return propsOfType(checker, declaration.type, 0);
  return null;
}

/** The props a component type declares, through type aliases and interfaces of this package, or null when the type isn't a component. */
function propsOfType(checker: ts.TypeChecker, type: ts.TypeNode, depth: number): DeclaredProp[] | null {
  if (depth > MAX_DEPTH) return null;
  if (ts.isParenthesizedTypeNode(type)) return propsOfType(checker, type.type, depth + 1);
  // A component type from React, such as ForwardRefExoticComponent<ButtonProps & RefAttributes<...>>.
  const reference = ts.isTypeReferenceNode(type) ? { name: type.typeName.getText(), args: type.typeArguments } : ts.isImportTypeNode(type) && type.qualifier ? { name: type.qualifier.getText(), args: type.typeArguments } : null;
  if (reference && COMPONENT_TYPES.test(reference.name)) return propsOfNode(checker, reference.args?.[0]);
  if (ts.isFunctionTypeNode(type)) return rendersElement(type.type) ? propsOfNode(checker, type.parameters[0]?.type) : null;
  if (ts.isTypeLiteralNode(type)) {
    const call = type.members.find(ts.isCallSignatureDeclaration);
    return call?.type && rendersElement(call.type) ? propsOfNode(checker, call.parameters[0]?.type) : null;
  }
  if (ts.isTypeQueryNode(type)) {
    const symbol = checker.getSymbolAtLocation(type.exprName);
    const target = symbol && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
    const declaration = target?.valueDeclaration;
    if (declaration && ts.isVariableDeclaration(declaration) && declaration.type) return propsOfType(checker, declaration.type, depth + 1);
    if (declaration && ts.isFunctionDeclaration(declaration)) return componentProps(checker, declaration);
    return null;
  }
  if (ts.isTypeReferenceNode(type)) {
    // A type alias or interface of this package, such as `const FlexLayout: FlexLayoutComponent`.
    const symbol = checker.getSymbolAtLocation(type.typeName);
    const target = symbol && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
    for (const declaration of target?.declarations ?? []) {
      if (ts.isTypeAliasDeclaration(declaration)) return propsOfType(checker, declaration.type, depth + 1);
      if (ts.isInterfaceDeclaration(declaration)) {
        const call = declaration.members.find(ts.isCallSignatureDeclaration);
        if (call?.type && rendersElement(call.type)) return propsOfNode(checker, call.parameters[0]?.type);
      }
    }
    return /Component$/.test(type.typeName.getText()) ? [] : null;
  }
  return null;
}

/** Whether a return type is an element, or a component's result, such as `ReturnType<FunctionComponent>`. */
function rendersElement(type: ts.TypeNode): boolean {
  const text = type.getText();
  return RENDERS.test(text) || COMPONENT_TYPES.test(text);
}

/**
 * The props of a props type: the members of every part of it this package
 * declares. A part that doesn't resolve, because it builds on another
 * package's types, such as a polymorphic `PolymorphicComponentPropWithRef<T,
 * { gap?: number }>`, is read through its type arguments and its aliases, so
 * the component's own props are still found.
 */
function propsOfNode(checker: ts.TypeChecker, node: ts.TypeNode | undefined): DeclaredProp[] {
  if (!node) return [];
  const props = new Map<string, DeclaredProp>();
  const expanded = new Set<ts.Node>();
  const visit = (part: ts.TypeNode, depth: number) => {
    if (depth > MAX_DEPTH) return;
    if (ts.isParenthesizedTypeNode(part)) return visit(part.type, depth + 1);
    // Each part of an intersection on its own, so a part from an unresolved package doesn't hide the others.
    if (ts.isIntersectionTypeNode(part)) {
      for (const member of part.types) visit(member, depth + 1);
      return;
    }
    const type = checker.getTypeFromTypeNode(part);
    if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) {
      if (!ts.isTypeReferenceNode(part)) return;
      for (const argument of part.typeArguments ?? []) visit(argument, depth + 1);
      const symbol = checker.getSymbolAtLocation(part.typeName);
      const target = symbol && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
      for (const declaration of target?.declarations ?? []) {
        if (!ts.isTypeAliasDeclaration(declaration) || expanded.has(declaration)) continue;
        expanded.add(declaration);
        visit(declaration.type, depth + 1);
      }
      return;
    }
    if (type.flags & ts.TypeFlags.TypeParameter) return;
    for (const symbol of checker.getPropertiesOfType(type)) {
      if (!PROP_NAME.test(symbol.name) || props.has(symbol.name)) continue;
      const values = finiteValues(checker, checker.getTypeOfSymbolAtLocation(symbol, part));
      const deprecated = symbol.getJsDocTags(checker).some((tag) => tag.name === "deprecated");
      props.set(symbol.name, { name: symbol.name, ...(values && { values }), ...(deprecated && { deprecated: true as const }) });
    }
  };
  visit(node, 0);
  return [...props.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** The literal values +type+ allows, as text, when they're a finite set of plain literals; otherwise undefined. */
function finiteValues(checker: ts.TypeChecker, type: ts.Type): string[] | undefined {
  const members = type.isUnion() ? type.types : [type];
  const values = new Set<string>();
  for (const member of members) {
    if (member.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.Void)) continue;
    if (member.isStringLiteral()) values.add(member.value);
    else if (member.isNumberLiteral()) values.add(String(member.value));
    else if (member.flags & ts.TypeFlags.BooleanLiteral) values.add(checker.typeToString(member));
    else return undefined;
  }
  if (values.size === 0 || values.size > MAX_VALUES || ![...values].every((value) => PROP_VALUE.test(value))) return undefined;
  return [...values].sort();
}
