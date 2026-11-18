import { describe, expect, it } from "vitest";
import { type CssDeclaration, type CssRule, type CssToken, type Stylesheet, type StylesheetDialect, parseStylesheet, stylesheetDialectOf, tokenize, walkStylesheet } from "../src/index.js";

// SCSS and Less, read as data: nothing is compiled, resolved, or imported.

function parse(text: string, dialect: StylesheetDialect): Stylesheet {
  const result = parseStylesheet(text, { dialect });
  if (!result.ok) throw new Error(`${result.failure.reason}: ${result.failure.detail}`);
  return result.stylesheet;
}

const kinds = (tokens: CssToken[]) => tokens.filter((token) => token.type !== "whitespace").map((token) => ("value" in token ? `${token.type}:${token.value}` : token.type));
const declarations = (sheet: Stylesheet): string[] => {
  const all: CssDeclaration[] = [...sheet.declarations];
  walkStylesheet(sheet.rules, (node) => all.push(...node.declarations));
  return all.map((declaration) => `${declaration.property}: ${declaration.text}`);
};
const rules = (sheet: Stylesheet): CssRule[] => {
  const all: CssRule[] = [];
  walkStylesheet(sheet.rules, (node) => {
    if (node.kind === "rule") all.push(node);
  });
  return all;
};
const classes = (sheet: Stylesheet) => rules(sheet).map((rule) => rule.selectors.flatMap((selector) => selector.compounds.flatMap((compound) => compound.classes)));

