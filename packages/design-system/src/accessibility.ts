import { type BlobContent, type Detector, type DetectorContext, type Evidence, compareCodeUnits, isSensitivePath, pointerOf } from "@repo-facts/contract";
import { DEPENDENCY_FIELDS, inventoryOf, isObject, isVendored, manifestsOf } from "@repo-facts/core";
import { type SyntaxTree, resolveTag, syntaxOf } from "@repo-facts/syntax";
import ts from "typescript";
import { designSystemInputs } from "./catalog.js";
import { SCOPES, type Scope, perScope, scopeOf } from "./scope.js";
import type { Site } from "./styles.js";
import { SAMPLES } from "./usage.js";

/**
 * What a repository declares and writes for accessibility, never whether it
 * conforms: the accessibility tooling its manifests declare, and static
 * checks of the intrinsic elements its JSX and HTML documents write.
 *
 * Each check counts, per scope, the elements it examines (`checked`), those
 * that fail it (`failing`), and those whose props are spread so the check
 * can't tell (`unknown`). A check cites its first failing sites, or its first
 * checked sites when none fails. Nothing is run, and a check doesn't follow
 * components: `<Image>` from a library is the library's to check.
 */

export const ACCESSIBILITY = "accessibility";

const RULES = { tooling: "accessibility.tooling", checks: "accessibility.checks" } as const;

/** Accessibility tooling, by the packages that declare it, and what kind of practice each is. */
export const ACCESSIBILITY_TOOLS: readonly { id: string; label: string; kind: "lint" | "test" | "storybook" | "runtime" | "audit" | "engine"; packages: readonly string[] }[] = [
  { id: "eslint-plugin-jsx-a11y", label: "eslint-plugin-jsx-a11y", kind: "lint", packages: ["eslint-plugin-jsx-a11y"] },
  { id: "eslint-plugin-vuejs-accessibility", label: "eslint-plugin-vuejs-accessibility", kind: "lint", packages: ["eslint-plugin-vuejs-accessibility"] },
  { id: "eslint-plugin-lit-a11y", label: "eslint-plugin-lit-a11y", kind: "lint", packages: ["eslint-plugin-lit-a11y"] },
  { id: "jest-axe", label: "jest-axe", kind: "test", packages: ["jest-axe"] },
  { id: "vitest-axe", label: "vitest-axe", kind: "test", packages: ["vitest-axe"] },
  { id: "axe-playwright", label: "axe for Playwright", kind: "test", packages: ["@axe-core/playwright", "axe-playwright"] },
  { id: "cypress-axe", label: "cypress-axe", kind: "test", packages: ["cypress-axe"] },
  { id: "axe-webdriver", label: "axe for WebDriver", kind: "test", packages: ["@axe-core/webdriverio", "@axe-core/webdriverjs", "@axe-core/puppeteer"] },
  { id: "storybook-a11y", label: "Storybook accessibility addon", kind: "storybook", packages: ["@storybook/addon-a11y"] },
  { id: "axe-react", label: "axe for React", kind: "runtime", packages: ["@axe-core/react", "react-axe"] },
  { id: "pa11y", label: "Pa11y", kind: "audit", packages: ["pa11y", "pa11y-ci"] },
  { id: "lighthouse", label: "Lighthouse", kind: "audit", packages: ["lighthouse", "@lhci/cli"] },
  { id: "axe-cli", label: "axe CLI", kind: "audit", packages: ["@axe-core/cli"] },
  { id: "axe-core", label: "axe-core", kind: "engine", packages: ["axe-core"] },
];

export const ACCESSIBILITY_CHECKS = ["img-alt", "iframe-title", "anchor-href", "click-role", "tabindex-positive", "html-lang"] as const;
type Check = (typeof ACCESSIBILITY_CHECKS)[number];

