import { type Budgets, type Detector, runDetectors } from "@repo-facts/contract";
import { describe, expect, it } from "vitest";
import { INVENTORY, type Inventory, classifyPath, inventoryDetector, languageOf, readableInputs, unanalyzedInputs } from "../src/index.js";
import { type FileTree, snapshotOf } from "./support.js";

const GENEROUS: Budgets = { maxBlobBytes: 1_000_000, maxLockfileBytes: 1_000_000, maxFiles: 1_000, maxTotalBytes: 10_000_000 };

const REPOSITORY: FileTree = {
  "package.json": '{ "name": "orders-ui" }\n',
  "package-lock.json": '{ "lockfileVersion": 3, "packages": {} }\n',
  "packages/ui/package.json": '{ "name": "@acme/ui" }\n',
  "pnpm-workspace.yaml": "packages:\n  - packages/*\n",
  "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
  "yarn.lock": "# yarn lockfile v1\n",
  ".github/workflows/ci.yml": "on: push\njobs: {}\n",
  ".gitlab-ci.yml": "test:\n  script: npm test\n",
  Jenkinsfile: "pipeline {}\n",
  Makefile: "test:\n\tnpm test\n",
  "scripts/verify.sh": { content: "#!/bin/sh\nnpm test\n", executable: true },
  ".nvmrc": "20\n",
  ".node-version": "20.11.1\n",
  Dockerfile: "FROM node:20-alpine\n",
  "tsconfig.json": "{}\n",
  "vite.config.ts": "export default {};\n",
  "src/api/openapi.yaml": "openapi: 3.0.0\n",
  "src/schema.graphql": "type Query { orders: [String] }\n",
  "src/index.tsx": "export const App = () => null;\n",
  "src/util.ts": "export {};\n",
  "src/legacy.js": "module.exports = {};\n",
  "src/styles.css": "body {}\n",
  "src/App.module.css": ".app {}\n",
  "README.md": "# Orders\n",
  "src/theme.scss": "$accent: red;\n",
  "src/old.less": "@accent: red;\n",
  // Recognized, but not analyzed by this release.
  "bun.lockb": Buffer.from([0x00, 0x01, 0x02]),
  ".circleci/config.yml": "version: 2.1\n",
  "azure-pipelines.yml": "trigger: [main]\n",
  "src/legacy.sass": "body\n  margin: 0\n",
  // Never read.
  ".npmrc": "//registry.example.test/:_authToken=secret-value\n",
  ".env.production": "API_TOKEN=secret-value\n",
  // Vendored code is not the repository's own input.
  "node_modules/left-pad/package.json": '{ "name": "left-pad" }\n',
  "node_modules/left-pad/index.js": "module.exports = 1;\n",
  "node_modules/@salt-ds/theme/index.css": ":root {}\n",
};

