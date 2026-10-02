import { describe, expect, it } from "vitest";
import { cited, fact, json, profile } from "./support.js";

// design-system-usage: design systems are recognized from catalogs.

describe("design-system recognition", () => {
  it("reports a Salt application's declared range, theme stylesheet import, and provider, each with evidence", async () => {
    const document = await profile({
      "package.json": json({ name: "orders", dependencies: { "@salt-ds/core": "^1.50.0", "@salt-ds/theme": "^1.33.0", react: "18.3.1" } }),
      "src/main.tsx": 'import "@salt-ds/theme/index.css";\nimport { SaltProvider } from "@salt-ds/core";\nimport { App } from "./App";\n\nexport const Root = () => (\n  <SaltProvider mode="light">\n    <App />\n  </SaltProvider>\n);\n',
      "src/App.tsx": 'export const App = () => <main />;\n',
    });
    expect(fact(document, "design_systems", "salt")).toMatchObject({
      state: "observed",
      rule: "design-system.recognize",
      value: {
        catalog: "salt",
        catalog_version: "1.0.0",
        name: "Salt",
        packages: [
          { name: "@salt-ds/core", range: "^1.50.0", manifest: "package.json", field: "dependencies" },
          { name: "@salt-ds/theme", range: "^1.33.0", manifest: "package.json", field: "dependencies" },
        ],
        imported: true,
        theme_stylesheet: true,
        provider: true,
      },
    });
    expect(cited(document, "design_systems", "salt")).toEqual(["package.json#/dependencies/@salt-ds~1core", "src/main.tsx:1", "src/main.tsx:6"]);
    expect(document.categories.design_systems!.state).toBe("observed");
  });

  it("reports Salt as declared but not imported, with no theme stylesheet and no provider", async () => {
    const document = await profile({
      "package.json": json({ name: "orders", devDependencies: { "@salt-ds/core": "1.50.0" } }),
      "src/index.ts": 'import React from "react";\nexport default React;\n',
    });
    expect(fact(document, "design_systems", "salt")!.value).toMatchObject({ packages: [{ name: "@salt-ds/core", range: "1.50.0", field: "devDependencies" }], imported: false, theme_stylesheet: false, provider: false });
    expect(cited(document, "design_systems", "salt")).toEqual(["package.json#/devDependencies/@salt-ds~1core"]);
  });

  it("reports no design system as absent after a complete search, with the surface it searched", async () => {
    const document = await profile({
      "package.json": json({ name: "plain", dependencies: { react: "18.3.1" } }),
      "src/App.tsx": "export const App = () => <button>Go</button>;\n",
      "src/app.css": "button { color: red }\n",
    });
    expect(document.categories.design_systems).toMatchObject({ state: "absent", facts: [], search: { complete: true, skipped: [], surface: ["package.json", "src/App.tsx", "src/app.css"] } });
  });

  it("recognizes imports without a declaration, providers through a namespace, and theme imports from stylesheets", async () => {
    const document = await profile({
      "package.json": json({ name: "hoisted" }),
      "src/styles/global.css": '@import "~@salt-ds/theme/index.css";\nbody { margin: 0 }\n',
      "src/root.jsx": 'import * as Salt from "@salt-ds/core";\nexport const Root = ({ children }) => <Salt.SaltProviderNext>{children}</Salt.SaltProviderNext>;\n',
    });
    expect(fact(document, "design_systems", "salt")!.value).toMatchObject({ packages: [], imported: true, theme_stylesheet: true, provider: true });
    expect(cited(document, "design_systems", "salt")).toEqual(["src/root.jsx:1", "src/root.jsx:2", "src/styles/global.css:1"]);
  });

  it("doesn't count a lookalike package, a local provider, or a theme stylesheet that isn't an entry point", async () => {
    const document = await profile({
      "package.json": json({ name: "lookalike", dependencies: { "@salt-ds/core-extras": "1.0.0", "salt-ds": "1.0.0" } }),
      "src/root.tsx": 'import "@salt-ds/theme/css/global.css";\nconst SaltProvider = ({ children }) => children;\nexport const Root = () => <SaltProvider />;\n',
    });
    expect(fact(document, "design_systems", "salt")!.value).toMatchObject({ packages: [], imported: true, theme_stylesheet: false, provider: false });
  });

  it("keeps the category unknown when a source file can't be parsed", async () => {
    const document = await profile({
      "package.json": json({ name: "broken" }),
      "src/broken.tsx": "export const = ;\n",
      "src/deep.css": `${".a {".repeat(70)}${"}".repeat(70)}\n`,
    });
    expect(document.categories.design_systems).toMatchObject({ state: "unknown", search: { skipped: ["src/broken.tsx", "src/deep.css"] } });
    expect(document.diagnostics.map(({ path, reason }) => `${path}: ${reason}`)).toEqual(expect.arrayContaining(["src/broken.tsx: syntax_error", "src/deep.css: stylesheet_depth_limit"]));
  });
});