describe("stylesheet dialects", () => {
  it("chooses the dialect by extension", () => {
    expect(["a.css", "a.module.scss", "b/c.less", "d.sass", "e.styl"].map(stylesheetDialectOf)).toEqual(["css", "scss", "less", null, null]);
  });

  it("tokenizes SCSS line comments, variables, and interpolation, and leaves CSS alone", () => {
    expect(kinds(tokenize("a: $gap; // note\nb: #{$x + 1}; c: url(//cdn.test/a.png)", undefined, "scss"))).toEqual([
      "ident:a",
      "colon",
      "variable:gap",
      "semicolon",
      "ident:b",
      "colon",
      "interpolation:$x + 1",
      "semicolon",
      "ident:c",
      "colon",
      "url://cdn.test/a.png",
    ]);
    expect(kinds(tokenize("a: $gap // note", undefined, "css"))).toEqual(["ident:a", "colon", "delim:$", "ident:gap", "delim:/", "delim:/", "ident:note"]);
  });

  it("tokenizes Less interpolation and escapes", () => {
    expect(kinds(tokenize('.@{name} { width: ~"calc(100% - @{gap})"; color: @brand; }', undefined, "less"))).toEqual([
      "delim:.",
      "interpolation:name",
      "{",
      "ident:width",
      "colon",
      "interpolation:calc(100% - @{gap})",
      "semicolon",
      "ident:color",
      "colon",
      "at-keyword:brand",
      "semicolon",
      "}",
    ]);
  });

  it("skips SCSS variables, keeps mixin bodies' declarations, and records includes and imports", () => {
    const sheet = parse(
      [
        '@use "sass:math";',
        '@import "@salt-ds/theme/index.css";',
        "$gap: 8px !default;",
        "$map: (small: 4px, large: 16px);",
        "@mixin focus-ring($color) { outline: 2px solid $color; }",
        ".card {",
        "  $local: 2px;",
        "  padding: math.div($gap, 2);",
        "  @include focus-ring(var(--salt-focused-outlineColor));",
        "  @extend %surface;",
        "  font: { family: serif; weight: 600; }",
        "}",
        "%surface { background: var(--salt-container-primary-background); }",
      ].join("\n"),
      "scss",
    );
    expect(declarations(sheet)).toEqual(["outline: 2px solid $color", "padding: math.div($gap, 2)", "font-family: serif", "font-weight: 600", "background: var(--salt-container-primary-background)"]);
    expect(sheet.unparsed).toEqual([]);
    expect(sheet.imports.map((entry) => entry.url)).toEqual(["sass:math", "@salt-ds/theme/index.css"]);
    const card = rules(sheet)[0]!;
    expect(card.includes).toEqual(["focus-ring(var(--salt-focused-outlineColor))", "%surface"]);
    expect(rules(sheet)[1]!.selectors[0]!.compounds[0]).toMatchObject({ placeholders: ["surface"], type: null });
  });

  it("resolves parent suffixes into classes, through nesting and at-rules", () => {
    const sheet = parse(".button, .link { &-primary { color: red; } &__icon { @media (min-width: 1px) { &--large { width: 1px; } } } &:hover { color: blue; } }", "scss");
    expect(classes(sheet)).toEqual([["button", "link"], ["button-primary", "link-primary"], ["button__icon", "link__icon"], ["button__icon--large", "link__icon--large"], []]);
    expect(sheet.unresolved).toEqual([]);
  });

  it("records a suffix whose parent doesn't end in a class, and interpolated selectors, as unresolved", () => {
    const sheet = parse("button { &-primary { color: red; } }\n.icon-#{$name} span { color: blue; }\n#{$tag} { color: green; }\n.ok { color: black; }", "scss");
    expect(classes(sheet)).toEqual([[], [], [], [], ["ok"]]);
    expect(sheet.unresolved.map((entry) => entry.reason)).toEqual(["parent_suffix", "interpolated_selector", "interpolated_selector"]);
    const [, , icon, tag] = rules(sheet);
    expect(icon!.selectors[0]!.compounds[0]).toMatchObject({ unresolved: true, classes: [] });
    expect(icon!.selectors[0]!.compounds[1]).toMatchObject({ unresolved: false, type: "span" });
    expect(tag!.selectors[0]!.compounds[0]).toMatchObject({ unresolved: true, type: null });
  });

  it("reads url() of an SCSS or Less expression as a function, and a plain one as a URL", () => {
    expect(kinds(tokenize("src: url($path + '/a.woff') format('woff'), url(#{$cdn}/b.png), url(fonts/c.woff2);", undefined, "scss")).slice(0, 4)).toEqual(["ident:src", "colon", "function:url", "variable:path"]);
    expect(kinds(tokenize("a: url(#{$cdn}/b.png); b: url(fonts/c.woff2);", undefined, "scss"))).toContain("url:fonts/c.woff2");
    expect(kinds(tokenize("a: url(@{base}/b.png);", undefined, "less"))).toEqual(["ident:a", "colon", "function:url", "interpolation:base", "delim:/", "ident:b", "delim:.", "ident:png", ")", "semicolon"]);
    expect(parse(".a { src: url($path + '/a.woff') format('woff'); }", "scss").unparsed).toEqual([]);
  });

  it("records an interpolated property as unparsed, never as a guessed property", () => {
    const sheet = parse(".a { margin-#{$side}: 4px; #{$prop}: 1px; color: red; }", "scss");
    expect(declarations(sheet)).toEqual(["color: red"]);
    expect(sheet.unparsed.map((entry) => [entry.reason, entry.property])).toEqual([
      ["interpolated_property", null],
      ["interpolated_property", null],
    ]);
  });

  it("skips Less variables and detached rulesets, and records mixin calls and extends as includes", () => {
    const sheet = parse(
      [
        "@brand: #c00;",
        "@detached: { color: red; };",
        ".bordered(@width: 1px) { border: @width solid black; }",
        ".card {",
        "  @pad: 4px;",
        "  .bordered(2px);",
        "  #mixins.shadow();",
        "  &:extend(.base all);",
        "  padding: @pad;",
        "  &-title { font-weight: 600; }",
        "}",
        ".link:extend(.base) { color: blue; }",
      ].join("\n"),
      "less",
    );
    expect(declarations(sheet)).toEqual(["border: @width solid black", "padding: @pad", "font-weight: 600", "color: blue"]);
    expect(sheet.unparsed).toEqual([]);
    const [, card, title, link] = rules(sheet);
    expect(card!.includes).toEqual([".bordered(2px)", "#mixins.shadow()", "&:extend(.base all)"]);
    expect(title!.selectors[0]!.compounds[0]!.classes).toEqual(["card-title"]);
    expect(link!.includes).toEqual([".link:extend(.base)"]);
  });

  it("keeps CSS parsing unchanged: a stray $ or // is not preprocessor syntax", () => {
    const sheet = parse(".a { b: $c; } // .d { e: f; }", "css");
    expect(sheet.unparsed).toHaveLength(0);
    expect(rules(sheet)[0]!.includes).toEqual([]);
  });
});