/** Elements with no interactive role of their own, which a click handler doesn't make operable by keyboard or announce as a control. */
const STATIC_ELEMENTS = new Set(["div", "span", "p", "li", "ul", "ol", "dl", "dt", "dd", "section", "article", "header", "footer", "main", "aside", "nav", "figure", "td", "th", "tr", "table", "img", "svg", "i", "b", "strong", "em", "h1", "h2", "h3", "h4", "h5", "h6"]);
// Template files are another syntax, skipped on this category's surface as they are for the UI categories.
const TEMPLATE_HTML = [".component.html", ".scala.html"];

interface Counts {
  checked: number;
  failing: number;
  unknown: number;
}

class CheckTally {
  readonly scopes = perScope<Counts>(() => ({ checked: 0, failing: 0, unknown: 0 }));
  readonly checked: Site[] = [];
  readonly failing: Site[] = [];

  add(scope: Scope, site: Site, outcome: "pass" | "fail" | "unknown") {
    this.scopes[scope].checked += 1;
    this.checked.push(site);
    if (outcome === "fail") {
      this.scopes[scope].failing += 1;
      this.failing.push(site);
    }
    if (outcome === "unknown") this.scopes[scope].unknown += 1;
  }

  samples(): Site[] {
    const sites = this.failing.length ? this.failing : this.checked;
    return [...sites].sort((a, b) => compareCodeUnits(a.path, b.path) || a.offset - b.offset).slice(0, SAMPLES);
  }
}

export function accessibilityDetector(): Detector {
  return {
    id: ACCESSIBILITY,
    version: "1",
    stage: "architecture",
    inputs: ["**/package.json", "**/*.js", "**/*.jsx", "**/*.mjs", "**/*.cjs", "**/*.ts", "**/*.tsx", "**/*.mts", "**/*.cts", "**/*.html", "**/*.htm"],
    categories: ["accessibility"],
    async run(context) {
      reportTooling(context);

      const tallies = new Map<Check, CheckTally>(ACCESSIBILITY_CHECKS.map((check) => [check, new CheckTally()]));
      const skipped: string[] = [];
      const { sources } = designSystemInputs(context);
      for (const path of sources) {
        const tree = await syntaxOf(context, path);
        if (!tree) {
          skipped.push(path);
          continue;
        }
        checkElements(tree, scopeOf(path), tallies);
      }
      const documents = htmlDocuments(context);
      for (const path of documents) {
        const content = await context.text(path);
        if (!content) {
          skipped.push(path);
          continue;
        }
        checkDocument(path, content, tallies.get("html-lang")!);
      }

      for (const [check, tally] of tallies) {
        if (!tally.checked.length) continue;
        context.fact({
          category: "accessibility",
          key: `check:${check}`,
          value: Object.fromEntries(SCOPES.map((scope) => [scope, { ...tally.scopes[scope] }])),
          basis: "observed",
          evidence: tally.samples().map((site) => context.lines(site.content, RULES.checks, site.line, site.line)),
          rule: RULES.checks,
        });
      }

      const { manifests, unanalyzed } = manifestsOf(context);
      context.search({ category: "accessibility", rule: RULES.tooling, surface: manifests.map((manifest) => manifest.path), complete: true, skipped: unanalyzed });
      context.search({ category: "accessibility", rule: RULES.checks, surface: [...sources, ...documents].sort(compareCodeUnits), complete: true, skipped: [...new Set(skipped)].sort(compareCodeUnits) });
    },
  };
}

/** Each accessibility tool any manifest declares, citing every declaration. */
function reportTooling(context: DetectorContext) {
  const { manifests } = manifestsOf(context);
  for (const tool of ACCESSIBILITY_TOOLS) {
    const evidence: Evidence[] = [];
    for (const manifest of manifests) {
      for (const field of DEPENDENCY_FIELDS) {
        const declared = manifest.value[field];
        if (!isObject(declared)) continue;
        for (const name of tool.packages) if (typeof declared[name] === "string") evidence.push(context.pointer(manifest.content, RULES.tooling, "json", pointerOf([field, name])));
      }
    }
    if (evidence.length) context.fact({ category: "accessibility", key: `tool:${tool.id}`, value: { id: tool.id, label: tool.label, kind: tool.kind }, basis: "observed", evidence, rule: RULES.tooling });
  }
}

