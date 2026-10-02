import crypto from "node:crypto";
import type { BlobContent } from "@repo-facts/contract";
import { SyntaxTree, parseStylesheet } from "@repo-facts/syntax";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { CATALOGS, StyleIndex, type StyleSource, ValueClassifier, cssProperty, scopeOf, styleObjectValue, templateSource } from "../src/index.js";

// design-system-usage: style declarations are classified by family and value kind.

const salt = CATALOGS.find((catalog) => catalog.id === "salt")!;

function content(path: string, text: string): BlobContent {
  const bytes = Buffer.from(text);
  return { entry: { path, mode: "100644", type: "file", objectId: "0".repeat(40), size: bytes.length }, bytes, text, binary: false, digest: crypto.createHash("sha256").update(bytes).digest("hex") };
}

function stylesheet(path: string, text: string): StyleSource {
  const result = parseStylesheet(text);
  if (!result.ok) throw new Error(result.failure.reason);
  return { path, scope: scopeOf(path), content: content(path, text), kind: "global", stylesheet: result.stylesheet, base: 0, lineAt: (offset) => result.stylesheet.lineOf(offset), interpolations: [] };
}

/** Classifies every style declaration in +css+, with +definitions+ indexed first, as `property: family/observed/resolved`. */
function classify(css: string, definitions = "") {
  const index = new StyleIndex(CATALOGS, [salt]);
  if (definitions) index.add(stylesheet("src/tokens.css", definitions));
  const source = stylesheet("src/app.css", css);
  index.add(source);
  const classifier = new ValueClassifier(salt, CATALOGS, index);
  return index.declarations
    .filter((item) => item.source === source)
    .map(({ declaration }) => {
      const result = classifier.classifyDeclaration(declaration, source);
      return `${declaration.property}: ${result.family}/${result.observed}/${result.resolved}`;
    });
}

describe("value classification", () => {
  it("counts a spacing token as a spacing declaration with a token value", () => {
    expect(classify(".a { padding: var(--salt-spacing-300) }")).toEqual(["padding: spacing/token/token"]);
  });

  it("counts a raw color as a color declaration with a raw value", () => {
    expect(classify(".a { color: #0a6; background-color: rgb(0 0 0 / 50%); border-color: red }")).toEqual(["color: color/raw/raw", "background-color: color/raw/raw", "border-color: color/raw/raw"]);
  });

  it("classifies by the weakest component", () => {
    expect(classify(".a { border: 1px solid var(--salt-separable-borderColor); margin: 0 var(--salt-spacing-100); padding: var(--app-pad) var(--salt-spacing-100) }")).toEqual([
      "border: border/raw/raw",
      "margin: spacing/token/token",
      "padding: spacing/other_custom_property/other_custom_property",
    ]);
  });

  it("treats keywords, zero, and the catalog's neutral values as neutral, and literal fonts as raw", () => {
    expect(classify(".a { display: flex; margin: 0; width: 100%; color: inherit; background: transparent; font-family: \"Open Sans\", sans-serif; font-weight: 600; z-index: 10 }")).toEqual([
      "display: layout/neutral/neutral",
      "margin: spacing/neutral/neutral",
      "width: sizing/neutral/neutral",
      "color: color/neutral/neutral",
      "background: color/neutral/neutral",
      "font-family: typography/raw/raw",
      "font-weight: typography/raw/raw",
      "z-index: other/neutral/neutral",
    ]);
  });

  it("reads tokens through math and color functions, where unitless operands are neutral", () => {
    expect(classify(".a { padding: calc(var(--salt-spacing-100) * 2); width: calc(100% - 8px); color: rgb(var(--salt-color-blue-200-rgb) / 0.4) }")).toEqual([
      "padding: spacing/token/token",
      "width: sizing/raw/raw",
      "color: color/token/token",
    ]);
  });

  it("resolves an alias whose every definition is a token, and not one with a raw definition", () => {
    const definitions = ":root { --app-gap: var(--salt-spacing-200); --app-pad: var(--app-gap); --app-tone: var(--salt-palette-accent) }\n.dark { --app-tone: #000 }\n";
    expect(classify(".a { padding: var(--app-pad); color: var(--app-tone) }", definitions)).toEqual(["padding: spacing/other_custom_property/token_alias", "color: color/other_custom_property/other_custom_property"]);
  });

  it("follows at most four alias steps", () => {
    const chain = (steps: number) => `:root { --s1: var(--salt-spacing-100); ${Array.from({ length: steps - 1 }, (_, index) => `--s${index + 2}: var(--s${index + 1});`).join(" ")} }`;
    expect(classify(".a { padding: var(--s4) }", chain(4))).toEqual(["padding: spacing/other_custom_property/token_alias"]);
    expect(classify(".a { padding: var(--s5) }", chain(5))).toEqual(["padding: spacing/other_custom_property/other_custom_property"]);
    expect(classify(".a { padding: var(--loop) }", ":root { --loop: var(--loop2); --loop2: var(--loop) }")).toEqual(["padding: spacing/other_custom_property/other_custom_property"]);
  });

  it("names the alias definitions an inference relies on", () => {
    const index = new StyleIndex(CATALOGS, [salt]);
    index.add(stylesheet("src/tokens.css", ":root {\n  --app-gap: var(--salt-spacing-200);\n}\n"));
    const source = stylesheet("src/app.css", ".a { gap: var(--app-gap); padding: var(--app-gap) }");
    index.add(source);
    const classifier = new ValueClassifier(salt, CATALOGS, index);
    const result = classifier.classifyDeclaration(index.declarations.find((item) => item.declaration.property === "padding")!.declaration, source);
    expect([...result.aliases]).toEqual(["--app-gap"]);
    expect([...result.systems]).toEqual(["salt"]);
    expect(classifier.aliasDefinitions("--app-gap").map((item) => `${item.site.path}:${item.site.line}`)).toEqual(["src/tokens.css:2"]);
  });
});

