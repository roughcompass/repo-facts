import { type FactDocument, MemoryReader, type MemoryFile, factDocumentProblems, resolveEvidence, runDetectors } from "@repo-facts/contract";
import { CORE_DETECTORS } from "@repo-facts/core";
import { describe, expect, it } from "vitest";
import { ARCHITECTURE_DETECTORS, htmlImportMaps } from "../src/index.js";

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

async function profile(files: Record<string, MemoryFile>) {
  const reader = MemoryReader.fromFiles(files, { commit: "a".repeat(40) });
  const document = await runDetectors({ reader, surveyorRelease: "0.1.0", detectors: [...CORE_DETECTORS, ...ARCHITECTURE_DETECTORS] });
  expect(factDocumentProblems(document)).toEqual([]);
  return { document, reader };
}

const facts = (document: FactDocument, category: string) => document.categories[category]!.facts;
const fact = (document: FactDocument, category: string, key: string) => facts(document, category).find((item) => item.key === key)!;
const references = (document: FactDocument) => document.relationship_references.map((reference) => `${reference.type}/${reference.role} ${JSON.stringify(reference.identifier)}`).sort();
const cited = (document: FactDocument, category: string, key: string) =>
  fact(document, category, key)
    .evidence.map((id) => {
      const { path, location } = document.evidence[id]!;
      return `${path}${location.kind === "lines" ? `:${location.start}` : location.kind === "pointer" ? `#${location.pointer}` : ""}`;
    })
    .sort();

describe("package production and consumption", () => {
  const WORKSPACE = {
    "package.json": json({ name: "acme-platform", private: true, workspaces: ["packages/*"] }),
    "packages/ui/package.json": json({ name: "@acme/ui", version: "2.1.0", peerDependencies: { react: ">=18" } }),
    "packages/analytics/package.json": json({ name: "@acme/analytics", version: "1.0.0" }),
    "packages/web/package.json": json({ name: "@acme/web", private: true, dependencies: { "@acme/ui": "workspace:*", react: "18.3.1", "@acme/design-tokens": "4.0.0" } }),
  };

  it("reports every produced package, published unless private", async () => {
    const { document } = await profile(WORKSPACE);
    expect(Object.fromEntries(facts(document, "packages_produced").map((item) => [item.key, item.value]))).toEqual({
      "@acme/analytics": { name: "@acme/analytics", manifest: "packages/analytics/package.json", version: "1.0.0", published: true },
      "@acme/ui": { name: "@acme/ui", manifest: "packages/ui/package.json", version: "2.1.0", published: true },
      "@acme/web": { name: "@acme/web", manifest: "packages/web/package.json", version: null, published: false },
      "acme-platform": { name: "acme-platform", manifest: "package.json", version: null, published: false },
    });
  });

  it("marks packages consumed from this repository as internal, and references only external ones and published ones", async () => {
    const { document } = await profile(WORKSPACE);
    expect(Object.fromEntries(facts(document, "packages_consumed").map((item) => [item.key, item.value]))).toEqual({
      "@acme/design-tokens": { name: "@acme/design-tokens", internal: false },
      "@acme/ui": { name: "@acme/ui", internal: true },
      react: { name: "react", internal: false },
    });
    expect(cited(document, "packages_consumed", "react")).toEqual(["packages/ui/package.json#/peerDependencies/react", "packages/web/package.json#/dependencies/react"]);
    expect(references(document).filter((reference) => reference.startsWith("package/"))).toEqual([
      'package/consumer {"name":"@acme/design-tokens"}',
      'package/consumer {"name":"react"}',
      'package/producer {"name":"@acme/analytics"}',
      'package/producer {"name":"@acme/ui"}',
    ]);
    // @acme/web and acme-platform are private: never published, so no other repository can depend on them.
  });
});

