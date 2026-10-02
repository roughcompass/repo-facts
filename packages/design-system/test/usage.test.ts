import { MemoryReader, digestOf, runDetectors } from "@repo-facts/contract";
import { CORE_DETECTORS } from "@repo-facts/core";
import { describe, expect, it } from "vitest";
import { DESIGN_SYSTEM_DETECTORS } from "../src/index.js";
import { cited, fact, facts, json, profile } from "./support.js";

// design-system-usage: the usage facts, by scope, with sample evidence.

const SALT = json({ name: "app", dependencies: { "@salt-ds/core": "^1.50.0", react: "18.3.1" } });
const values = (document: Awaited<ReturnType<typeof profile>>, category: string) => Object.fromEntries(facts(document, category).map((item) => [item.key, item.value]));

describe("element facts", () => {
  it("counts each design-system component as-is or customized, by mechanism and style resolution", async () => {
    const document = await profile({
      "package.json": SALT,
      "src/ThemeToggle.module.css": ".button { block-size: 2.75rem }\n",
      "src/ThemeToggle.tsx": 'import { Button } from "@salt-ds/core";\nimport styles from "./ThemeToggle.module.css";\nexport const ThemeToggle = (props) => (\n  <>\n    <Button appearance="transparent" sentiment="neutral" />\n    <Button className={styles.button} />\n    <Button className={pick()} style={{ minHeight: 220 }} />\n    <Button {...props} />\n  </>\n);\n',
      "src/Orders.tsx": 'import { Tabs } from "@salt-ds/core";\nexport const Orders = () => <Tabs style={{ minHeight: 220 }} />;\n',
    });
    expect(fact(document, "ui_elements", "component:salt:Button")!.value).toEqual({
      package: "@salt-ds/core",
      app: { sites: 4, as_is: 1, customized: 2, unknown: 1, mechanisms: { class_name: 2, style: 1, css: 0, sx: 0, styled: 0 }, styles: { resolved: 1, partial: 1, unresolved: 0 } },
      stories: { sites: 0, as_is: 0, customized: 0, unknown: 0, mechanisms: { class_name: 0, style: 0, css: 0, sx: 0, styled: 0 }, styles: { resolved: 0, partial: 0, unresolved: 0 } },
      tests: { sites: 0, as_is: 0, customized: 0, unknown: 0, mechanisms: { class_name: 0, style: 0, css: 0, sx: 0, styled: 0 }, styles: { resolved: 0, partial: 0, unresolved: 0 } },
    });
    expect(fact(document, "ui_elements", "component:salt:Tabs")!.value).toMatchObject({ app: { sites: 1, customized: 1, mechanisms: { style: 1 }, styles: { resolved: 1 } } });
    expect(cited(document, "ui_elements", "component:salt:Button")).toEqual(["src/ThemeToggle.tsx:5", "src/ThemeToggle.tsx:6", "src/ThemeToggle.tsx:7"]);
  });

  it("counts a styled wrapper's definition once, and its elements as the wrapped component", async () => {
    const document = await profile({
      "package.json": SALT,
      "src/Primary.tsx": 'import styled from "styled-components";\nimport { Button } from "@salt-ds/core";\nconst Primary = styled(Button)`\n  color: red;\n`;\nexport const A = () => <Primary />;\nexport const B = () => <Primary />;\n',
    });
    expect(fact(document, "ui_elements", "wrapper:salt:Button")!.value).toEqual({ app: { definitions: 1 }, stories: { definitions: 0 }, tests: { definitions: 0 } });
    expect(fact(document, "ui_elements", "component:salt:Button")!.value).toMatchObject({ app: { sites: 2, customized: 2, mechanisms: { styled: 2 } } });
    // The wrapper's template is counted once, where it's written.
    expect(fact(document, "style_values", "declarations:color")!.value).toMatchObject({ app: { raw: 1 } });
  });

  it("counts a story's elements in the stories scope, and not the app scope", async () => {
    const document = await profile({ "package.json": SALT, "src/Button.stories.tsx": 'import { Button } from "@salt-ds/core";\nexport const Primary = () => <Button className="x" />;\n' });
    expect(fact(document, "ui_elements", "component:salt:Button")!.value).toMatchObject({ app: { sites: 0 }, stories: { sites: 1, customized: 1 } });
  });

  it("compares intrinsic elements with Salt: equivalents, and unstyled, layout-only, and custom-styled containers", async () => {
    const document = await profile({
      "package.json": SALT,
      "src/Row.module.css": ".row { display: flex; gap: var(--salt-spacing-100) }\n",
      "src/global.css": ".tone { color: #0a6 }\n",
      "src/View.tsx": 'import styles from "./Row.module.css";\nexport const V = ({ props }) => (\n  <section>\n    <button>Go</button>\n    <div />\n    <div className={styles.row} />\n    <div className="tone" />\n    <div className={dynamic()} />\n    <form />\n  </section>\n);\n',
    });
    const elements = values(document, "ui_elements");
    expect(elements["intrinsic:button"]).toEqual({ group: "equivalent", equivalent: "salt:Button", app: { sites: 1, unstyled: 1, styled: 0 }, stories: { sites: 0, unstyled: 0, styled: 0 }, tests: { sites: 0, unstyled: 0, styled: 0 } });
    expect(elements["intrinsic:div"]).toMatchObject({ group: "neutral", equivalent: null, app: { sites: 4, unstyled: 1, styled: 3, custom_styled: 1, styled_unresolved: 1 } });
    expect(elements["intrinsic:form"]).toMatchObject({ group: "other", app: { sites: 1 } });
    const layout = fact(document, "ui_elements", "layout-only:div")!;
    expect(layout).toMatchObject({ state: "inferred", value: { app: { sites: 1 } } });
    expect(layout.reasoning).toContain("Salt layout component could apply instead: display: flex (src/Row.module.css:1); gap: var(--salt-spacing-100) (src/Row.module.css:1)");
    // An inferred classification never makes the observed intrinsic facts inferred.
    expect(fact(document, "ui_elements", "intrinsic:div")!.state).toBe("observed");
  });

  it("reports customized and adoption shares, rounded down, and omits a share with nothing to divide", async () => {
    const buttons = Array.from({ length: 9 }, (_, index) => (index < 3 ? '<Button className="x" />' : "<Button />")).join("");
    const document = await profile({
      "package.json": SALT,
      "src/A.tsx": `import { Button } from "@salt-ds/core";\nexport const A = () => <>${buttons}<button /></>;\n`,
      "src/Plain.test.tsx": "export const T = () => <div />;\n",
    });
    expect(fact(document, "ui_elements", "summary:salt")!.value).toEqual({
      app: { elements: 10, design_system: 9, customized_share: 33, adoption_share: 90 },
      stories: { elements: 0, design_system: 0 },
      tests: { elements: 1, design_system: 0 },
    });
  });

  it("counts every site and cites only the first samples in path order", async () => {
    const files: Record<string, string> = { "package.json": SALT };
    for (let file = 0; file < 4; file++) files[`src/page-${file}.tsx`] = `import { Button } from "@salt-ds/core";\nexport const P = () => <>\n${Array.from({ length: 100 }, () => "<Button />").join("\n")}\n</>;\n`;
    const document = await profile(files);
    expect(fact(document, "ui_elements", "component:salt:Button")!.value).toMatchObject({ app: { sites: 400, as_is: 400 } });
    expect(cited(document, "ui_elements", "component:salt:Button")).toEqual(["src/page-0.tsx:3", "src/page-0.tsx:4", "src/page-0.tsx:5"]);
  });
});

