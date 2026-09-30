import ts from "typescript";
import type { BlobContent } from "@repo-facts/contract";

/**
 * Parse-only syntax trees for JavaScript and TypeScript, including JSX and TSX.
 *
 * Only the TypeScript compiler's scanner and parser run: no Program, type
 * checker, module resolution, transpilation, or evaluation. A tree is built
 * from bytes the SnapshotReader already admitted under its per-blob budget,
 * and it is discarded when it exceeds the node or depth limit. A file with
 * syntax errors is skipped, never half-read.
 *
 * The parser version is part of the detector configuration, so upgrading the
 * parser produces a new detector release.
 */

export const SYNTAX_PARSER = { name: "typescript", version: ts.version } as const;
export const SYNTAX_NODE_LIMIT = 200_000;
export const SYNTAX_DEPTH_LIMIT = 500;

export const DIALECTS = ["js", "jsx", "ts", "tsx"] as const;
export type Dialect = (typeof DIALECTS)[number];

const EXTENSIONS: ReadonlyMap<string, Dialect> = new Map([
  [".js", "js"],
  [".mjs", "js"],
  [".cjs", "js"],
  [".jsx", "jsx"],
  [".ts", "ts"],
  [".mts", "ts"],
  [".cts", "ts"],
  [".tsx", "tsx"],
]);

const SCRIPT_KINDS: Record<Dialect, ts.ScriptKind> = { js: ts.ScriptKind.JS, jsx: ts.ScriptKind.JSX, ts: ts.ScriptKind.TS, tsx: ts.ScriptKind.TSX };

/** The dialect a path is parsed as, or null when it is not JavaScript or TypeScript source. */
export function dialectOf(path: string): Dialect | null {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? (EXTENSIONS.get(name.slice(dot).toLowerCase()) ?? null) : null;
}

export type SyntaxFailureReason = "not_source" | "syntax_error" | "syntax_node_limit" | "syntax_depth_limit";

export interface SyntaxFailure {
  path: string;
  reason: SyntaxFailureReason;
  detail: string;
}

export type SyntaxResult = { ok: true; tree: SyntaxTree } | { ok: false; failure: SyntaxFailure };

export interface SyntaxLimits {
  nodes: number;
  depth: number;
}

/** A 1-based line and column (in UTF-16 code units) in the committed text. */
export interface SourcePoint {
  line: number;
  column: number;
}

export interface SourcePosition {
  start: SourcePoint;
  end: SourcePoint;
  /** Offsets into the text, excluding leading trivia. */
  offset: number;
  length: number;
}

export type BindingKind = "const" | "let" | "var" | "parameter" | "import" | "function" | "class" | "enum" | "catch";

/** Every binding of one name in a file. */
export interface Binding {
  name: string;
  kinds: readonly BindingKind[];
  /** The initializer, when the name is bound exactly once, by a const declaration with an identifier. */
  constant: ts.Expression | null;
  declarations: readonly ts.Node[];
}

export class SyntaxTree {
  private constructor(
    readonly content: BlobContent,
    readonly dialect: Dialect,
    readonly file: ts.SourceFile,
    readonly nodeCount: number,
    private readonly bindings: ReadonlyMap<string, Binding>,
  ) {}

  get path(): string {
    return this.content.entry.path;
  }

  static parse(content: BlobContent, limits: SyntaxLimits = { nodes: SYNTAX_NODE_LIMIT, depth: SYNTAX_DEPTH_LIMIT }): SyntaxResult {
    const path = content.entry.path;
    const dialect = dialectOf(path);
    if (!dialect || content.text === null) return { ok: false, failure: { path, reason: "not_source", detail: "Only JavaScript and TypeScript text is parsed" } };

    let file: ts.SourceFile;
    try {
      file = ts.createSourceFile(path, content.text, { languageVersion: ts.ScriptTarget.Latest, jsDocParsingMode: ts.JSDocParsingMode.ParseNone }, true, SCRIPT_KINDS[dialect]);
    } catch (error) {
      // The parser is recursive; pathological nesting can exhaust the stack.
      if (error instanceof RangeError) return { ok: false, failure: { path, reason: "syntax_depth_limit", detail: "The file nests too deeply to parse" } };
      throw error;
    }

    const [problem] = parseDiagnosticsOf(file);
    if (problem) {
      const line = problem.start === undefined ? null : file.getLineAndCharacterOfPosition(problem.start).line + 1;
      const message = ts.flattenDiagnosticMessageText(problem.messageText, " ").slice(0, 200);
      return { ok: false, failure: { path, reason: "syntax_error", detail: line ? `Line ${line}: ${message}` : message } };
    }

    const survey = surveyTree(file, limits);
    if ("failure" in survey) return { ok: false, failure: { path, ...survey.failure } };
    return { ok: true, tree: new SyntaxTree(content, dialect, file, survey.nodes, survey.bindings) };
  }

  /** Visits every node in source order without recursion. Return false to skip a node's children. */
  walk(visit: (node: ts.Node) => boolean | void): void {
    const stack: ts.Node[] = [this.file];
    while (stack.length) {
      const node = stack.pop()!;
      if (node !== this.file && visit(node) === false) continue;
      const children: ts.Node[] = [];
      ts.forEachChild(node, (child) => void children.push(child));
      for (let index = children.length - 1; index >= 0; index--) stack.push(children[index]!);
    }
  }

