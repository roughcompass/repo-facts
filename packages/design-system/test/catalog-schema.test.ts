import { describe, expect, it } from "vitest";
import { type CatalogSource, compileCatalogs } from "../src/index.js";

// Catalogs and adapters are data (repo-facts/detector-catalog: syntax patterns are declarative, versioned rules).

const CATALOG = `
format: 1
id: demo
name: Demo
version: 1.0.0
generated_from:
  "@demo/core": 2.1.0
packages:
  - name: "@demo/theme"
  - name: "@demo/core"
    components: [Text, Button, DemoProvider, FlexLayout]
providers: [{ package: "@demo/core", component: DemoProvider }]
theme_stylesheets: ["@demo/theme/index.css"]
token_prefix: --demo-
class_prefix: demo
equivalents:
  - { tag: p, package: "@demo/core", component: Text }
  - { tag: button, package: "@demo/core", component: Button }
neutral_tags: [span, div]
neutral_values: ["0", auto, "100%", inherit, currentColor]
property_families:
  layout: [gap, display]
  color: [color, background-color]
tokens: [--demo-spacing-100, --demo-palette-accent]
`;

const ADAPTERS = `
format: 1
version: 1.0.0
adapters:
  - module: styled-components
    exports: [{ name: styled, role: styled_factory }, { name: default, role: styled_factory }, { name: css, role: style_factory }]
  - module: clsx
    exports: [{ name: default, role: class_composer }]
ui_libraries: [antd, "@mui/material"]
`;

const source = (text: string, path = "catalogs/demo.yaml"): CatalogSource => ({ path, text });
const compile = (catalog = CATALOG, adapters = ADAPTERS) => compileCatalogs({ catalogs: [source(catalog)], adapters: source(adapters, "catalogs/adapters.yaml") });
const problems = (catalog = CATALOG, adapters = ADAPTERS) => {
  const result = compile(catalog, adapters);
  return result.ok ? [] : result.problems;
};

