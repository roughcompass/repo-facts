import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { type CssAtRule, type CssDeclaration, type CssNode, type CssRule, type CssToken, STYLESHEET_PARSER, type Stylesheet, parseStylesheet, tokenize, walkStylesheet } from "../src/index.js";

// Parse-only stylesheets (repo-facts/analysis-safety and design-system-usage specs).

function parse(text: string, mode?: "stylesheet" | "declarations"): Stylesheet {
  const result = parseStylesheet(text, mode ? { mode } : {});
  if (!result.ok) throw new Error(`${result.failure.reason}: ${result.failure.detail}`);
  return result.stylesheet;
}

const kinds = (tokens: CssToken[]) => tokens.filter((token) => token.type !== "whitespace").map((token) => ("value" in token ? `${token.type}:${token.value}${"unit" in token ? token.unit : ""}` : token.type));
const rule = (node: CssNode | undefined) => node as CssRule;
const declarationsOf = (sheet: Stylesheet): CssDeclaration[] => {
  const all: CssDeclaration[] = [...sheet.declarations];
  walkStylesheet(sheet.rules, (node) => all.push(...node.declarations));
  return all;
};

describe("tokenizer", () => {
  it("drops comments, including an unterminated one", () => {
    expect(kinds(tokenize("a /* x */ b /* open"))).toEqual(["ident:a", "ident:b"]);
  });

  it("reads numbers, percentages, and dimensions as written", () => {
    expect(kinds(tokenize("12 +.5 -3.25e-2 50% 10px 1.5rem 1e3em"))).toEqual(["number:12", "number:+.5", "number:-3.25e-2", "percentage:50", "dimension:10px", "dimension:1.5rem", "dimension:1e3em"]);
  });

  it("reads custom properties, vendor prefixes, and escapes as identifiers", () => {
    expect(kinds(tokenize("--salt-spacing-100 -webkit-box \\31 0 a\\:b"))).toEqual(["ident:--salt-spacing-100", "ident:-webkit-box", "ident:10", "ident:a:b"]);
  });

  it("reads strings with escapes, and a newline makes a bad string", () => {
    expect(kinds(tokenize(`"a\\"b" 'c\\41 d'`))).toEqual(['string:a"b', "string:cAd"]);
    expect(kinds(tokenize('"broken\nx'))).toEqual(["bad-string", "ident:x"]);
  });

  it("reads unquoted url() as one token and quoted url() as a function", () => {
    expect(kinds(tokenize("url( a/b.png ) url('c.png') URL(d)"))).toEqual(["url:a/b.png", "function:url", "string:c.png", ")", "url:d"]);
    expect(kinds(tokenize("url(a b)"))).toEqual(["bad-url"]);
  });

  it("reads hashes, at-keywords, delimiters, CDO, and CDC", () => {
    expect(kinds(tokenize("#fff #a-b @media @ ! <!-- -->"))).toEqual(["hash:fff", "hash:a-b", "at-keyword:media", "delim:@", "delim:!", "cdo", "cdc"]);
  });

  it("keeps offsets into the committed text", () => {
    const [first, , second] = tokenize("ab\r\ncd");
    expect(first).toMatchObject({ start: 0, end: 2 });
    expect(second).toMatchObject({ start: 4, end: 6 });
  });
});

