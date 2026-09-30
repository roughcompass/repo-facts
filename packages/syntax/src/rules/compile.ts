import { StructuredParseError, compareCodeUnits, digestOf, dump, parseCanonical, parseYaml } from "@repo-facts/contract";
import { type Rule, ruleFileSchema } from "./schema.js";

/**
 * Compiles rule files (YAML text) into validated, canonical rule data. Every
 * problem across every file is reported together. Compiled rules are sorted
 * by id, with each rule's `instanceOf` target ordered before it.
 */

export interface RuleSource {
  path: string;
  text: string;
}

export type CompileResult = { ok: true; rules: Rule[]; digest: string } | { ok: false; problems: string[] };

export function compileRules(sources: readonly RuleSource[]): CompileResult {
  const problems: string[] = [];
  const rules: Rule[] = [];
  for (const source of [...sources].sort((a, b) => compareCodeUnits(a.path, b.path))) {
    let document: unknown;
    try {
      document = parseYaml(source.text);
    } catch (error) {
      if (!(error instanceof StructuredParseError)) throw error;
      problems.push(`${source.path}: ${error.message}`);
      continue;
    }
    const parsed = ruleFileSchema.safeParse(document);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) problems.push(`${source.path}: ${issue.path.join(".") || "(file)"}: ${issue.message}`);
      continue;
    }
    rules.push(...parsed.data.rules);
  }

  const ids = new Map<string, number>();
  for (const rule of rules) ids.set(rule.id, (ids.get(rule.id) ?? 0) + 1);
  for (const [id, count] of ids) if (count > 1) problems.push(`rule ${id} is defined ${count} times`);
  for (const rule of rules) {
    const callee = "call" in rule.match ? rule.match.call : "new" in rule.match ? rule.match.new : "tagged" in rule.match ? rule.match.tagged : undefined;
    if (callee?.instanceOf && !ids.has(callee.instanceOf)) problems.push(`rule ${rule.id} is an instance of unknown rule ${callee.instanceOf}`);
    for (const condition of rule.where ?? []) if (!rule.capture?.[condition.capture] && condition.capture !== "method" && condition.capture !== "calleeModule") problems.push(`rule ${rule.id} tests capture ${condition.capture}, which it does not define`);
  }
  if (problems.length) return { ok: false, problems };

  const ordered = orderByInstance(rules.sort((a, b) => compareCodeUnits(a.id, b.id)), problems);
  if (problems.length) return { ok: false, problems };
  // Round-trip through canonical JSON so compiled rules are plain, inert data.
  const canonical = parseCanonical(dump(ordered)) as unknown as Rule[];
  return { ok: true, rules: canonical, digest: rulesDigest(canonical) };
}

export function rulesDigest(rules: readonly Rule[]): string {
  return digestOf(rules).digest;
}

function orderByInstance(rules: Rule[], problems: string[]): Rule[] {
  const byId = new Map(rules.map((rule) => [rule.id, rule]));
  const ordered: Rule[] = [];
  const state = new Map<string, "visiting" | "done">();
  const visit = (rule: Rule) => {
    if (state.get(rule.id) === "done") return;
    if (state.get(rule.id) === "visiting") {
      problems.push(`rule ${rule.id} is part of an instanceOf cycle`);
      return;
    }
    state.set(rule.id, "visiting");
    const callee = "call" in rule.match ? rule.match.call : "new" in rule.match ? rule.match.new : "tagged" in rule.match ? rule.match.tagged : undefined;
    const target = callee?.instanceOf ? byId.get(callee.instanceOf) : undefined;
    if (target) visit(target);
    state.set(rule.id, "done");
    ordered.push(rule);
  };
  for (const rule of rules) visit(rule);
  return ordered;
}
