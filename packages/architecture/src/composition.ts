import { type BlobContent, type Detector, type DetectorContext, type Evidence, type Value, compareCodeUnits, isSensitivePath, parseJson, pointerOf, redactCredentials } from "@repo-facts/contract";
import { inventoryOf, isVendored, readableInputs, unanalyzedInputs } from "@repo-facts/core";
import { type MatchedRule, type StaticValue, type SyntaxTree, captureValue, literalText, nodeEvidence, ruleDetector, syntaxOf } from "@repo-facts/syntax";
import ts from "typescript";
import { RULES } from "./rules.generated.js";

/**
 * Composition and runtime-contract signals: single-spa registrations and
 * roles, import maps, Module Federation, embedded frames, and window messaging.
 *
 * Rules report what a literal syntactic position states. This detector adds
 * what needs more than one match: a single-spa root configuration is inferred
 * from registrations together with `start()`, and an application from its
 * lifecycles. Module Federation configuration becomes one fact per build with
 * its remotes, exposes, and shared modules; a remote loaded by code is
 * unresolved rather than guessed.
 */

const IDS = {
  rootConfig: "architecture.single-spa.root-config",
  application: "architecture.single-spa.application",
  exportedLifecycles: "architecture.single-spa.exported-lifecycles",
  federation: "architecture.module-federation",
  importMap: "architecture.import-map",
} as const;

const LIFECYCLES = ["bootstrap", "mount", "unmount"];

export const compositionDetector: Detector = {
  id: "composition",
  version: "1",
  stage: "architecture",
  inputs: ["**/*.js", "**/*.jsx", "**/*.ts", "**/*.tsx", "**/*.mjs", "**/*.cjs", "**/*.html", "**/importmap.json"],
  categories: ["composition", "runtime_integrations"],
  async run(context) {
    const registrations: Evidence[] = [];
    const starts: Evidence[] = [];
    const lifecycles: Evidence[] = [];

    const rules = ruleDetector({
      id: "composition",
      version: "1",
      stage: "architecture",
      rules: RULES,
      sources: (inner) => inventoryOf(inner).sources,
      onMatch(inner, match) {
        const id = match.rule.id;
        if (id === "architecture.single-spa.register" || id === "architecture.single-spa.register-positional") registrations.push(match.evidence);
        else if (id === "architecture.single-spa.start") starts.push(match.evidence);
        else if (id === "architecture.single-spa.lifecycles") lifecycles.push(match.evidence);
        else if ("signal" in match.rule.emit && match.rule.emit.signal.kind === "module-federation") federation(inner, match);
      },
    });
    await rules.run(context);
    // Every source file can export lifecycles; the rule pass has already parsed and cached each tree.
    for (const path of inventoryOf(context).sources) {
      const tree = await syntaxOf(context, path);
      if (tree) lifecycleExports(context, tree, lifecycles);
    }

    if (registrations.length && starts.length) {
      context.fact({
        category: "composition",
        key: "single-spa:root-config",
        value: { mechanism: "single-spa", role: "root-config" },
        basis: "inferred",
        evidence: [...registrations, ...starts],
        rule: IDS.rootConfig,
        reasoning: "The repository registers single-spa applications and starts single-spa, which is what a single-spa root configuration does.",
      });
    }
    if (lifecycles.length) {
      context.fact({
        category: "composition",
        key: "single-spa:application",
        value: { mechanism: "single-spa", role: "application" },
        basis: "inferred",
        evidence: lifecycles,
        rule: IDS.application,
        reasoning: "The repository produces single-spa lifecycles (bootstrap, mount, and unmount), which is what a single-spa application exports for a root configuration to load.",
      });
    }

    await importMaps(context);
  },
};

