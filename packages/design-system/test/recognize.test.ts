import { describe, expect, it } from "vitest";
import { fixtureEntry } from "../../../test/catalog/entries.js";
import { SALT, cited, fact, json, profile } from "./support.js";

// design-system-usage: design systems are recognized from supplied Reference Catalog entries,
// and each is compared against the entry for the version in use.

const SALT_175 = fixtureEntry("salt-1.75.0");
const MUI = fixtureEntry("mui-6.1.0");

/** An npm lockfile (version 3) resolving +versions+ for the root manifest. */
const lockfile = (versions: Record<string, string>) => json({ name: "orders", lockfileVersion: 3, packages: { "": { name: "orders" }, ...Object.fromEntries(Object.entries(versions).map(([name, version]) => [`node_modules/${name}`, { version }])) } });

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
        name: "Salt",
        entry: { version: "1.50.0", digest: SALT.digest },
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

  it("recognizes no design system when no entries are supplied, and the survey still succeeds", async () => {
    const document = await profile(
      {
        "package.json": json({ name: "orders", dependencies: { "@salt-ds/core": "^1.50.0", "@mui/material": "6.1.0" } }),
        "src/App.tsx": 'import { Button } from "@salt-ds/core";\nimport { TextField } from "@mui/material";\nexport const App = () => <><Button /><TextField /></>;\n',
      },
      [],
    );
    // Without entries, nothing could be recognized, so the category isn't absent: it's unknown.
    expect(document.categories.design_systems).toMatchObject({ state: "unknown", facts: [], search: { complete: false } });
    expect(document.diagnostics).toContainEqual(expect.objectContaining({ reason: "no_catalog_entries", detector: "design-system.recognize" }));
    expect(document.catalog_entries).toEqual([]);
    const elements = document.categories.ui_elements!.facts.map((item) => item.key);
    expect(elements).toContain("library:@mui/material");
    expect(elements.filter((key) => key.startsWith("component:"))).toEqual([]);
  });

  it("compares against the entry for the version the lockfile resolves, and names it", async () => {
    const document = await profile({ "package.json": json({ name: "orders", dependencies: { "@salt-ds/core": "^1.50.0" } }), "package-lock.json": lockfile({ "@salt-ds/core": "1.75.0" }), "src/a.ts": 'import "@salt-ds/core";\n' }, [SALT, SALT_175]);
    expect(fact(document, "design_systems", "salt")!.value).toMatchObject({ entry: { version: "1.75.0", digest: SALT_175.digest } });
    expect(document.catalog_entries).toEqual([{ kind: "design_system", id: "salt", version: "1.75.0", format_version: 1, digest: SALT_175.digest, wanted: { package: "@salt-ds/core", version: "1.75.0" } }]);
  });

  it("without a lockfile, wants the highest version the declared range allows", async () => {
    const declared = (range: string) => profile({ "package.json": json({ name: "orders", dependencies: { "@salt-ds/core": range } }) }, [SALT, SALT_175]).then((document) => document.catalog_entries[0]);
    expect(await declared("^1.50.0")).toMatchObject({ version: "1.75.0", wanted: { version: "1.75.0" } });
    expect(await declared("~1.50.0")).toMatchObject({ version: "1.50.0", wanted: { version: "1.50.0" } });
    // No entry is in range: the lowest version the range allows, compared against the nearest earlier entry.
    expect(await declared("^1.76.0")).toMatchObject({ version: "1.75.0", wanted: { version: "1.76.0" } });
  });

  it("compares a version with no exact entry against the nearest earlier one", async () => {
    const document = await profile({ "package.json": json({ name: "orders", dependencies: { "@salt-ds/core": "1.76.0" } }), "package-lock.json": lockfile({ "@salt-ds/core": "1.76.0" }) }, [SALT, SALT_175]);
    expect(document.catalog_entries).toEqual([{ kind: "design_system", id: "salt", version: "1.75.0", format_version: 1, digest: SALT_175.digest, wanted: { package: "@salt-ds/core", version: "1.76.0" } }]);
  });

  it("matches a repository that resolves only the theme by the theme version each entry was built from", async () => {
    const document = await profile({ "package.json": json({ name: "orders", dependencies: { "@salt-ds/theme": "^1.33.0" } }), "package-lock.json": lockfile({ "@salt-ds/theme": "1.48.0" }), "src/a.css": '@import "@salt-ds/theme/index.css";\n' }, [SALT, SALT_175]);
    expect(document.catalog_entries[0]).toMatchObject({ version: "1.75.0", wanted: { package: "@salt-ds/theme", version: "1.48.0" } });
  });

  it("records no entry when every entry is later than the version in use, so a later build changes the recipe", async () => {
    const document = await profile({ "package.json": json({ name: "orders", dependencies: { "@salt-ds/core": "1.40.0" } }), "src/App.tsx": 'import { Button } from "@salt-ds/core";\nexport const App = () => <Button />;\n' }, [SALT, SALT_175]);
    expect(fact(document, "design_systems", "salt")!.value).toMatchObject({ name: "Salt", entry: null, imported: true });
    expect(document.catalog_entries).toEqual([{ kind: "design_system", id: "salt", version: null, format_version: null, digest: null, wanted: { package: "@salt-ds/core", version: "1.40.0" } }]);
    // Nothing is compared: the Button isn't counted as a Salt component.
    expect(document.categories.ui_elements!.facts.map((item) => item.key)).toEqual(["other"]);
  });

  it("compares two design systems in one repository, each against its own entry", async () => {
    const document = await profile(
      {
        "package.json": json({ name: "orders", dependencies: { "@salt-ds/core": "^1.75.0", "@mui/material": "^6.1.0" } }),
        "src/App.tsx": 'import { Button } from "@salt-ds/core";\nimport { Button as MuiButton } from "@mui/material";\nexport const App = () => <><Button /><MuiButton variant="text" /><button /></>;\n',
        "src/app.css": ".a { color: var(--salt-color-jpmBrown); background-color: var(--mui-palette-primary-main); gap: var(--mui-spacing-x); }\n",
      },
      [SALT, SALT_175, MUI],
    );
    expect(document.catalog_entries.map((entry) => `${entry.id} ${entry.version}`)).toEqual(["mui 6.1.0", "salt 1.75.0"]);
    expect(document.categories.design_systems!.facts.map((item) => item.key)).toEqual(["mui", "salt"]);
    const elements = Object.fromEntries(document.categories.ui_elements!.facts.map((item) => [item.key, item.value]));
    expect(Object.keys(elements)).toEqual(expect.arrayContaining(["component:mui:Button", "component:salt:Button", "summary:mui", "summary:salt"]));
    expect(elements["component:mui:Button"]).toMatchObject({ props: { app: { names: { variant: { count: 1, values: { text: 1 } } } } } });
    const styles = document.categories.style_values!.facts.map((item) => item.key);
    expect(styles).toContain("unknown-token:--mui-spacing-x");
    expect(styles.filter((key) => key.startsWith("unknown-token:--salt-"))).toEqual([]);
  });

  it("leaves out an entry in a format it doesn't read, naming the entry and its format version", async () => {
    const document = await profile({ "package.json": json({ name: "orders", dependencies: { "@salt-ds/core": "1.75.0" } }) }, [SALT, { ...SALT_175, format_version: 2 }]);
    expect(document.diagnostics).toContainEqual({ path: "", reason: "unsupported_entry_format", detail: "Reference Catalog entry salt 1.75.0 has format version 2; this release reads reference_catalog.entry format version 1", detector: "design-system.recognize" });
    expect(document.catalog_entries[0]).toMatchObject({ version: "1.50.0", wanted: { version: "1.75.0" } });
  });
});