describe("parser", () => {
  it("reads rules, selectors, and declarations with !important", () => {
    const sheet = parse(".a > .b, #c div:hover::before { color: red !IMPORTANT; padding : var(--salt-spacing-300) }");
    const [first] = sheet.rules;
    expect(first?.kind).toBe("rule");
    expect(rule(first).selectors.map((selector) => selector.text)).toEqual([".a > .b", "#c div:hover::before"]);
    expect(rule(first).selectors[0]!.combinators).toEqual([">"]);
    expect(rule(first).selectors[1]!.compounds[1]).toMatchObject({ type: "div", pseudoClasses: ["hover"], pseudoElements: ["before"] });
    const [color, padding] = rule(first).declarations;
    expect(color).toMatchObject({ property: "color", text: "red", important: true });
    expect(padding).toMatchObject({ property: "padding", text: "var(--salt-spacing-300)", important: false });
    expect(padding!.value[0]).toMatchObject({ kind: "function", name: "var" });
  });

  it("reads classes inside selector arguments and attribute names", () => {
    const sheet = parse(":is(.a, .b) [data-state='open'] .saltButton:not(.c) {}");
    const compounds = rule(sheet.rules[0]).selectors[0]!.compounds;
    expect(compounds[0]!.argumentClasses).toEqual(["a", "b"]);
    expect(compounds[1]!.attributes).toEqual(["data-state"]);
    expect(compounds[2]).toMatchObject({ classes: ["saltButton"], argumentClasses: ["c"] });
  });

  it("reads native nesting, nested at-rules, and keyframes", () => {
    const sheet = parse(".card { color: red; &:hover { color: blue } .title { font-weight: 600 } @media (width > 600px) { padding: 0 } } @keyframes spin { from { rotate: 0 } 50% { rotate: 180deg } }");
    const card = rule(sheet.rules[0]);
    expect(card.declarations.map((declaration) => declaration.property)).toEqual(["color"]);
    expect(card.rules.map((node) => (node.kind === "rule" ? node.prelude : `@${node.name}`))).toEqual(["&:hover", ".title", "@media"]);
    expect(card.rules[0]!.kind === "rule" && card.rules[0]!.selectors[0]!.compounds[0]!.nesting).toBe(true);
    expect((card.rules[2] as CssAtRule).declarations.map((declaration) => declaration.property)).toEqual(["padding"]);
    const keyframes = sheet.rules[1] as CssAtRule;
    expect(keyframes.rules.map((node) => (node as CssRule).prelude)).toEqual(["from", "50%"]);
  });

  it("keeps the case of custom properties and allows braces in their values", () => {
    const sheet = parse(":root { --Salt-Accent: #f00; --mixin: { color: red }; Color: BLUE }");
    expect(declarationsOf(sheet).map((declaration) => [declaration.property, declaration.text])).toEqual([
      ["--Salt-Accent", "#f00"],
      ["--mixin", "{ color: red }"],
      ["color", "BLUE"],
    ]);
  });

  it("records invalid declarations as unparsed instead of guessing", () => {
    const sheet = parse(".a { color red; 12px: x; width: 'open\n; height: 4px }");
    expect(declarationsOf(sheet).map((declaration) => declaration.property)).toEqual(["height"]);
    expect(sheet.unparsed.map((entry) => entry.reason)).toEqual(["invalid_declaration", "invalid_declaration", "bad_token"]);
  });

  it("records @import as data and never follows it", () => {
    const sheet = parse(`@import url("https://example.invalid/theme.css"); @import 'local.css' layer(base); .a { color: red }`);
    expect(sheet.imports.map((entry) => entry.url)).toEqual(["https://example.invalid/theme.css", "local.css"]);
    expect(sheet.rules.map((node) => node.kind)).toEqual(["at-rule", "at-rule", "rule"]);
  });

  it("parses a styled-components body as a declaration list", () => {
    const sheet = parse("color: red;\n  padding: 4px;\n  &:hover { color: blue; }", "declarations");
    expect(sheet.declarations.map((declaration) => declaration.property)).toEqual(["color", "padding"]);
    expect(rule(sheet.rules[0]).declarations[0]).toMatchObject({ property: "color", text: "blue" });
  });

  it("reports lines for offsets", () => {
    const sheet = parse(".a {\n  color: red;\r\n  gap: 1px;\n}");
    const [, gap] = declarationsOf(sheet);
    expect(sheet.lineOf(gap!.start)).toBe(3);
  });

  it("rejects a stylesheet nested past the depth limit, whole", () => {
    const deep = `${".a {".repeat(70)}${"}".repeat(70)}`;
    const result = parseStylesheet(deep);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.failure.reason).toBe("stylesheet_depth_limit");
    expect(parseStylesheet(".a { color: red }").ok).toBe(true);
  });

  it("rejects a stylesheet over the node limit, whole", () => {
    const result = parseStylesheet(".a { color: red }".repeat(50), { limits: { nodes: 100, depth: 64 } });
    expect(!result.ok && result.failure.reason).toBe("stylesheet_node_limit");
  });

  it("names its parser for the detector configuration", () => {
    expect(STYLESHEET_PARSER).toEqual({ name: "repo-facts-css", version: "1.0.0" });
  });
});

// The spike that confirms the in-house parser (design-system-usage tasks 1.1):
// every stylesheet in the workspace's Salt repositories parses with nothing unparsed.
const WORKSPACE = path.resolve(import.meta.dirname, "../../../..");
const SAMPLE_ROOTS = [path.join(WORKSPACE, "fleet"), path.join(WORKSPACE, "create-web-app/template")];

function stylesheetsUnder(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const found: string[] = [];
  const stack = [root];
  while (stack.length) {
    const directory = stack.pop()!;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".") || entry.name === "dist") continue;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && entry.name.endsWith(".css")) found.push(full);
    }
  }
  return found.sort();
}

const samples = SAMPLE_ROOTS.flatMap(stylesheetsUnder);

describe.skipIf(samples.length === 0)("workspace stylesheets", () => {
  it.each(samples.map((file) => [path.relative(WORKSPACE, file), file]))("parses %s with nothing unparsed", (_name, file) => {
    const sheet = parse(fs.readFileSync(file, "utf8"));
    expect(sheet.unparsed).toEqual([]);
    expect(declarationsOf(sheet).length).toBeGreaterThan(0);
  });
});
