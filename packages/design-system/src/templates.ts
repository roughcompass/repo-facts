import type { BlobContent } from "@repo-facts/contract";
import { type StylesheetResult, type SyntaxTree, parseStylesheet } from "@repo-facts/syntax";
import ts from "typescript";
import type { Scope } from "./scope.js";
import type { StyleSource } from "./styles.js";

/**
 * A styling-adapter template body, such as ``styled.div`color: ${tone};` ``,
 * parsed as a CSS declaration list. Each interpolation is replaced by a
 * placeholder of the same length, so offsets in the parsed text map straight
 * back to the file, and every value that touches one is unresolved.
 */
export function templateSource(tree: SyntaxTree, template: ts.TemplateLiteral, scope: Scope): { source: StyleSource } | { failure: Extract<StylesheetResult, { ok: false }>["failure"] } {
  const text = tree.file.text;
  const base = template.getStart(tree.file) + 1;
  const end = template.getEnd() - 1;
  const interpolations: [number, number][] = [];
  if (ts.isTemplateExpression(template)) {
    let previous: ts.Node = template.head;
    for (const span of template.templateSpans) {
      // From the `${` that ends the previous literal through the `}` that starts the next.
      interpolations.push([previous.getEnd() - 2 - base, span.literal.getStart(tree.file) + 1 - base]);
      previous = span.literal;
    }
  }
  let body = text.slice(base, end);
  for (const [start, stop] of interpolations) body = `${body.slice(0, start)}${"_".repeat(stop - start)}${body.slice(stop)}`;
  const result = parseStylesheet(body, { mode: "declarations" });
  if (!result.ok) return { failure: result.failure };
  const content: BlobContent = tree.content;
  const lineAt = (offset: number) => tree.file.getLineAndCharacterOfPosition(offset).line + 1;
  return { source: { path: tree.path, scope, content, kind: "template", stylesheet: result.stylesheet, base, lineAt, interpolations } };
}