describe("single-spa and import maps", () => {
  const ROOT_CONFIG = [
    'import { registerApplication, start } from "single-spa";',
    "",
    "// registerApplication({ name: \"@acme/commented-out\", app: load });",
    'const label = "registerApplication({ name: \'in-a-string\' })";',
    "export function registerFleetApplications() {",
    "  registerApplication({",
    '    name: "spa-orders",',
    '    app: () => window.System.import("spa-orders"),',
    "    activeWhen: () => true,",
    "  });",
    '  registerApplication("spa-reports", () => window.System.import("spa-reports"), "/reports");',
    "  start();",
    "}",
    "",
  ].join("\n");
  const INDEX_HTML = [
    "<!doctype html>",
    "<html>",
    "  <head>",
    '    <script type="systemjs-importmap">',
    "      {",
    '        "imports": {',
    '          "spa-orders": "http://127.0.0.1:9001/assets/spa-orders.js",',
    '          "spa-reports": "http://127.0.0.1:9002/spa-reports.js"',
    "        }",
    "      }",
    "    </script>",
    "  </head>",
    "</html>",
    "",
  ].join("\n");
  const LIFECYCLES = 'import singleSpaReact from "single-spa-react";\nimport { Orders } from "./Orders";\nconst lifecycles = singleSpaReact({ rootComponent: Orders });\nexport const { bootstrap, mount, unmount } = lifecycles;\n';

  it("reports observed registrations and infers the root configuration with its reasoning", async () => {
    const { document } = await profile({ "src/root-config.ts": ROOT_CONFIG, "src/index.html": INDEX_HTML });
    expect(fact(document, "composition", "single-spa:application:spa-orders")).toMatchObject({ state: "observed", value: { mechanism: "single-spa", role: "registration", application: { kind: "literal", value: "spa-orders" } } });
    expect(fact(document, "composition", "single-spa:application:spa-reports")).toMatchObject({ state: "observed", value: { activeWhen: { kind: "literal", value: "/reports" } } });
    const root = fact(document, "composition", "single-spa:root-config");
    expect(root).toMatchObject({ state: "inferred", reasoning: expect.stringContaining("registers single-spa applications and starts single-spa") });
    expect(cited(document, "composition", "single-spa:root-config")).toEqual(["src/root-config.ts:11", "src/root-config.ts:12", "src/root-config.ts:6"]);
    // Comments and strings never produce registrations.
    expect(facts(document, "composition").map((item) => item.key).filter((key) => key.includes("commented-out") || key.includes("in-a-string"))).toEqual([]);
    expect(references(document).filter((reference) => reference.includes("single-spa"))).toEqual([
      'composition/host {"application":"spa-orders","mechanism":"single-spa"}',
      'composition/host {"application":"spa-reports","mechanism":"single-spa"}',
    ]);
  });

  it("reports import map entries from HTML with the line each is declared on", async () => {
    const { document, reader } = await profile({ "src/index.html": INDEX_HTML });
    expect(fact(document, "composition", "import-map:spa-orders")).toMatchObject({ state: "observed", value: { mechanism: "import-map", specifier: "spa-orders", url: "http://127.0.0.1:9001/assets/spa-orders.js", source: "src/index.html" } });
    const [id] = fact(document, "composition", "import-map:spa-reports").evidence;
    expect(await resolveEvidence(reader, document.evidence[id!]!)).toMatchObject({ ok: true, excerpt: '          "spa-reports": "http://127.0.0.1:9002/spa-reports.js"' });
    expect(references(document)).toContain('composition/host {"mechanism":"import-map","specifier":"spa-orders"}');
  });

  it("reads an Angular component template for import maps, though the UI categories skip it", async () => {
    const { document } = await profile({ "package.json": json({ name: "app" }), "src/app/orders.component.html": "<table></table>\n" });
    expect(document.categories.composition!.search).toMatchObject({ surface: ["src/app/orders.component.html"], skipped: [] });
    expect(document.categories.ui_elements!.search.skipped).toEqual(["src/app/orders.component.html"]);
  });

  it("infers an application from single-spa lifecycles, whether from a helper or exported by hand", async () => {
    for (const files of [{ "src/lifecycles.tsx": LIFECYCLES }, { "src/lifecycles.js": "export async function bootstrap() {}\nexport async function mount() {}\nexport async function unmount() {}\n" }]) {
      const { document } = await profile(files);
      expect(fact(document, "composition", "single-spa:application")).toMatchObject({ state: "inferred", value: { mechanism: "single-spa", role: "application" }, reasoning: expect.stringContaining("lifecycles") });
      expect(facts(document, "composition").some((item) => item.key === "single-spa:root-config")).toBe(false);
    }
  });

  it("records an unparsable import map as a skipped input", async () => {
    const { document } = await profile({ "index.html": '<script type="importmap">{ "imports": { broken </script>\n' });
    expect(document.diagnostics).toContainEqual(expect.objectContaining({ path: "index.html", reason: "parse_failed" }));
    expect(document.categories.composition!.search.skipped).toContain("index.html");
  });

  it("ignores import maps inside HTML comments without shifting line numbers", () => {
    const blocks = htmlImportMaps('<!-- <script type="importmap">{"imports":{"ghost":"x"}}</script>\n -->\n<script type="importmap">\n{"imports":{}}\n</script>');
    expect(blocks.map((block) => [block.line, block.json.trim()])).toEqual([[3, '{"imports":{}}']]);
  });

  it("finds import-map blocks of both types", () => {
    expect(htmlImportMaps('<script type="importmap">{"imports":{}}</script>\n<script type=\'systemjs-importmap\'>\n{}\n</script>').map((block) => block.line)).toEqual([1, 2]);
  });
});

