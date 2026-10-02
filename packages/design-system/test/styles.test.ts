import crypto from "node:crypto";
import type { BlobContent } from "@repo-facts/contract";
import { parseStylesheet } from "@repo-facts/syntax";
import { describe, expect, it } from "vitest";
import { CATALOGS, StyleIndex, type StyleSource, scopeOf } from "../src/index.js";

// design-system-usage: stylesheets report adherence findings; classes are traced to the styles they apply.

const salt = CATALOGS.find((catalog) => catalog.id === "salt")!;

function source(path: string, text: string, kind: StyleSource["kind"] = path.endsWith(".module.css") ? "module" : "global"): StyleSource {
  const bytes = Buffer.from(text);
  const content: BlobContent = { entry: { path, mode: "100644", type: "file", objectId: "0".repeat(40), size: bytes.length }, bytes, text, binary: false, digest: crypto.createHash("sha256").update(bytes).digest("hex") };
  const result = parseStylesheet(text);
  if (!result.ok) throw new Error(result.failure.reason);
  return { path, scope: scopeOf(path), content, kind, stylesheet: result.stylesheet, base: 0, lineAt: (offset) => result.stylesheet.lineOf(offset), interpolations: [] };
}

function index(files: Record<string, string>, used = [salt]) {
  const built = new StyleIndex(CATALOGS, used);
  for (const [path, text] of Object.entries(files)) built.add(source(path, text));
  return built;
}

const findings = (built: StyleIndex) => built.findings.map((finding) => `${finding.key} ${finding.site.path}:${finding.site.line}`);

describe("stylesheet findings", () => {
  it("reports a theme override as a token redefinition", () => {
    expect(findings(index({ "src/theme.css": ":root {\n  --salt-palette-accent: red;\n  --app-gap: 4px;\n}\n" }))).toEqual(["redefinition:--salt-palette-accent src/theme.css:2"]);
  });

  it("reports a selector into Salt internals, including inside :is() and nesting", () => {
    const built = index({ "src/app.css": ".saltButton-primary span { color: red }\n.salt-theme .card {}\n.card { :is(.saltText) & {} }\n.saltire {}\n" });
    expect(findings(built)).toEqual(["internal-selector:salt src/app.css:1", "internal-selector:salt src/app.css:2", "internal-selector:salt src/app.css:3"]);
  });

  it("reports a misspelled token as unknown, and not a known one", () => {
    const built = index({ "src/app.css": ".row {\n  gap: var(--salt-spacing-275);\n  padding: var(--salt-spacing-100, var(--salt-spacing-999));\n}\n" });
    expect(findings(built)).toEqual(["unknown-token:--salt-spacing-275 src/app.css:2", "unknown-token:--salt-spacing-999 src/app.css:3"]);
  });

  it("reports global element rules for tags with a Salt equivalent, in a Salt application", () => {
    const css = "button, input { font: inherit }\n@media (width > 600px) { select { margin: 0 } }\n.card button {}\nbutton.primary {}\n[data-x] input {}\ndiv, span { margin: 0 }\na:hover { color: red }\n@keyframes spin { from { rotate: 0 } }\n";
    expect(findings(index({ "src/global.css": css }))).toEqual([
      "element-selector:button src/global.css:1",
      "element-selector:input src/global.css:1",
      "element-selector:select src/global.css:2",
      "element-selector:a src/global.css:7",
    ]);
    expect(findings(index({ "src/global.css": css }, []))).toEqual([]);
  });

  it("reports !important declarations, with each finding's scope", () => {
    const built = index({ "src/app.css": ".a { color: red !important }\n", "src/Button.stories.css": ".b { color: red !important }\n" });
    expect(built.findings.map((finding) => [finding.key, finding.scope])).toEqual([
      ["important", "app"],
      ["important", "stories"],
    ]);
  });
});

describe("the class index", () => {
  it("associates module classes with their file, and global classes across global stylesheets", () => {
    const built = index({
      "src/ThemeToggle.module.css": ".button { block-size: 2.75rem }\n.row .active { color: red }\n",
      "src/global.css": ".page { padding: 0 }\n",
      "src/more.css": ".page { margin: 0 }\n",
    });
    const properties = (declarations: { declaration: { property: string } }[] | undefined) => declarations?.map((item) => item.declaration.property);
    expect(properties(built.moduleClass("src/ThemeToggle.module.css", "button"))).toEqual(["block-size"]);
    expect(properties(built.moduleClass("src/ThemeToggle.module.css", "active"))).toEqual(["color"]);
    expect(properties(built.moduleClass("src/ThemeToggle.module.css", "row"))).toEqual(["color"]);
    expect(properties(built.globalClasses.get("page"))).toEqual(["padding", "margin"]);
    expect(built.globalClasses.has("button")).toBe(false);
  });

  it("associates a class with the rules nested inside its rule, and skips descriptor at-rules", () => {
    const built = index({ "src/card.css": ".card {\n  color: red;\n  &:hover { color: blue }\n  @media (width > 1px) { padding: 0 }\n}\n@font-face { font-family: Trap; src: url(x.woff2) }\n" });
    expect(built.globalClasses.get("card")!.map((item) => `${item.declaration.property}:${item.declaration.text}`)).toEqual(["color:red", "color:blue", "padding:0"]);
    expect(built.declarations.map((item) => item.declaration.property)).toEqual(["color", "color", "padding"]);
  });

  it("collects custom-property definitions repository-wide, apart from style declarations", () => {
    const built = index({ "src/a.css": ":root { --app-gap: var(--salt-spacing-200) }\n", "src/b.css": ".x { --app-gap: 4px; gap: var(--app-gap) }\n" });
    expect(built.definitions.get("--app-gap")!.map((item) => `${item.site.path}:${item.declaration.text}`)).toEqual(["src/a.css:var(--salt-spacing-200)", "src/b.css:4px"]);
    expect(built.declarations.map((item) => item.declaration.property)).toEqual(["gap"]);
  });
});

describe("scopes", () => {
  it.each([
    ["src/Button.stories.tsx", "stories"],
    ["src/Button.story.jsx", "stories"],
    ["src/Button.test.tsx", "tests"],
    ["src/Button.spec.ts", "tests"],
    ["src/__tests__/Button.tsx", "tests"],
    ["e2e/links.ts", "tests"],
    ["cypress/support/commands.js", "tests"],
    ["packages/ui/test/helpers.tsx", "tests"],
    ["src/stories.tsx", "app"],
    ["src/testing/Button.tsx", "app"],
    ["src/latest.tsx", "app"],
  ])("%s is in the %s scope", (path, scope) => {
    expect(scopeOf(path)).toBe(scope);
  });
});
