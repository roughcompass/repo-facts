import { describe, expect, it } from "vitest";
import { cited, fact, facts, json, profile } from "./support.js";

// accessibility: declared tooling and static checks, by scope, with sample evidence.

const APP = json({ name: "app", dependencies: { react: "18.3.1" }, devDependencies: { "eslint-plugin-jsx-a11y": "^6.10.0", "jest-axe": "^9.0.0", "@axe-core/playwright": "^4.10.0", "@storybook/addon-a11y": "^9.0.0" } });
const zero = { checked: 0, failing: 0, unknown: 0 };

describe("accessibility tooling", () => {
  it("names each accessibility tool a manifest declares, with its kind and every declaration", async () => {
    const document = await profile({ "package.json": APP, "src/App.tsx": "export const App = () => <main />;\n" });
    expect(Object.fromEntries(facts(document, "accessibility").filter((item) => item.key.startsWith("tool:")).map((item) => [item.key, item.value]))).toEqual({
      "tool:eslint-plugin-jsx-a11y": { id: "eslint-plugin-jsx-a11y", label: "eslint-plugin-jsx-a11y", kind: "lint" },
      "tool:jest-axe": { id: "jest-axe", label: "jest-axe", kind: "test" },
      "tool:axe-playwright": { id: "axe-playwright", label: "axe for Playwright", kind: "test" },
      "tool:storybook-a11y": { id: "storybook-a11y", label: "Storybook accessibility addon", kind: "storybook" },
    });
    expect(cited(document, "accessibility", "tool:jest-axe")).toEqual(["package.json#/devDependencies/jest-axe"]);
  });

  it("reports the category absent after a complete search that finds no tooling and no element to check", async () => {
    const document = await profile({ "package.json": json({ name: "lib" }), "src/index.ts": "export const one = 1;\n" });
    expect(document.categories.accessibility).toMatchObject({ state: "absent", facts: [] });
  });
});

describe("accessibility checks", () => {
  it("counts the elements each check examines and those that fail it, by scope, citing the failures", async () => {
    const document = await profile({
      "package.json": APP,
      "src/Card.tsx": [
        "export const Card = (props) => (",
        '  <div onClick={open} tabIndex={2}>',
        '    <img src="a.png" />',
        '    <img src="b.png" alt="" />',
        "    <img {...props} />",
        '    <a onClick={open}>Open</a>',
        '    <span role="button" onClick={open} tabIndex={0}>Close</span>',
        '    <iframe src="https://example.test" title="Example" />',
        "  </div>",
        ");",
        "",
      ].join("\n"),
      "src/Card.test.tsx": 'export const Shot = () => <img src="c.png" />;\n',
      "index.html": '<!doctype html>\n<html>\n<head><title>App</title></head>\n</html>\n',
    });
    expect(fact(document, "accessibility", "check:img-alt")!.value).toEqual({ app: { checked: 3, failing: 1, unknown: 1 }, stories: zero, tests: { checked: 1, failing: 1, unknown: 0 } });
    expect(cited(document, "accessibility", "check:img-alt")).toEqual(["src/Card.test.tsx:1", "src/Card.tsx:3"]);
    expect(fact(document, "accessibility", "check:anchor-href")!.value).toMatchObject({ app: { checked: 1, failing: 1, unknown: 0 } });
    expect(fact(document, "accessibility", "check:click-role")!.value).toMatchObject({ app: { checked: 2, failing: 1, unknown: 0 } });
    expect(fact(document, "accessibility", "check:tabindex-positive")!.value).toMatchObject({ app: { checked: 2, failing: 1, unknown: 0 } });
    // No iframe fails, so the check cites the iframes it examined.
    expect(fact(document, "accessibility", "check:iframe-title")!.value).toMatchObject({ app: { checked: 1, failing: 0 } });
    expect(cited(document, "accessibility", "check:iframe-title")).toEqual(["src/Card.tsx:8"]);
    expect(fact(document, "accessibility", "check:html-lang")!.value).toMatchObject({ app: { checked: 1, failing: 1 } });
    expect(cited(document, "accessibility", "check:html-lang")).toEqual(["index.html:2"]);
  });

  it("reads a JSX document's html element, and leaves out a check that examines nothing", async () => {
    const document = await profile({ "package.json": APP, "app/layout.tsx": 'export default function Layout({ children }) {\n  return <html lang="en"><body>{children}</body></html>;\n}\n' });
    expect(fact(document, "accessibility", "check:html-lang")!.value).toMatchObject({ app: { checked: 1, failing: 0 } });
    expect(fact(document, "accessibility", "check:img-alt")).toBeUndefined();
  });

  it("keeps a component's template on the surface as a skipped input", async () => {
    const document = await profile({ "package.json": json({ name: "app", dependencies: { vue: "3.5.0" } }), "src/App.vue": '<template><img src="a.png"></template>\n' });
    expect(document.categories.accessibility!.state).toBe("unknown");
  });
});