describe("Module Federation", () => {
  const MF_SHELL = [
    'const path = require("node:path");',
    'const { ModuleFederationPlugin } = require("webpack").container;',
    "module.exports = {",
    "  plugins: [",
    "    new ModuleFederationPlugin({",
    '      name: "mfShell",',
    "      remotes: {",
    '        mfAdmin: "mfAdmin@http://127.0.0.1:9101/remoteEntry.js",',
    "        mfBilling: 'promise import(\"http://127.0.0.1:9102/assets/remoteEntry.js\")',",
    "      },",
    '      shared: { react: { singleton: true }, "react-dom": { singleton: true } },',
    "    }),",
    "  ],",
    "};",
    "",
  ].join("\n");
  const MF_ADMIN = 'const rspack = require("@rspack/core");\nmodule.exports = { plugins: [new rspack.container.ModuleFederationPluginV1({ name: "mfAdmin", filename: "remoteEntry.js", exposes: { "./Admin": "./src/Admin.tsx" }, shared: ["react"] })] };\n';
  const MF_BILLING = 'import federation from "@originjs/vite-plugin-federation";\nimport { defineConfig } from "vite";\nexport default defineConfig({ plugins: [federation({ name: "mfBilling", filename: "remoteEntry.js", exposes: { "./mount": "./src/mount.tsx" } })] });\n';

  it("reports a host's remotes and shared modules, leaving a remote loaded by code unresolved", async () => {
    const { document } = await profile({ "webpack.config.cjs": MF_SHELL });
    expect(fact(document, "composition", "module-federation:mfShell")).toMatchObject({
      state: "observed",
      value: {
        mechanism: "module-federation",
        plugin: "architecture.module-federation.webpack",
        name: { kind: "literal", value: "mfShell" },
        remotes: [
          { alias: "mfAdmin", federation_name: "mfAdmin", entry: { kind: "literal", value: "http://127.0.0.1:9101/remoteEntry.js" } },
          { alias: "mfBilling", federation_name: null, entry: { kind: "unresolved", reason: "computed", detail: "The remote is loaded by code" } },
        ],
        exposes: [],
        shared: ["react", "react-dom"],
      },
    });
    expect(references(document)).toEqual(['composition/host {"mechanism":"module-federation","name":"mfAdmin"}']);
  });

  it("reports exposed modules from Rspack and Vite remotes", async () => {
    const { document } = await profile({ "rspack.config.cjs": MF_ADMIN, "vite.config.ts": MF_BILLING });
    expect(fact(document, "composition", "module-federation:mfAdmin").value).toMatchObject({ plugin: "architecture.module-federation.rspack", exposes: ["./Admin"], shared: ["react"] });
    expect(fact(document, "composition", "module-federation:mfBilling").value).toMatchObject({ plugin: "architecture.module-federation.vite", exposes: ["./mount"] });
    expect(references(document)).toEqual(['composition/remote {"mechanism":"module-federation","name":"mfAdmin"}', 'composition/remote {"mechanism":"module-federation","name":"mfBilling"}']);
  });

  it("names the package and API each build's plugin came from, which tell the federation generations apart", async () => {
    const { document } = await profile({ "webpack.config.cjs": MF_SHELL, "rspack.config.cjs": MF_ADMIN, "vite.config.ts": MF_BILLING });
    expect(fact(document, "composition", "module-federation:mfShell").value).toMatchObject({ package: "webpack", api: "ModuleFederationPlugin" });
    expect(fact(document, "composition", "module-federation:mfAdmin").value).toMatchObject({ package: "@rspack/core", api: "ModuleFederationPluginV1" });
    expect(fact(document, "composition", "module-federation:mfBilling").value).toMatchObject({ package: "@originjs/vite-plugin-federation", api: null });
  });

  it("reports Module Federation 2 from the Next.js and Rsbuild plugins, a shared configuration, and the runtime", async () => {
    const { document } = await profile({
      "next.config.js": 'const { NextFederationPlugin } = require("@module-federation/nextjs-mf");\nmodule.exports = { webpack(config) { config.plugins.push(new NextFederationPlugin({ name: "checkout", exposes: { "./Cart": "./components/Cart" } })); return config; } };\n',
      "rsbuild.config.ts": 'import { pluginModuleFederation } from "@module-federation/rsbuild-plugin";\nexport default { plugins: [pluginModuleFederation({ name: "catalog", exposes: { "./List": "./src/List.tsx" }, shared: ["react"] })] };\n',
      "module-federation.config.ts": 'import { createModuleFederationConfig } from "@module-federation/enhanced";\nexport default createModuleFederationConfig({ name: "account", exposes: { "./Profile": "./src/Profile.tsx" } });\n',
      "src/remotes.ts": 'import { init } from "@module-federation/enhanced/runtime";\ninit({ name: "portal", remotes: [{ name: "reports", entry: "https://cdn.example.test/reports/mf-manifest.json" }] });\n',
    });
    expect(fact(document, "composition", "module-federation:checkout").value).toMatchObject({ plugin: "architecture.module-federation.nextjs", package: "@module-federation/nextjs-mf", exposes: ["./Cart"] });
    expect(fact(document, "composition", "module-federation:catalog").value).toMatchObject({ plugin: "architecture.module-federation.rsbuild", package: "@module-federation/rsbuild-plugin", exposes: ["./List"], shared: ["react"] });
    expect(fact(document, "composition", "module-federation:account").value).toMatchObject({ plugin: "architecture.module-federation.config", package: "@module-federation/enhanced", exposes: ["./Profile"] });
    expect(fact(document, "composition", "module-federation:portal").value).toMatchObject({
      plugin: "architecture.module-federation.runtime",
      package: "@module-federation/enhanced/runtime",
      remotes: [{ federation_name: "reports", entry: { kind: "literal", value: "https://cdn.example.test/reports/mf-manifest.json" } }],
      exposes: [],
    });
    expect(references(document)).toContain('composition/host {"mechanism":"module-federation","name":"reports"}');
  });

  it("reports Re.Pack's Module Federation 2 plugin with its package and API, in the shape of a webpack Module Federation 2 build", async () => {
    const repack = [
      'import * as Repack from "@callstack/repack";',
      "export default {",
      "  plugins: [",
      "    new Repack.RepackPlugin(),",
      '    new Repack.plugins.ModuleFederationPluginV2({ name: "host", remotes: { mini: "mini@http://localhost:9000/mini.container.js.bundle" }, shared: { react: { singleton: true, eager: true }, "react-native": { singleton: true, eager: true } } }),',
      "  ],",
      "};",
      "",
    ].join("\n");
    const plugins = 'import { ModuleFederationPluginV2 } from "@callstack/repack/plugins";\nexport default { plugins: [new ModuleFederationPluginV2({ name: "mini", exposes: { "./Screen": "./src/Screen.tsx" } })] };\n';
    const enhanced = 'const { ModuleFederationPlugin } = require("@module-federation/enhanced/webpack");\nmodule.exports = { plugins: [new ModuleFederationPlugin({ name: "web", remotes: { mini: "mini@http://localhost:9000/remoteEntry.js" }, shared: { react: { singleton: true } } })] };\n';
    const { document } = await profile({ "app/rspack.config.mjs": repack, "mini/rspack.config.mjs": plugins, "web/webpack.config.cjs": enhanced });
    const host = fact(document, "composition", "module-federation:host").value as Record<string, unknown>;
    expect(host).toEqual({
      mechanism: "module-federation",
      plugin: "architecture.module-federation.repack",
      package: "@callstack/repack",
      api: "ModuleFederationPluginV2",
      name: { kind: "literal", value: "host" },
      remotes: [{ alias: "mini", federation_name: "mini", entry: { kind: "literal", value: "http://localhost:9000/mini.container.js.bundle" } }],
      exposes: [],
      shared: ["react", "react-native"],
    });
    expect(fact(document, "composition", "module-federation:mini").value).toMatchObject({ plugin: "architecture.module-federation.repack-plugins", package: "@callstack/repack/plugins", api: "ModuleFederationPluginV2", exposes: ["./Screen"] });
    // The same fields, of the same kinds, as a webpack build with the Module Federation 2 plugin, whose rule names no API.
    const web = fact(document, "composition", "module-federation:web").value as Record<string, unknown>;
    const shape = (value: Record<string, unknown>) => Object.fromEntries(Object.entries(value).map(([key, item]) => [key, key === "api" ? "string or null" : Array.isArray(item) ? "array" : item === null ? "null" : typeof item]));
    expect(shape(host)).toEqual(shape(web));
    expect(web).toMatchObject({ package: "@module-federation/enhanced/webpack", api: null, remotes: [{ alias: "mini", federation_name: "mini" }], shared: ["react"] });
    expect(references(document)).toEqual(expect.arrayContaining(['composition/host {"mechanism":"module-federation","name":"mini"}', 'composition/remote {"mechanism":"module-federation","name":"mini"}']));
  });

  it("reports Native Federation remotes and hosts, with the manifest a host loads", async () => {
    const { document } = await profile({
      "mfe1/federation.config.js": 'const { withNativeFederation, shareAll } = require("@angular-architects/native-federation/config");\nmodule.exports = withNativeFederation({ name: "mfe1", exposes: { "./Component": "./src/app/app.component.ts" }, shared: { ...shareAll({ singleton: true }) } });\n',
      "shell/src/main.ts": 'import { initFederation } from "@angular-architects/native-federation";\ninitFederation("federation.manifest.json").then(() => import("./bootstrap"));\n',
      "portal/src/main.ts": 'import { initFederation } from "@softarc/native-federation";\ninitFederation({ mfe1: "http://localhost:4201/remoteEntry.json" });\n',
    });
    expect(fact(document, "composition", "native-federation:mfe1").value).toMatchObject({ mechanism: "native-federation", plugin: "architecture.native-federation.config", name: { kind: "literal", value: "mfe1" }, exposes: ["./Component"] });
    expect(fact(document, "composition", "native-federation:shell/src/main.ts:2").value).toMatchObject({ mechanism: "native-federation", plugin: "architecture.native-federation.host", manifest: "federation.manifest.json", remotes: [] });
    expect(fact(document, "composition", "native-federation:portal/src/main.ts:2").value).toMatchObject({ remotes: [{ alias: "mfe1", entry: { kind: "literal", value: "http://localhost:4201/remoteEntry.json" } }] });
    expect(references(document)).toEqual(expect.arrayContaining(['composition/host {"mechanism":"native-federation","name":"mfe1"}', 'composition/remote {"mechanism":"native-federation","name":"mfe1"}']));
  });

  it("reports computed configuration as unresolved, keyed by its location", async () => {
    const { document } = await profile({ "webpack.config.js": 'const webpack = require("webpack");\nmodule.exports = { plugins: [new webpack.container.ModuleFederationPlugin(makeConfig())] };\n' });
    expect(fact(document, "composition", "module-federation:webpack.config.js:2")).toMatchObject({
      value: { name: { kind: "unresolved", reason: "computed" }, remotes: { kind: "unresolved", reason: "computed" } },
    });
  });

  it("never reports federation written in a comment or string", async () => {
    const { document } = await profile({ "webpack.config.js": '// new ModuleFederationPlugin({ name: "ghost" })\nconst s = "new webpack.container.ModuleFederationPlugin({})";\n' });
    expect(facts(document, "composition")).toEqual([]);
  });
});