/** Exported `bootstrap`, `mount`, and `unmount`: the lifecycles a single-spa application exports. */
function lifecycleExports(context: DetectorContext, tree: SyntaxTree, lifecycles: Evidence[]) {
  const exported = new Map<string, ts.Node>();
  for (const statement of tree.file.statements) {
    const isExported = ts.canHaveModifiers(statement) && ts.getModifiers(statement)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
    if (isExported && ts.isFunctionDeclaration(statement) && statement.name) exported.set(statement.name.text, statement);
    if (isExported && ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) exported.set(declaration.name.text, statement);
        else if (ts.isObjectBindingPattern(declaration.name)) for (const element of declaration.name.elements) if (ts.isIdentifier(element.name)) exported.set(element.name.text, statement);
      }
    }
    if (ts.isExportDeclaration(statement) && !statement.moduleSpecifier && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) exported.set(element.name.text, statement);
    }
  }
  if (!LIFECYCLES.every((name) => exported.has(name))) return;
  const nodes = [...new Set(LIFECYCLES.map((name) => exported.get(name)!))];
  for (const node of nodes) lifecycles.push(nodeEvidence(context, tree, node, IDS.exportedLifecycles));
}

/** One composition fact per Module Federation configuration, with references to its remotes and itself. */
function federation(context: DetectorContext, match: MatchedRule) {
  const { captures } = match;
  const name = literalText(captures.name);
  const remotes = remoteEntries(captures.remotes);
  const exposes = keysOf(captures.exposes);
  const shared = sharedNames(captures.shared);
  context.fact({
    category: "composition",
    key: name === null ? `module-federation:${match.tree.path}:${match.tree.lines(match.node).start}` : `module-federation:${name}`,
    value: { mechanism: "module-federation", plugin: match.rule.id, name: captures.name ? captureValue(captures.name) : { kind: "absent" }, remotes, exposes, shared },
    basis: "observed",
    evidence: [match.evidence],
    rule: match.rule.id,
  });
  for (const remote of Array.isArray(remotes) ? remotes : []) {
    const federationName = typeof remote === "object" && remote !== null && !Array.isArray(remote) && typeof remote.federation_name === "string" ? remote.federation_name : null;
    if (federationName) context.reference({ type: "composition", role: "host", identifier: { mechanism: "module-federation", name: federationName }, basis: "observed", evidence: [match.evidence], rule: IDS.federation });
  }
  if (name !== null && Array.isArray(exposes) && exposes.length) context.reference({ type: "composition", role: "remote", identifier: { mechanism: "module-federation", name }, basis: "observed", evidence: [match.evidence], rule: IDS.federation });
}

/**
 * Remotes as `{ alias, federation_name, entry }`. An entry written as
 * `name@url` names its remote; anything else, such as a `promise` string that
 * loads the remote by code, is unresolved.
 */
function remoteEntries(value: StaticValue | undefined): Value[] | Value {
  if (!value || value.kind === "undefined") return [];
  if (value.kind === "object") {
    const entries = [...value.properties.entries()].sort(([a], [b]) => compareCodeUnits(a, b)).map(([alias, entry]) => ({ alias, ...remoteEntry(entry) }));
    return value.complete ? entries : [...entries, { kind: "unresolved", reason: "computed", detail: "Remotes may also come from a spread or accessor" }];
  }
  if (value.kind === "array") return value.items.map((entry) => remoteEntry(entry));
  return captureValue(value);
}

