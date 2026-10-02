import crypto from "node:crypto";
import type { BlobContent } from "@repo-facts/contract";
import { SyntaxTree, parseStylesheet } from "@repo-facts/syntax";
import { describe, expect, it } from "vitest";
import { CATALOGS, type ElementRecord, SHIPPED, StyleIndex, analyzeFile, joinPath, scopeOf } from "../src/index.js";

// design-system-usage: elements are classified where they're written; class names are traced to the styles they apply.

const salt = CATALOGS.find((catalog) => catalog.id === "salt")!;

function content(path: string, text: string): BlobContent {
  const bytes = Buffer.from(text);
  return { entry: { path, mode: "100644", type: "file", objectId: "0".repeat(40), size: bytes.length }, bytes, text, binary: false, digest: crypto.createHash("sha256").update(bytes).digest("hex") };
}

/** Analyzes +source+ at src/View.tsx, with +stylesheets+ indexed. */
function analyze(source: string, stylesheets: Record<string, string> = {}, path = "src/View.tsx") {
  const index = new StyleIndex(CATALOGS, [salt]);
  for (const [file, text] of Object.entries(stylesheets)) {
    const result = parseStylesheet(text);
    if (!result.ok) throw new Error(result.failure.reason);
    index.add({ path: file, scope: scopeOf(file), content: content(file, text), kind: file.endsWith(".module.css") ? "module" : "global", stylesheet: result.stylesheet, base: 0, lineAt: (offset) => result.stylesheet.lineOf(offset), interpolations: [] });
  }
  const parsed = SyntaxTree.parse(content(path, source));
  if (!parsed.ok) throw new Error(parsed.failure.reason);
  return analyzeFile(parsed.tree, scopeOf(path), SHIPPED, index);
}

const kinds = (elements: readonly ElementRecord[]) =>
  elements.map(({ element }) => (element.kind === "component" ? `${element.system}:${element.name}` : element.kind === "intrinsic" ? `<${element.tag}>` : element.kind === "library" ? `library:${element.package}` : "other"));

describe("element classification", () => {
  it("counts an aliased import as the Salt component it names", () => {
    expect(kinds(analyze('import { Button as SaltButton } from "@salt-ds/core";\nexport const V = () => <SaltButton />;\n').elements)).toEqual(["salt:Button"]);
  });

  it("counts a namespace member as the Salt component it names", () => {
    expect(kinds(analyze('import * as Salt from "@salt-ds/core";\nexport const V = () => <Salt.Button />;\n').elements)).toEqual(["salt:Button"]);
  });

  it("counts a wrapper imported from another file as another component", () => {
    expect(kinds(analyze('import { ThemeToggle } from "./components";\nexport const AppShell = () => <ThemeToggle />;\n').elements)).toEqual(["other"]);
  });

  it("counts a name bound twice as another component", () => {
    const source = 'import { Button } from "@salt-ds/core";\nexport function V() {\n  const Button = () => null;\n  return <Button />;\n}\n';
    expect(kinds(analyze(source).elements)).toEqual(["other"]);
  });

  it("counts intrinsic elements, other UI libraries, and local components", () => {
    const source = 'import { Button } from "@mui/material/Button";\nconst Local = () => null;\nexport const V = () => <div><Button /><Local /><svg:path /></div>;\n';
    expect(kinds(analyze(source).elements)).toEqual(["<div>", "library:@mui/material", "other", "<svg:path>"]);
  });

  it("puts a story file's elements in the stories scope", () => {
    const { elements } = analyze('import { Button } from "@salt-ds/core";\nexport const Primary = () => <Button className="x" />;\n', {}, "src/Button.stories.tsx");
    expect(elements.map((element) => element.scope)).toEqual(["stories"]);
  });
});