describe("embedded frames and window messaging", () => {
  const APP = 'export function Frame() {\n  return <iframe src="http://127.0.0.1:9103" title="Legacy servicing" />;\n}\nexport const Dynamic = () => <iframe src={frameUrl()} />;\n';
  const RUNTIME = [
    'const SHELL_ORIGIN = "http://127.0.0.1:9100";',
    "export function send(type, payload) {",
    '  window.parent.postMessage({ source: "legacy-portal", type, payload }, SHELL_ORIGIN);',
    "}",
    'window.addEventListener("message", (event) => {});',
    'document.addEventListener("keydown", () => {});',
    "export const broadcast = (origin) => window.parent.postMessage({ type: 'ping' }, origin);",
    "",
  ].join("\n");

  it("reports literal iframe sources and references, and leaves computed ones unresolved", async () => {
    const { document } = await profile({ "src/App.tsx": APP });
    expect(fact(document, "composition", "iframe:http://127.0.0.1:9103")).toMatchObject({ state: "observed", value: { mechanism: "iframe", src: { kind: "literal", value: "http://127.0.0.1:9103" } } });
    expect(fact(document, "composition", "src/App.tsx:4")).toMatchObject({ value: { src: { kind: "unresolved", reason: "computed" } } });
    expect(references(document)).toEqual(['iframe/embedder {"url":"http://127.0.0.1:9103"}']);
    expect(document.diagnostics).toContainEqual(expect.objectContaining({ path: "src/App.tsx", reason: "unresolved_reference" }));
  });

  it("reports messages sent to literal origins and message listeners, and leaves computed origins unresolved", async () => {
    const { document } = await profile({ "src/runtime.js": RUNTIME });
    expect(fact(document, "runtime_integrations", "postMessage:send:http://127.0.0.1:9100")).toMatchObject({ state: "observed", value: { contract: "postMessage", direction: "send", targetOrigin: { kind: "literal", value: "http://127.0.0.1:9100" } } });
    expect(fact(document, "runtime_integrations", "postMessage:receive")).toMatchObject({ value: { contract: "postMessage", direction: "receive" } });
    expect(cited(document, "runtime_integrations", "postMessage:receive")).toEqual(["src/runtime.js:5"]);
    expect(fact(document, "runtime_integrations", "src/runtime.js:7")).toMatchObject({ value: { targetOrigin: { kind: "unresolved", reason: "parameter" } } });
    expect(references(document)).toEqual(['runtime_contract/caller {"contract":"postMessage","origin":"http://127.0.0.1:9100"}']);
  });
});