/** Committed HTML documents, leaving out vendored code, sensitive paths, and component templates. */
function htmlDocuments(context: DetectorContext): string[] {
  const { vendorDirectories } = inventoryOf(context);
  return context.reader
    .files()
    .map((entry) => entry.path)
    .filter((path) => /\.html?$/i.test(path) && !TEMPLATE_HTML.some((suffix) => path.endsWith(suffix)) && !isVendored(path, vendorDirectories) && !isSensitivePath(path))
    .sort(compareCodeUnits);
}

type Attributes = { names: Map<string, ts.JsxAttribute>; spread: boolean };

function attributesOf(node: ts.JsxOpeningElement | ts.JsxSelfClosingElement): Attributes {
  const names = new Map<string, ts.JsxAttribute>();
  let spread = false;
  for (const attribute of node.attributes.properties) {
    if (ts.isJsxSpreadAttribute(attribute)) spread = true;
    else if (ts.isIdentifier(attribute.name)) names.set(attribute.name.text, attribute);
  }
  return { names, spread };
}

/** Pass when +name+ is written, unknown when it may come from a spread, and fail otherwise. */
const required = (attributes: Attributes, name: string): "pass" | "fail" | "unknown" => (attributes.names.has(name) ? "pass" : attributes.spread ? "unknown" : "fail");

/** A literal tabIndex's number, or null when it isn't a literal. */
function tabIndexOf(attribute: ts.JsxAttribute): number | null {
  const initializer = attribute.initializer;
  if (!initializer) return null;
  if (ts.isStringLiteral(initializer)) return Number.isFinite(Number(initializer.text)) ? Number(initializer.text) : null;
  if (!ts.isJsxExpression(initializer) || !initializer.expression) return null;
  const expression = initializer.expression;
  if (ts.isNumericLiteral(expression) || ts.isStringLiteral(expression)) return Number(expression.text);
  if (ts.isPrefixUnaryExpression(expression) && expression.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(expression.operand)) return -Number(expression.operand.text);
  return null;
}

function checkElements(tree: SyntaxTree, scope: Scope, tallies: Map<Check, CheckTally>) {
  tree.walk((node) => {
    if (!ts.isJsxOpeningElement(node) && !ts.isJsxSelfClosingElement(node)) return;
    const reference = resolveTag(tree, node.tagName);
    if (reference.kind !== "intrinsic") return;
    const tag = reference.name;
    const attributes = attributesOf(node);
    const site: Site = { path: tree.path, content: tree.content, line: tree.lines(node).start, offset: node.getStart(tree.file) };
    if (tag === "img") tallies.get("img-alt")!.add(scope, site, required(attributes, "alt"));
    if (tag === "iframe") tallies.get("iframe-title")!.add(scope, site, required(attributes, "title"));
    if (tag === "a") tallies.get("anchor-href")!.add(scope, site, required(attributes, "href"));
    if (tag === "html") tallies.get("html-lang")!.add(scope, site, required(attributes, "lang"));
    if (STATIC_ELEMENTS.has(tag) && attributes.names.has("onClick")) tallies.get("click-role")!.add(scope, site, required(attributes, "role"));
    const tabIndex = attributes.names.get("tabIndex");
    if (tabIndex) {
      const value = tabIndexOf(tabIndex);
      tallies.get("tabindex-positive")!.add(scope, site, value === null ? "unknown" : value > 0 ? "fail" : "pass");
    }
  });
}

/** An HTML document's `<html>` element: it should name the page's language. */
function checkDocument(path: string, content: BlobContent, tally: CheckTally) {
  const text = content.text ?? "";
  // Commented-out markup is not an element.
  const visible = text.replace(/<!--[\s\S]*?-->/g, (comment) => comment.replace(/[^\n]/g, " "));
  const match = /<html\b([^>]*)>/i.exec(visible);
  if (!match) return;
  const line = visible.slice(0, match.index).split("\n").length;
  tally.add(scopeOf(path), { path, content, line, offset: match.index }, /\blang\s*=/i.test(match[1] ?? "") ? "pass" : "fail");
}