describe("style value facts", () => {
  it("counts declarations by family and kind, with findings and the token share", async () => {
    const document = await profile({
      "package.json": SALT,
      "src/theme.css": ":root {\n  --salt-palette-accent: red;\n  --app-gap: var(--salt-spacing-200);\n}\n",
      "src/app.css": ".a {\n  padding: var(--salt-spacing-300);\n  color: #0a6;\n  gap: var(--salt-spacing-275);\n  margin: var(--app-gap) !important;\n}\nbutton, input { font: inherit }\n.saltButton-primary span { color: red }\n",
    });
    const styles = values(document, "style_values");
    expect(styles["declarations:spacing"]).toMatchObject({ app: { token: 1, other_custom_property: 1, raw: 0 } });
    expect(styles["declarations:color"]).toMatchObject({ app: { raw: 2 } });
    expect(styles["redefinition:--salt-palette-accent"]).toMatchObject({ app: { count: 1 } });
    expect(styles["unknown-token:--salt-spacing-275"]).toMatchObject({ app: { count: 1 } });
    expect(styles["element-selector:button"]).toMatchObject({ app: { count: 1 } });
    expect(styles["element-selector:input"]).toMatchObject({ app: { count: 1 } });
    expect(styles["internal-selector:salt"]).toMatchObject({ app: { count: 1 } });
    expect(styles.important).toMatchObject({ app: { count: 1 } });
    const aliases = fact(document, "style_values", "token-aliases:spacing")!;
    expect(aliases).toMatchObject({ state: "inferred", value: { app: { declarations: 1, aliases: 1 } } });
    expect(aliases.reasoning).toContain("--app-gap, defined as var(--salt-spacing-200) (src/theme.css:3)");
    // padding (token), margin (alias), color twice (raw), and font (neutral) are token-capable; gap is layout.
    expect(fact(document, "style_values", "summary:salt")).toMatchObject({ state: "inferred", value: { app: { token_capable: 5, tokenized: 2, token_share: 40 } } });
  });

  it("reads inline style objects and styled templates as declarations, with interpolations unresolved", async () => {
    const document = await profile({
      "package.json": SALT,
      "src/Tone.tsx": 'import styled from "styled-components";\nconst Tone = styled.span`\n  color: ${(props) => props.tone};\n`;\nexport const V = () => <Tone><div style={{ minHeight: 220, padding: "var(--salt-spacing-100)" }} /></Tone>;\n',
    });
    const styles = values(document, "style_values");
    expect(styles["declarations:color"]).toMatchObject({ app: { unresolved: 1 } });
    expect(styles["declarations:sizing"]).toMatchObject({ app: { raw: 1 } });
    expect(styles["declarations:spacing"]).toMatchObject({ app: { token: 1 } });
  });

  it("lists SCSS as a skipped input on both categories, while reporting facts from the CSS", async () => {
    const document = await profile({ "package.json": SALT, "src/app.css": ".a { color: red }\n", "src/theme.scss": "$a: red;\n" });
    for (const category of ["ui_elements", "style_values"]) expect(document.categories[category]!.search.skipped).toEqual(["src/theme.scss"]);
    expect(document.categories.style_values!.state).toBe("observed");
    expect(document.diagnostics).toContainEqual(expect.objectContaining({ path: "src/theme.scss", reason: "unsupported_input" }));
  });

  it("reports both categories absent for a repository with no UI, after a complete search", async () => {
    const document = await profile({ "package.json": json({ name: "lib" }), "src/index.ts": "export const one = 1;\n" });
    for (const category of ["design_systems", "ui_elements", "style_values"]) expect(document.categories[category]!.state, category).toBe("absent");
  });

  it("produces the same digest when run twice", async () => {
    const files = { "package.json": SALT, "src/a.css": ".a { color: red }\n", "src/A.tsx": 'import { Button } from "@salt-ds/core";\nexport const A = () => <Button className="a" />;\n' };
    const run = () => runDetectors({ reader: MemoryReader.fromFiles(files, { commit: "a".repeat(40) }), detectorRelease: "0.1.0", detectors: [...CORE_DETECTORS, ...DESIGN_SYSTEM_DETECTORS] });
    expect(digestOf(await run()).digest).toBe(digestOf(await run()).digest);
  });
});
