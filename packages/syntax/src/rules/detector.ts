import { type Detector, type DetectorContext, type Evidence, type Stage, type Value, compareCodeUnits } from "@repo-facts/contract";
import { nodeEvidence, syntaxOf } from "../context.js";
import type { SyntaxTree } from "../syntax.js";
import { type RuleMatch, captureValue, literalText, matchRules } from "./engine.js";
import type { Rule } from "./schema.js";

/**
 * A detector built from rules: it parses each source file once, evaluates
 * every rule, and reports what the rules emit. Fact and reference emits are
 * reported directly from their templates. Every match, including service and
 * signal emits, is also passed to `onMatch`, where detector code can turn it
 * into candidates or draw conclusions across matches.
 */

export interface MatchedRule extends RuleMatch {
  tree: SyntaxTree;
  evidence: Evidence;
}

export interface RuleDetectorOptions {
  id: string;
  version: string;
  stage: Stage;
  rules: readonly Rule[];
  /** Source files the rules run over. */
  sources(context: DetectorContext): readonly string[];
  /** Categories searched besides those fact emits name, such as a service detector's. */
  categories?: readonly string[];
  onMatch?(context: DetectorContext, match: MatchedRule): void;
}

export function ruleDetector(options: RuleDetectorOptions): Detector {
  const factCategories = [...new Set(options.rules.flatMap((rule) => ("fact" in rule.emit ? [rule.emit.fact.category] : [])))];
  const categories = [...new Set([...factCategories, ...(options.categories ?? [])])].sort(compareCodeUnits);
  return {
    id: options.id,
    version: options.version,
    stage: options.stage,
    inputs: ["**/*.js", "**/*.jsx", "**/*.mjs", "**/*.cjs", "**/*.ts", "**/*.tsx", "**/*.mts", "**/*.cts"],
    categories,
    async run(context) {
      const sources = [...options.sources(context)].sort(compareCodeUnits);
      const skipped: string[] = [];
      for (const path of sources) {
        const tree = await syntaxOf(context, path);
        if (!tree) {
          skipped.push(path);
          continue;
        }
        for (const match of matchRules(tree, options.rules)) {
          const matched: MatchedRule = { ...match, tree, evidence: nodeEvidence(context, tree, match.node, match.rule.id) };
          emit(context, matched);
          options.onMatch?.(context, matched);
        }
      }
      for (const category of categories) context.search({ category, rule: options.id, surface: sources, complete: true, skipped });
    },
  };
}

function emit(context: DetectorContext, match: MatchedRule) {
  const { rule } = match;
  if ("fact" in rule.emit) {
    const { fact } = rule.emit;
    context.fact({
      category: fact.category,
      key: interpolate(fact.key, match) ?? `${match.tree.path}:${match.tree.lines(match.node).start}`,
      value: fill(fact.value as Value, match),
      basis: fact.basis,
      evidence: [match.evidence],
      rule: rule.id,
      ...(fact.reasoning !== undefined && { reasoning: fact.reasoning }),
    });
  } else if ("reference" in rule.emit) {
    const { reference } = rule.emit;
    const identifier: Record<string, string> = {};
    for (const [field, template] of Object.entries(reference.identifier)) {
      const text = interpolate(template, match);
      if (text === null) {
        context.diagnostic(match.tree.path, "unresolved_reference", `${rule.id} at line ${match.tree.lines(match.node).start}: ${field} is not a literal`);
        return;
      }
      identifier[field] = text;
    }
    context.reference({ type: reference.type, role: reference.role, identifier, basis: reference.basis, evidence: [match.evidence], rule: rule.id });
  }
}

/** Replaces each `{capture}` with its literal text; null when any capture is not a literal. */
export function interpolate(template: string, match: RuleMatch): string | null {
  let unresolved = false;
  const text = template.replace(/\{([A-Za-z_$][A-Za-z0-9_$]*)\}/g, (_whole, name: string) => {
    const literal = literalText(match.captures[name]);
    if (literal === null) unresolved = true;
    return literal ?? "";
  });
  return unresolved ? null : text;
}

/** Replaces every string exactly `$capture` in +template+ with that capture's value. */
export function fill(template: Value, match: RuleMatch): Value {
  if (typeof template === "string" && template.startsWith("$")) {
    const value = match.captures[template.slice(1)];
    return value ? captureValue(value) : { kind: "absent" };
  }
  if (Array.isArray(template)) return template.map((item) => fill(item, match));
  if (template && typeof template === "object") return Object.fromEntries(Object.entries(template).map(([key, item]) => [key, fill(item, match)]));
  return template;
}