describe("customization", () => {
  const mechanisms = (source: string) => analyze(source).elements.map((element) => [...element.mechanisms].sort().join(",") + (element.spread ? " +spread" : ""));

  it("doesn't count design-system props as customization", () => {
    expect(mechanisms('import { Button } from "@salt-ds/core";\nexport const V = () => <Button appearance="transparent" sentiment="neutral" />;\n')).toEqual([""]);
  });

  it("counts inline style, className, css, and sx", () => {
    const source = 'import { Tabs, Button } from "@salt-ds/core";\nexport const V = () => <><Tabs style={{ minHeight: 220 }} /><Button className="b" css={{ color: "red" }} sx={{ p: 1 }} /></>;\n';
    expect(mechanisms(source)).toEqual(["style", "class_name,css,sx"]);
  });

  it("counts a styled wrapper once at its definition, and its element as the wrapped component", () => {
    const source = 'import styled from "styled-components";\nimport { Button } from "@salt-ds/core";\nconst Primary = styled(Button)`\n  color: red;\n`;\nexport const V = () => <><Primary /><Primary /></>;\n';
    const analysis = analyze(source);
    expect(analysis.wrappers.map((wrapper) => `${wrapper.system}:${wrapper.name}@${wrapper.site.line}`)).toEqual(["salt:Button@3"]);
    // A fragment isn't an element.
    expect(kinds(analysis.elements)).toEqual(["salt:Button", "salt:Button"]);
    expect(mechanisms(source)).toEqual(["styled", "styled"]);
    expect(analysis.elements[0]!.parts).toEqual([{ declarations: [expect.objectContaining({ property: "color", text: "red" })] }]);
  });

  it("follows wrappers of wrappers in the same file", () => {
    const source = 'import styled from "@emotion/styled";\nimport { Button } from "@salt-ds/core";\nconst Base = styled(Button)({ color: "red" });\nconst Quiet = styled(Base)`opacity: 0.5;`;\nexport const V = () => <Quiet />;\n';
    const analysis = analyze(source);
    expect(analysis.wrappers.map((wrapper) => wrapper.name)).toEqual(["Button", "Button"]);
    expect(kinds(analysis.elements)).toEqual(["salt:Button"]);
    expect(analysis.elements[0]!.parts.flatMap((part) => part!.declarations.map((declaration) => declaration.property))).toEqual(["opacity", "color"]);
  });

  it("records a spread so customization is unknown", () => {
    expect(mechanisms('import { Button } from "@salt-ds/core";\nexport const V = (props) => <Button {...props} />;\n')).toEqual([" +spread"]);
  });
});

describe("class tracing", () => {
  const traced = (source: string, stylesheets: Record<string, string> = {}) => {
    const [element] = analyze(source, stylesheets).elements;
    return { classes: element!.classes.map((applied) => `${applied.module ? `${applied.module}#` : ""}${applied.name}${applied.conditional ? "?" : ""}`), parts: element!.parts.map((part) => (part ? part.declarations.map((declaration) => `${declaration.property}: ${declaration.text}`) : null)) };
  };

  it("traces a composer with a condition to module classes, marking the conditional one", () => {
    const source = 'import clsx from "clsx";\nimport styles from "./Row.module.css";\nexport const Row = ({ active }) => <div className={clsx(styles.row, active && styles.active)} />;\n';
    expect(traced(source, { "src/Row.module.css": ".row { display: flex }\n.active { color: red }\n" })).toEqual({ classes: ["src/Row.module.css#row", "src/Row.module.css#active?"], parts: [["display: flex"], ["color: red"]] });
  });

  it("leaves a computed class unresolved", () => {
    expect(traced('export const V = ({ variant }) => <div className={classFor(variant)} />;\n')).toEqual({ classes: [], parts: [null] });
  });

  it("resolves a module class to the declaration its module defines", () => {
    const source = 'import { Button } from "@salt-ds/core";\nimport styles from "./ThemeToggle.module.css";\nexport const ThemeToggle = () => <Button className={styles.button} />;\n';
    expect(traced(source, { "src/ThemeToggle.module.css": ".button { block-size: 2.75rem }\n" })).toEqual({ classes: ["src/ThemeToggle.module.css#button"], parts: [["block-size: 2.75rem"]] });
  });

  it("resolves global classes, and leaves classes no stylesheet defines unresolved", () => {
    expect(traced('export const V = () => <div className="page mt-2" />;\n', { "src/global.css": ".page { padding: 0 }\n" })).toEqual({ classes: ["page", "mt-2"], parts: [["padding: 0"], null] });
  });

  it("reads conditionals, template literals, objects, arrays, and const bindings", () => {
    const source = 'import cx from "classnames";\nconst base = "card";\nexport const V = ({ on, size }) => <div className={cx(base, on ? "on" : "off", { wide: on }, ["x"], `pad ${size}-gap tail`)} />;\n';
    expect(traced(source).classes).toEqual(["card", "on?", "off?", "wide?", "x", "pad", "tail"]);
  });

  it("reads cva variants as conditional classes, but not their default variants", () => {
    const source = 'import { cva } from "class-variance-authority";\nconst button = cva("btn", { variants: { intent: { primary: "btn-primary", quiet: ["btn-quiet"] } }, compoundVariants: [{ intent: "primary", class: "btn-strong" }], defaultVariants: { intent: "primary" } });\nexport const V = () => <button className={button({ intent: "quiet" })} />;\n';
    expect(traced(source).classes).toEqual(["btn", "btn-primary?", "btn-quiet?", "btn-strong?"]);
  });

  it("joins module paths to the importing file's directory", () => {
    expect(joinPath("src/app/Shell.tsx", "../styles/Shell.module.css")).toBe("src/styles/Shell.module.css");
    expect(joinPath("Shell.tsx", "./a.module.css")).toBe("a.module.css");
  });
});