function remoteEntry(entry: StaticValue): Record<string, Value> {
  if (entry.kind === "object") return remoteEntry(entry.properties.get("external") ?? entry.properties.get("entry") ?? { kind: "unresolved", reason: "unsupported", detail: "The remote has no external or entry field", node: entry.node });
  const text = literalText(entry);
  const at = text?.indexOf("@") ?? -1;
  if (text !== null && at > 0 && !text.startsWith("promise ")) return { federation_name: text.slice(0, at), entry: { kind: "literal", value: redactCredentials(text.slice(at + 1)) } };
  if (text !== null && /^https?:\/\//.test(text)) return { federation_name: null, entry: { kind: "literal", value: redactCredentials(text) } };
  return { federation_name: null, entry: text !== null ? { kind: "unresolved", reason: "computed", detail: "The remote is loaded by code" } : captureValue(entry) };
}

function keysOf(value: StaticValue | undefined): Value {
  if (!value || value.kind === "undefined") return [];
  if (value.kind === "object") return [...[...value.properties.keys()].sort(compareCodeUnits), ...(value.complete ? [] : [{ kind: "unresolved", reason: "computed", detail: "Entries may also come from a spread" }])];
  return captureValue(value);
}

function sharedNames(value: StaticValue | undefined): Value {
  if (value?.kind === "array") return value.items.map((item) => literalText(item) ?? captureValue(item)) as Value[];
  return keysOf(value);
}

/**
 * Import maps: `<script type="importmap">` and `systemjs-importmap` blocks in
 * HTML, and import-map JSON files. Each specifier maps to the address a host
 * loads it from.
 */
async function importMaps(context: DetectorContext) {
  const surface: string[] = [];
  const skipped: string[] = unanalyzedInputs(context, "import-map").map((input) => input.path);
  const html = context.reader.files().filter((entry) => entry.path.endsWith(".html") && !isVendored(entry.path) && !isSensitivePath(entry.path));
  for (const entry of html) {
    const content = await context.text(entry.path);
    if (!content) {
      skipped.push(entry.path);
      continue;
    }
    surface.push(entry.path);
    for (const block of htmlImportMaps(content.text!)) {
      let map;
      try {
        map = parseJson(block.json);
      } catch (error) {
        context.diagnostic(entry.path, "parse_failed", `The import map at line ${block.line} is not valid JSON: ${(error as Error).message}`);
        skipped.push(entry.path);
        continue;
      }
      reportImportMap(context, content, map, (specifier) => {
        const offset = block.lines.findIndex((line) => line.includes(JSON.stringify(specifier)));
        return context.lines(content, IDS.importMap, block.line + Math.max(offset, 0));
      });
    }
  }
  for (const input of readableInputs(context, "import-map")) {
    const parsed = await context.parsed(input.path, "json");
    if (!parsed) {
      skipped.push(input.path);
      continue;
    }
    surface.push(input.path);
    reportImportMap(context, parsed.content, parsed.value, (specifier) => context.pointer(parsed.content, IDS.importMap, "json", pointerOf(["imports", specifier])));
  }
  context.search({ category: "composition", rule: IDS.importMap, surface: [...new Set(surface)].sort(compareCodeUnits), complete: true, skipped: [...new Set(skipped)].sort(compareCodeUnits) });
}

function reportImportMap(context: DetectorContext, content: BlobContent, map: Value, evidenceFor: (specifier: string) => Evidence) {
  const imports = map && typeof map === "object" && !Array.isArray(map) ? map.imports : undefined;
  if (!imports || typeof imports !== "object" || Array.isArray(imports)) return;
  for (const specifier of Object.keys(imports).sort(compareCodeUnits)) {
    const url = imports[specifier];
    if (typeof url !== "string") continue;
    const evidence = evidenceFor(specifier);
    context.fact({ category: "composition", key: `import-map:${specifier}`, value: { mechanism: "import-map", specifier, url: redactCredentials(url), source: content.entry.path }, basis: "observed", evidence: [evidence], rule: IDS.importMap });
    context.reference({ type: "composition", role: "host", identifier: { mechanism: "import-map", specifier }, basis: "observed", evidence: [evidence], rule: IDS.importMap });
  }
}

/** Import-map script blocks in HTML, with the 1-based line where each block's JSON starts. */
export function htmlImportMaps(source: string): { json: string; line: number; lines: string[] }[] {
  // Commented-out markup is not a script. Blank comments but keep newlines, so line numbers still match the file.
  const text = source.replace(/<!--[\s\S]*?-->/g, (comment) => comment.replace(/[^\n]/g, " "));
  const blocks: { json: string; line: number; lines: string[] }[] = [];
  const opening = /<script\b[^>]*\btype\s*=\s*["'](?:systemjs-importmap|importmap)["'][^>]*>/gi;
  for (const match of text.matchAll(opening)) {
    const start = match.index + match[0].length;
    const end = text.indexOf("</script>", start);
    if (end === -1) continue;
    const json = text.slice(start, end);
    if (!json.trim()) continue;
    const line = text.slice(0, start).split("\n").length;
    blocks.push({ json, line, lines: json.split("\n") });
  }
  return blocks;
}
