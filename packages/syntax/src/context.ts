import type { BlobContent, DetectorContext, Evidence } from "@repo-facts/contract";
import type ts from "typescript";
import { type Stylesheet, parseStylesheet } from "./stylesheet.js";
import { SyntaxTree, dialectOf } from "./syntax.js";

/** Detector id recorded on diagnostics from the shared syntax layer. */
export const SYNTAX_LAYER = "syntax";
const TREES = "syntax.trees";
const STYLESHEETS = "syntax.stylesheets";

/**
 * The parse-only syntax tree of a JavaScript or TypeScript file, parsed once
 * per run and shared by every detector. Syntax errors and limit cutoffs are
 * recorded once, as skipped-input diagnostics from the syntax layer, and
 * return null.
 */
export function syntaxOf(context: DetectorContext, path: string): Promise<SyntaxTree | null> {
  if (!dialectOf(path)) return Promise.resolve(null);
  let trees = context.shared.get(TREES) as Map<string, Promise<SyntaxTree | null>> | undefined;
  if (!trees) {
    trees = new Map();
    context.shared.set(TREES, trees);
  }
  let tree = trees.get(path);
  if (!tree) {
    tree = context.text(path).then((content) => {
      if (!content) return null;
      const result = SyntaxTree.parse(content);
      if (result.ok) return result.tree;
      context.diagnostic(path, result.failure.reason, result.failure.detail, { detector: SYNTAX_LAYER });
      return null;
    });
    trees.set(path, tree);
  }
  return tree;
}

/** A parsed stylesheet, as the syntax tree of a CSS file. */
export interface ParsedStylesheet {
  path: string;
  content: BlobContent;
  stylesheet: Stylesheet;
}

/**
 * The parsed stylesheet at +path+, parsed once per run and shared by every
 * detector. Limit cutoffs are recorded once, as skipped-input diagnostics
 * from the syntax layer, and return null; the stylesheet is never partly read.
 */
export function stylesheetOf(context: DetectorContext, path: string): Promise<ParsedStylesheet | null> {
  let sheets = context.shared.get(STYLESHEETS) as Map<string, Promise<ParsedStylesheet | null>> | undefined;
  if (!sheets) {
    sheets = new Map();
    context.shared.set(STYLESHEETS, sheets);
  }
  let sheet = sheets.get(path);
  if (!sheet) {
    sheet = context.text(path).then((content) => {
      if (!content || content.text === null) return null;
      const result = parseStylesheet(content.text);
      if (result.ok) return { path, content, stylesheet: result.stylesheet };
      context.diagnostic(path, result.failure.reason, result.failure.detail, { detector: SYNTAX_LAYER });
      return null;
    });
    sheets.set(path, sheet);
  }
  return sheet;
}

/** Line evidence for a syntax node. */
export function nodeEvidence(context: DetectorContext, tree: SyntaxTree, node: ts.Node, rule: string): Evidence {
  const { start, end } = tree.lines(node);
  return context.lines(tree.content, rule, start, end);
}