  position(node: ts.Node): SourcePosition {
    const offset = node.getStart(this.file);
    const end = node.getEnd();
    const point = (at: number): SourcePoint => {
      const { line, character } = this.file.getLineAndCharacterOfPosition(at);
      return { line: line + 1, column: character + 1 };
    };
    return { start: point(offset), end: point(end), offset, length: end - offset };
  }

  /** The 1-based line range a node covers, for line evidence. */
  lines(node: ts.Node): { start: number; end: number } {
    const { start, end } = this.position(node);
    // A node ending at column 1 ends on the previous line's newline.
    return { start: start.line, end: end.column === 1 && end.line > start.line ? end.line - 1 : end.line };
  }

  text(node: ts.Node): string {
    return node.getText(this.file);
  }

  /** Every binding of +name+ in the file, or undefined when the name is not bound here. */
  binding(name: string): Binding | undefined {
    return this.bindings.get(name);
  }
}

function parseDiagnosticsOf(file: ts.SourceFile): readonly ts.DiagnosticWithLocation[] {
  // parseDiagnostics is populated by createSourceFile itself. The public
  // accessor, getSyntacticDiagnostics, needs a Program, which this layer never creates.
  return (file as ts.SourceFile & { parseDiagnostics?: readonly ts.DiagnosticWithLocation[] }).parseDiagnostics ?? [];
}

type Survey = { nodes: number; bindings: Map<string, Binding> } | { failure: { reason: SyntaxFailureReason; detail: string } };

/** Counts nodes, enforces the limits, and records every value binding. */
function surveyTree(file: ts.SourceFile, limits: SyntaxLimits): Survey {
  const bindings = new Map<string, { kinds: BindingKind[]; declarations: ts.Node[]; constants: ts.Expression[] }>();
  const bind = (name: ts.Node | undefined, kind: BindingKind, declaration: ts.Node, constant?: ts.Expression) => {
    if (!name || !ts.isIdentifier(name)) return;
    const entry = bindings.get(name.text) ?? { kinds: [], declarations: [], constants: [] };
    entry.kinds.push(kind);
    entry.declarations.push(declaration);
    if (constant) entry.constants.push(constant);
    bindings.set(name.text, entry);
  };

  let nodes = 0;
  const stack: [ts.Node, number][] = [[file, 0]];
  while (stack.length) {
    const [node, depth] = stack.pop()!;
    if (++nodes > limits.nodes) return { failure: { reason: "syntax_node_limit", detail: `The file has more than ${limits.nodes} syntax nodes` } };
    if (depth > limits.depth) return { failure: { reason: "syntax_depth_limit", detail: `The file nests more than ${limits.depth} syntax levels` } };

    if (ts.isVariableDeclaration(node)) {
      const flags = ts.getCombinedNodeFlags(node);
      const kind: BindingKind = flags & ts.NodeFlags.Const ? "const" : flags & (ts.NodeFlags.Let | ts.NodeFlags.Using | ts.NodeFlags.AwaitUsing) ? "let" : "var";
      const catchVariable = ts.isCatchClause(node.parent);
      bind(node.name, catchVariable ? "catch" : kind, node, kind === "const" && !catchVariable ? node.initializer : undefined);
    } else if (ts.isBindingElement(node)) {
      const list = findVariableList(node);
      bind(node.name, list && ts.getCombinedNodeFlags(list) & ts.NodeFlags.Const ? "const" : ts.isParameter(bindingRoot(node)) ? "parameter" : "let", node);
    } else if (ts.isParameter(node)) bind(node.name, "parameter", node);
    else if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) bind(node.name, "function", node);
    else if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) bind(node.name, "class", node);
    else if (ts.isEnumDeclaration(node)) bind(node.name, "enum", node);
    else if (ts.isImportClause(node)) bind(node.name, "import", node);
    else if (ts.isImportSpecifier(node) || ts.isNamespaceImport(node) || ts.isImportEqualsDeclaration(node)) bind(node.name, "import", node);

    const children: ts.Node[] = [];
    ts.forEachChild(node, (child) => void children.push(child));
    for (let index = children.length - 1; index >= 0; index--) stack.push([children[index]!, depth + 1]);
  }

  const result = new Map<string, Binding>();
  for (const [name, entry] of bindings) {
    const unique = entry.kinds.length === 1 && entry.kinds[0] === "const" && entry.constants.length === 1;
    result.set(name, { name, kinds: entry.kinds, constant: unique ? entry.constants[0]! : null, declarations: entry.declarations });
  }
  return { nodes, bindings: result };
}

function bindingRoot(node: ts.Node): ts.Node {
  let current = node;
  while (ts.isBindingElement(current) || ts.isObjectBindingPattern(current) || ts.isArrayBindingPattern(current)) current = current.parent;
  return current;
}

function findVariableList(node: ts.BindingElement): ts.VariableDeclarationList | null {
  const root = bindingRoot(node);
  return ts.isVariableDeclaration(root) && ts.isVariableDeclarationList(root.parent) ? root.parent : null;
}