describe("catalog compilation", () => {
  it("compiles to sorted, canonical data with a digest", () => {
    const result = compile();
    if (!result.ok) throw new Error(result.problems.join("\n"));
    const [demo] = result.catalogs;
    expect(demo!.packages).toEqual([{ name: "@demo/core", components: ["Button", "DemoProvider", "FlexLayout", "Text"] }, { name: "@demo/theme" }]);
    expect(demo!.equivalents.map((equivalent) => equivalent.tag)).toEqual(["button", "p"]);
    expect(demo!.tokens).toEqual(["--demo-palette-accent", "--demo-spacing-100"]);
    expect(demo!.property_families).toEqual({ color: ["background-color", "color"], layout: ["display", "gap"] });
    expect(result.adapters.adapters.map((adapter) => [adapter.module, adapter.exports.map((entry) => entry.name)])).toEqual([
      ["clsx", ["default"]],
      ["styled-components", ["css", "default", "styled"]],
    ]);
    expect(result.adapters.ui_libraries).toEqual(["@mui/material", "antd"]);
    expect(result.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic: list order and key order do not change the output", () => {
    const reordered = CATALOG.replace("tokens: [--demo-spacing-100, --demo-palette-accent]", "tokens: [--demo-palette-accent, --demo-spacing-100]")
      .replace("neutral_tags: [span, div]", "neutral_tags: [div, span]")
      .replace("id: demo\nname: Demo", "name: Demo\nid: demo");
    const first = compile();
    const second = compile(reordered);
    expect(second).toEqual(first);
    if (!first.ok || !second.ok) throw new Error("expected both to compile");
    expect(second.digest).toBe(first.digest);
    expect(compile(CATALOG.replace("--demo-spacing-100", "--demo-spacing-200"))).not.toMatchObject({ digest: first.digest });
  });

  it.each([
    ["an unknown top-level field", CATALOG.replace("class_prefix: demo", "class_prefix: demo\nscript: run"), ADAPTERS, "Unrecognized key"],
    ["an unknown nested field", CATALOG.replace('[{ package: "@demo/core", component: DemoProvider }]', '[{ package: "@demo/core", component: DemoProvider, props: {} }]'), ADAPTERS, "Unrecognized key"],
    ["an unknown adapter field", CATALOG, ADAPTERS.replace("role: class_composer }", "role: class_composer, call: true }"), "Unrecognized key"],
    ["an unknown adapter role", CATALOG, ADAPTERS.replace("role: class_composer", "role: evaluator"), "role"],
  ])("rejects %s", (_name, catalog, adapters, message) => {
    expect(problems(catalog, adapters)).toContainEqual(expect.stringContaining(message));
  });

  it.each([
    ["a component", CATALOG.replace("components: [Text,", "components: [\"Text; fetch('x')\","), "must be a component name"],
    ["a token", CATALOG.replace("--demo-palette-accent]", '"--demo-x: red; } body { color: red"]'), "must be a custom property name"],
    ["a tag", CATALOG.replace("neutral_tags: [span, div]", 'neutral_tags: [span, "<script>"]'), "must be an HTML tag name"],
    ["a theme stylesheet", CATALOG.replace('["@demo/theme/index.css"]', '["javascript:alert(1)"]'), "must be a package name or package subpath"],
    ["a neutral value", CATALOG.replace("currentColor]", '"expression(alert(1))"]'), "must be a CSS keyword or a plain number"],
    ["a property", CATALOG.replace("[gap, display]", '[gap, "x(){}"]'), "must be a CSS property name"],
    ["a YAML function tag", CATALOG.replace("components: [Text,", "components: [!!js/function 'function () { return 1 }',"), "must be a component name"],
  ])("rejects executable-looking values: %s", (_name, catalog, message) => {
    expect(problems(catalog)).toContainEqual(expect.stringContaining(message));
  });

  it.each([
    ["a duplicate component", CATALOG.replace("components: [Text,", "components: [Text, Text,"), "component Text is listed more than once"],
    ["a component in two packages", CATALOG.replace('- name: "@demo/theme"', '- name: "@demo/theme"\n    components: [Button]'), "component Button is listed more than once"],
    ["a duplicate token", CATALOG.replace("tokens: [--demo-spacing-100,", "tokens: [--demo-spacing-100, --demo-spacing-100,"), "token --demo-spacing-100 is listed more than once"],
    ["a token without the prefix", CATALOG.replace("--demo-palette-accent]", "--other-accent]"), "does not carry the prefix --demo-"],
    ["an equivalent the package does not list", CATALOG.replace("component: Text }", "component: Paragraph }"), "names Paragraph, which @demo/core does not list"],
    ["an equivalent from another package", CATALOG.replace('{ tag: p, package: "@demo/core"', '{ tag: p, package: "@other/core"'), "not one of the catalog's packages"],
    ["a property in two families", CATALOG.replace("color: [color, background-color]", "color: [color, background-color, gap]"), "property gap is in more than one family"],
    ["a neutral tag with an equivalent", CATALOG.replace("neutral_tags: [span, div]", "neutral_tags: [span, div, button]"), "tag button is both neutral and replaced"],
    ["a theme stylesheet outside the catalog", CATALOG.replace('["@demo/theme/index.css"]', '["other-theme/index.css"]'), "is not in one of the catalog's packages"],
  ])("rejects %s", (_name, catalog, message) => {
    expect(problems(catalog)).toContainEqual(expect.stringContaining(message));
  });

  it("rejects duplicate adapters and UI libraries that are cataloged", () => {
    const adapters = ADAPTERS.replace("  - module: clsx", "  - module: clsx\n    exports: [{ name: default, role: class_composer }]\n  - module: clsx").replace("ui_libraries: [antd,", 'ui_libraries: ["@demo/core", antd,');
    expect(problems(CATALOG, adapters)).toEqual(expect.arrayContaining([expect.stringContaining("module clsx is listed more than once"), expect.stringContaining("UI library @demo/core is a cataloged design-system package")]));
  });

  it("rejects two catalogs with the same id or package", () => {
    const result = compileCatalogs({ catalogs: [source(CATALOG, "catalogs/a.yaml"), source(CATALOG, "catalogs/b.yaml")], adapters: source(ADAPTERS, "catalogs/adapters.yaml") });
    expect(result.ok ? [] : result.problems).toEqual(expect.arrayContaining(["catalog demo is defined more than once", "package @demo/core is in more than one catalog"]));
  });

  it("reports malformed YAML with its path", () => {
    expect(problems("format: [1")).toContainEqual(expect.stringMatching(/^catalogs\/demo\.yaml: Invalid YAML/));
  });
});