describe("style objects", () => {
  it.each([
    ["minHeight", "min-height"],
    ["backgroundColor", "background-color"],
    ["WebkitTransition", "-webkit-transition"],
    ["msFlex", "-ms-flex"],
    ["--app-gap", "--app-gap"],
    ["border-radius", "border-radius"],
  ])("reads the key %s as %s", (key, property) => {
    expect(cssProperty(key)).toBe(property);
  });

  it("reads numbers as pixels on length properties, as React does, and strings as CSS", () => {
    const classifier = new ValueClassifier(salt, CATALOGS, new StyleIndex(CATALOGS, [salt]));
    const kind = (property: string, value: string | number) => {
      const parsed = styleObjectValue(property, value);
      return parsed === "unparsed" ? "unparsed" : classifier.classify({ property, value: parsed }).observed;
    };
    expect(kind("min-height", 220)).toBe("raw");
    expect(kind("padding", 0)).toBe("neutral");
    expect(kind("opacity", 0.5)).toBe("neutral");
    expect(kind("line-height", 1.5)).toBe("raw");
    expect(kind("gap", "var(--salt-spacing-100)")).toBe("token");
    expect(kind("color", "'open\nline")).toBe("unparsed");
    expect(classifier.classify({ property: "color", value: null }).observed).toBe("unresolved");
  });
});

describe("styled-adapter templates", () => {
  function template(code: string) {
    const text = `import styled from "styled-components";\n${code}\n`;
    const parsed = SyntaxTree.parse(content("src/Tone.tsx", text));
    if (!parsed.ok) throw new Error(parsed.failure.reason);
    const tree = parsed.tree;
    let literal: ts.TemplateLiteral | undefined;
    tree.walk((node) => {
      if (ts.isTaggedTemplateExpression(node)) literal = node.template;
    });
    const built = templateSource(tree, literal!, "app");
    if ("failure" in built) throw new Error(built.failure.reason);
    const index = new StyleIndex(CATALOGS, [salt]);
    index.add(built.source);
    const classifier = new ValueClassifier(salt, CATALOGS, index);
    return { index, rows: index.declarations.map(({ declaration, site }) => `${declaration.property}@${site.line}: ${classifier.classifyDeclaration(declaration, built.source).observed}`) };
  }

  it("counts an interpolated value as unresolved", () => {
    expect(template("const Tone = styled.span`\n  color: ${(props) => props.tone};\n  padding: var(--salt-spacing-100);\n  margin: ${4}px;\n`;").rows).toEqual(["color@3: unresolved", "padding@4: token", "margin@5: unresolved"]);
  });

  it("maps lines through multi-line interpolations, and skips interpolated mixins", () => {
    const { index, rows } = template("const Tone = styled.span`\n  ${(props) =>\n    props.mixin};\n  color: red !important;\n  &:hover { gap: var(--salt-spacing-275) }\n`;");
    // A prefixed name that isn't a token counts as another custom property, and is reported as unknown.
    expect(rows).toEqual(["color@5: raw", "gap@6: other_custom_property"]);
    expect(index.unparsed).toEqual([]);
    expect(index.findings.map((finding) => `${finding.key}@${finding.site.line}`)).toEqual(["important@5", "unknown-token:--salt-spacing-275@6"]);
  });
});