describe("inventory", () => {
  /** Runs the inventory and a probe that captures the shared inventory. */
  const inventoryRun = async (files: FileTree, budgets: Budgets = GENEROUS) => {
    const reader = snapshotOf(files, budgets);
    let shared: Inventory | undefined;
    let readable: string[] = [];
    let unanalyzed: string[] = [];
    const probe: Detector = {
      id: "probe",
      version: "1",
      stage: "parse",
      inputs: [],
      categories: [],
      async run(context) {
        shared = context.shared.get(INVENTORY) as Inventory;
        readable = readableInputs(context, "package-json", "npm-lock", "pnpm-lock", "yarn-lock", "github-actions", "circleci", "bun-lock").map((input) => input.path);
        unanalyzed = unanalyzedInputs(context, "package-json", "npm-lock", "pnpm-lock", "yarn-lock", "github-actions", "circleci", "bun-lock").map((input) => input.path);
      },
    };
    const document = await runDetectors({ reader, detectorRelease: "0.1.0", detectors: [inventoryDetector, probe] });
    return { document, inventory: shared!, readable, unanalyzed, reader };
  };

  it("classifies supported, unsupported, and sensitive inputs by path", async () => {
    const { inventory } = await inventoryRun(REPOSITORY);
    const byPath = Object.fromEntries(inventory.inputs.map((input) => [input.path, [input.kind, input.format, input.supported, input.readable]]));
    expect(byPath).toEqual({
      ".circleci/config.yml": ["ci", "circleci", false, null],
      ".env.production": ["sensitive", "sensitive", false, null],
      ".github/workflows/ci.yml": ["ci", "github-actions", true, true],
      ".gitlab-ci.yml": ["ci", "gitlab-ci", true, true],
      ".node-version": ["runtime", "node-version", true, true],
      ".npmrc": ["sensitive", "sensitive", false, null],
      ".nvmrc": ["runtime", "nvmrc", true, true],
      Dockerfile: ["runtime", "dockerfile", true, true],
      Jenkinsfile: ["ci", "jenkinsfile", true, true],
      Makefile: ["verification", "makefile", true, true],
      "azure-pipelines.yml": ["ci", "azure-pipelines", false, null],
      "bun.lockb": ["lockfile", "bun-lock", false, null],
      "package-lock.json": ["lockfile", "npm-lock", true, true],
      "package.json": ["manifest", "package-json", true, true],
      "packages/ui/package.json": ["manifest", "package-json", true, true],
      "pnpm-lock.yaml": ["lockfile", "pnpm-lock", true, true],
      "pnpm-workspace.yaml": ["workspace", "pnpm-workspace", true, true],
      "scripts/verify.sh": ["verification", "shell", true, null],
      "src/App.module.css": ["stylesheet", "css-module", true, true],
      "src/api/openapi.yaml": ["contract", "openapi", true, true],
      "src/legacy.sass": ["stylesheet", "sass", false, null],
      "src/old.less": ["stylesheet", "less", true, true],
      "src/schema.graphql": ["contract", "graphql-schema", true, true],
      "src/styles.css": ["stylesheet", "css", true, true],
      "src/theme.scss": ["stylesheet", "scss", true, true],
      "tsconfig.json": ["config", "tsconfig", true, true],
      "vite.config.ts": ["config", "vite-config", true, true],
      "yarn.lock": ["lockfile", "yarn-lock", true, true],
    });
    expect(inventory.sources).toEqual(["src/index.tsx", "src/legacy.js", "src/util.ts", "vite.config.ts"]);
    expect(inventory.executables).toEqual(["scripts/verify.sh"]);
  });

  it("reports unsupported inputs so dependent categories stay unknown, and never reads sensitive ones", async () => {
    const { document, reader, readable, unanalyzed } = await inventoryRun(REPOSITORY);
    const unsupported = document.diagnostics.filter((diagnostic) => diagnostic.reason === "unsupported_input").map((diagnostic) => diagnostic.path);
    expect(unsupported).toEqual([".circleci/config.yml", "azure-pipelines.yml", "bun.lockb", "src/legacy.sass"]);
    expect(unanalyzed).toEqual([".circleci/config.yml", "bun.lockb"]);
    expect(readable).toEqual([".github/workflows/ci.yml", "package-lock.json", "package.json", "packages/ui/package.json", "pnpm-lock.yaml", "yarn.lock"]);
    expect(document.diagnostics.map((diagnostic) => diagnostic.path)).not.toContain(".npmrc");
    expect(reader.diagnostics().map((diagnostic) => diagnostic.path)).not.toContain(".npmrc");
    expect(JSON.stringify(document)).not.toContain("secret-value");
  });

  it("exposes CSS, SCSS, Less, and their modules as stylesheets, and reports Sass's indented syntax as unsupported", async () => {
    const { document, inventory } = await inventoryRun({ ...REPOSITORY, "src/Card.module.scss": ".card {}\n", "src/Nav.module.less": ".nav {}\n" });
    const stylesheets = inventory.inputs.filter((input) => input.kind === "stylesheet").map((input) => [input.path, input.format, input.supported]);
    expect(stylesheets).toEqual([
      ["src/App.module.css", "css-module", true],
      ["src/Card.module.scss", "scss-module", true],
      ["src/Nav.module.less", "less-module", true],
      ["src/legacy.sass", "sass", false],
      ["src/old.less", "less", true],
      ["src/styles.css", "css", true],
      ["src/theme.scss", "scss", true],
    ]);
    const diagnostics = document.diagnostics.filter((diagnostic) => diagnostic.path.startsWith("src/") && diagnostic.reason === "unsupported_input");
    expect(diagnostics.map(({ path, detail }) => [path, detail])).toEqual([
      ["src/legacy.sass", "Sass stylesheet (indented syntax) is recognized but not analyzed by this detector release"],
    ]);
    // Vendored stylesheets, such as an installed theme, are not the repository's own.
    expect(inventory.inputs.map((input) => input.path)).not.toContain("node_modules/@salt-ds/theme/index.css");
  });

  it("reports language distribution from the tree listing, excluding vendored code", async () => {
    const { document } = await inventoryRun(REPOSITORY);
    const languages = document.categories.languages!;
    expect(languages.state).toBe("observed");
    const tally = (...paths: string[]) => ({ files: paths.length, bytes: paths.reduce((sum, path) => sum + sizeOf(REPOSITORY[path]!), 0) });
    expect(Object.fromEntries(languages.facts.map((fact) => [fact.key, fact.value]))).toEqual({
      CSS: tally("src/styles.css", "src/App.module.css"),
      Dockerfile: tally("Dockerfile"),
      GraphQL: tally("src/schema.graphql"),
      Groovy: tally("Jenkinsfile"),
      JSON: tally("package.json", "package-lock.json", "packages/ui/package.json", "tsconfig.json"),
      JavaScript: tally("src/legacy.js"),
      Less: tally("src/old.less"),
      Markdown: tally("README.md"),
      Sass: tally("src/theme.scss", "src/legacy.sass"),
      Shell: tally("scripts/verify.sh"),
      TypeScript: tally("src/index.tsx", "src/util.ts", "vite.config.ts"),
      YAML: tally("pnpm-workspace.yaml", "pnpm-lock.yaml", ".github/workflows/ci.yml", ".gitlab-ci.yml", "src/api/openapi.yaml", ".circleci/config.yml", "azure-pipelines.yml"),
    });
    const typescript = languages.facts.find((fact) => fact.key === "TypeScript")!;
    expect(typescript.evidence.map((id) => document.evidence[id]!.path).sort()).toEqual(["src/index.tsx", "src/util.ts", "vite.config.ts"]);
    expect(typescript.evidence.map((id) => document.evidence[id]!.location)).toEqual([{ kind: "entry" }, { kind: "entry" }, { kind: "entry" }]);
  });

  it("leaves minified bundles, Yarn's committed release, and Go vendor directories out, like node_modules", async () => {
    const { inventory, document } = await inventoryRun({
      "package.json": '{ "name": "router" }\n',
      "src/main.js": "export {};\n",
      "public/js/jquery.min.js": "!function(){var i=1;var i=2}();\n",
      "public/css/bootstrap.min.css": "body{margin:0}\n",
      "lib/loader.min.mjs": "export{};\n",
      ".yarn/releases/yarn-4.5.0.cjs": "module.exports={};\n",
      ".yarn/sdks/typescript/package.json": '{ "name": "typescript" }\n',
      ".pnp.cjs": "module.exports={};\n",
      "go.mod": "module github.com/alphagov/router\n",
      "vendor/modules.txt": "# github.com/prometheus/client_golang v1.20.5\n",
      "vendor/github.com/prometheus/client_golang/prometheus/counter.go": "package prometheus\n",
      "tools/vendor/modules.txt": "# example.com/tool v1.0.0\n",
      "tools/vendor/example.com/tool/main.go": "package tool\n",
      // A directory merely named vendor may hold the repository's own code.
      "assets/vendor/handlebars.runtime.js": "export default {};\n",
    });
    expect(inventory.sources).toEqual(["assets/vendor/handlebars.runtime.js", "src/main.js"]);
    expect(inventory.vendorDirectories).toEqual(["tools/vendor", "vendor"]);
    expect(inventory.inputs.map((input) => input.path)).toEqual(["go.mod", "package.json"]);
    expect(Object.fromEntries(document.categories.languages!.facts.map((fact) => [fact.key, (fact.value as { files: number }).files]))).toEqual({ JSON: 1, JavaScript: 2 });
    expect(document.inventory.files).toBe(14);
  });

  it("keys languages by extension, and files without one by name", () => {
    expect(
      Object.fromEntries(
        ["app/Main.scala", "build.sbt", "src/core.cljs", "src/core.clj", "deps.edn", "db/schema.sql", "native/lib.h", "native/lib.hpp", "build.gradle", "Sources/App.swift", "lib/main.dart", "lib/app.ex", "script.pl", "init.lua", "analysis.R", "ios/AppDelegate.m", "schema.cue", "main.tf", "config.hcl", "Dockerfile", "web.Dockerfile", "Gemfile", "README"].map((path) => [path, languageOf(path)]),
      ),
    ).toEqual({
      "app/Main.scala": "Scala",
      "build.sbt": "Scala",
      "src/core.cljs": "ClojureScript",
      "src/core.clj": "Clojure",
      "deps.edn": "Clojure",
      "db/schema.sql": "SQL",
      "native/lib.h": "C",
      "native/lib.hpp": "C++",
      "build.gradle": "Groovy",
      "Sources/App.swift": "Swift",
      "lib/main.dart": "Dart",
      "lib/app.ex": "Elixir",
      "script.pl": "Perl",
      "init.lua": "Lua",
      "analysis.R": "R",
      "ios/AppDelegate.m": "Objective-C",
      "schema.cue": "CUE",
      "main.tf": "Terraform",
      "config.hcl": "HCL",
      Dockerfile: "Dockerfile",
      "web.Dockerfile": "Dockerfile",
      Gemfile: "Ruby",
      README: null,
    });
  });

  it("reports an empty repository's languages and submodules as absent after a complete listing", async () => {
    const { document } = await inventoryRun({ LICENSE: "MIT\n" });
    expect(document.categories.languages).toMatchObject({ state: "absent", facts: [], search: { complete: true, rules: ["inventory.language-by-extension"] } });
    expect(document.categories.submodules).toMatchObject({ state: "absent", facts: [] });
  });

  it("records submodules as metadata without fetching them", async () => {
    const { document, inventory } = await inventoryRun({ "README.md": "hello\n", "vendor/design-system": { gitlink: "2222222222222222222222222222222222222222" } });
    expect(inventory.gitlinks).toEqual(["vendor/design-system"]);
    expect(document.categories.submodules!.facts).toEqual([
      expect.objectContaining({ key: "vendor/design-system", state: "observed", value: { path: "vendor/design-system", commit: "2222222222222222222222222222222222222222" }, rule: "inventory.gitlink" }),
    ]);
  });

  it("marks binary and over-budget inputs unreadable, and symbolic links as never followed", async () => {
    const { inventory, document, readable, unanalyzed } = await inventoryRun(
      {
        "package.json": Buffer.from([0x7b, 0x00, 0x7d]),
        "package-lock.json": `{ "padding": "${"x".repeat(2_000)}" }\n`,
        "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
        "yarn.lock": { symlink: "../outside/yarn.lock" },
      },
      { maxBlobBytes: 1_000, maxLockfileBytes: 1_000, maxFiles: 100, maxTotalBytes: 100_000 },
    );
    expect(Object.fromEntries(inventory.inputs.map((input) => [input.path, input.readable]))).toEqual({
      "package-lock.json": false,
      "package.json": false,
      "pnpm-lock.yaml": true,
      "yarn.lock": false,
    });
    expect(readable).toEqual(["pnpm-lock.yaml"]);
    expect(unanalyzed).toEqual(["package-lock.json", "package.json", "yarn.lock"]);
    expect(document.diagnostics.map(({ path, reason }) => [path, reason])).toEqual([
      ["package-lock.json", "blob_too_large"],
      ["package.json", "binary"],
      ["yarn.lock", "symlink"],
    ]);
  });

  it("reads the most decisive inputs first when the file budget runs out", async () => {
    const files: FileTree = {
      // Sources and configuration sort before the manifests in path order.
      "a/src/index.ts": "export {};\n",
      "a/src/App.test.ts": "export {};\n",
      "a/tsconfig.json": "{}\n",
      "a/vite.config.ts": "export default {};\n",
      "app/main.ts": "export {};\n",
      "app/deep/nested/feature/widget.ts": "export {};\n",
      "app/__tests__/main.test.ts": "export {};\n",
      ".github/workflows/ci.yml": "on: push\njobs: {}\n",
      "eslint.config.js": "export default [];\n",
      "package.json": '{ "name": "root", "workspaces": ["packages/*"] }\n',
      "package-lock.json": '{ "lockfileVersion": 3, "packages": {} }\n',
      "packages/ui/package.json": '{ "name": "ui" }\n',
      "packages/ui/src/deep/package.json": '{ "name": "fixture" }\n',
      "zz/package.json": '{ "name": "zz" }\n',
    };
    const readOrder = async (maxFiles: number) => {
      const { reader } = await inventoryRun(files, { ...GENEROUS, maxFiles });
      return Object.keys(files)
        .filter((path) => !reader.diagnostics().some((skip) => skip.path === path))
        .sort();
    };

    // Manifests and lockfiles, shallowest first, before anything else.
    expect(await readOrder(4)).toEqual(["package-lock.json", "package.json", "packages/ui/package.json", "zz/package.json"]);
    expect(await readOrder(5)).toEqual(["package-lock.json", "package.json", "packages/ui/package.json", "packages/ui/src/deep/package.json", "zz/package.json"]);
    // Then CI, then configuration, shallowest first.
    expect(await readOrder(7)).toEqual([".github/workflows/ci.yml", "eslint.config.js", "package-lock.json", "package.json", "packages/ui/package.json", "packages/ui/src/deep/package.json", "zz/package.json"]);
    // Then sources: shallow application code and entry points before tests and deep paths.
    const withSources = await readOrder(11);
    expect(withSources.filter((path) => path.endsWith(".ts") && !path.includes("config"))).toEqual(["a/src/index.ts", "app/main.ts"]);
    const { reader } = await inventoryRun(files, { ...GENEROUS, maxFiles: 11 });
    expect(reader.diagnostics().map(({ path, reason }) => [path, reason])).toEqual([
      ["a/src/App.test.ts", "file_budget_exhausted"],
      ["app/__tests__/main.test.ts", "file_budget_exhausted"],
      ["app/deep/nested/feature/widget.ts", "file_budget_exhausted"],
    ]);
  });

  it("spends the file budget in path order, so the same tree always skips the same inputs", async () => {
    const files: FileTree = { "a/package.json": "{}\n", "b/package.json": "{}\n", "c/package.json": "{}\n", "src/app.ts": "export {};\n" };
    const first = await inventoryRun(files, { maxBlobBytes: 1_000, maxLockfileBytes: 1_000, maxFiles: 2, maxTotalBytes: 100_000 });
    expect(first.readable).toEqual(["a/package.json", "b/package.json"]);
    expect(first.unanalyzed).toEqual(["c/package.json"]);
    expect(first.document.diagnostics).toContainEqual(expect.objectContaining({ path: "c/package.json", reason: "file_budget_exhausted" }));
  });
});

function sizeOf(content: FileTree[string]): number {
  if (typeof content === "string" || Buffer.isBuffer(content)) return Buffer.byteLength(content);
  return "content" in content ? Buffer.byteLength(content.content) : 0;
}

describe("path classification", () => {
  it.each([
    ["package.json", "package-json"],
    ["apps/web/package.json", "package-json"],
    ["npm-shrinkwrap.json", "npm-lock"],
    [".github/workflows/release.yaml", "github-actions"],
    [".github/workflows/nested/ci.yml", null],
    [".github/actions/setup/action.yml", null],
    ["ci/.gitlab-ci.yml", null],
    ["tsconfig.build.json", "tsconfig"],
    ["jsconfig.json", "tsconfig"],
    ["webpack.config.mjs", "webpack-config"],
    ["module-federation.config.ts", "module-federation-config"],
    ["vite.config.json", null],
    [".eslintrc.cjs", "eslint-config"],
    ["api/orders.openapi.json", "openapi"],
    ["swagger.yml", "openapi"],
    ["deploy/web.Dockerfile", "dockerfile"],
    ["node_modules/react/package.json", null],
    ["src/.env.local", "sensitive"],
    ["src/env.ts", null],
    ["certs/ca.pem", "sensitive"],
    [".pem", null],
    ["src/global.css", "css"],
    ["src/Theme.CSS", "css"],
    ["src/Button.module.css", "css-module"],
    ["src/module.css", "css"],
    ["src/theme.scss", "scss"],
    ["src/_mixins.sass", "sass"],
    ["src/theme.less", "less"],
    [".css", null],
    ["node_modules/@salt-ds/theme/index.css", null],
    ["web/bower_components/legacy/site.scss", null],
  ])("%s is %s", (path, format) => {
    expect(classifyPath(path)?.format ?? null).toBe(format);
  });

  it.each([
    ["src/app.tsx", "TypeScript"],
    ["types/index.d.ts", "TypeScript"],
    ["lib/index.cjs", "JavaScript"],
    ["styles/site.SCSS", "Sass"],
    ["Makefile", null],
    [".eslintrc", null],
    ["image.png", null],
  ])("%s is written in %s", (path, language) => {
    expect(languageOf(path)).toBe(language);
  });
});
