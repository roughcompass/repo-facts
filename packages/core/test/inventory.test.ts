import { type Budgets, type Detector, runDetectors } from "@repo-facts/contract";
import { describe, expect, it } from "vitest";
import { INVENTORY, type Inventory, classifyPath, inventoryDetector, languageOf, readableInputs, unanalyzedInputs } from "../src/index.js";
import { type FileTree, snapshotOf } from "./support.js";

const GENEROUS: Budgets = { maxBlobBytes: 1_000_000, maxFiles: 1_000, maxTotalBytes: 10_000_000 };

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
  "README.md": "# Orders\n",
  // Recognized, but not analyzed by this release.
  "bun.lockb": Buffer.from([0x00, 0x01, 0x02]),
  ".circleci/config.yml": "version: 2.1\n",
  "azure-pipelines.yml": "trigger: [main]\n",
  // Never read.
  ".npmrc": "//registry.example.test/:_authToken=secret-value\n",
  ".env.production": "API_TOKEN=secret-value\n",
  // Vendored code is not the repository's own input.
  "node_modules/left-pad/package.json": '{ "name": "left-pad" }\n',
  "node_modules/left-pad/index.js": "module.exports = 1;\n",
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
      Makefile: ["verification", "makefile", true, null],
      "azure-pipelines.yml": ["ci", "azure-pipelines", false, null],
      "bun.lockb": ["lockfile", "bun-lock", false, null],
      "package-lock.json": ["lockfile", "npm-lock", true, true],
      "package.json": ["manifest", "package-json", true, true],
      "packages/ui/package.json": ["manifest", "package-json", true, true],
      "pnpm-lock.yaml": ["lockfile", "pnpm-lock", true, true],
      "pnpm-workspace.yaml": ["workspace", "pnpm-workspace", true, true],
      "scripts/verify.sh": ["verification", "shell", true, null],
      "src/api/openapi.yaml": ["contract", "openapi", true, true],
      "src/schema.graphql": ["contract", "graphql-schema", true, true],
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
    expect(unsupported).toEqual([".circleci/config.yml", "azure-pipelines.yml", "bun.lockb"]);
    expect(unanalyzed).toEqual([".circleci/config.yml", "bun.lockb"]);
    expect(readable).toEqual([".github/workflows/ci.yml", "package-lock.json", "package.json", "packages/ui/package.json", "pnpm-lock.yaml", "yarn.lock"]);
    expect(document.diagnostics.map((diagnostic) => diagnostic.path)).not.toContain(".npmrc");
    expect(reader.diagnostics().map((diagnostic) => diagnostic.path)).not.toContain(".npmrc");
    expect(JSON.stringify(document)).not.toContain("secret-value");
  });

  it("reports language distribution from the tree listing, excluding vendored code", async () => {
    const { document } = await inventoryRun(REPOSITORY);
    const languages = document.categories.languages!;
    expect(languages.state).toBe("observed");
    const tally = (...paths: string[]) => ({ files: paths.length, bytes: paths.reduce((sum, path) => sum + sizeOf(REPOSITORY[path]!), 0) });
    expect(Object.fromEntries(languages.facts.map((fact) => [fact.key, fact.value]))).toEqual({
      CSS: tally("src/styles.css"),
      GraphQL: tally("src/schema.graphql"),
      JSON: tally("package.json", "package-lock.json", "packages/ui/package.json", "tsconfig.json"),
      JavaScript: tally("src/legacy.js"),
      Markdown: tally("README.md"),
      Shell: tally("scripts/verify.sh"),
      TypeScript: tally("src/index.tsx", "src/util.ts", "vite.config.ts"),
      YAML: tally("pnpm-workspace.yaml", "pnpm-lock.yaml", ".github/workflows/ci.yml", ".gitlab-ci.yml", "src/api/openapi.yaml", ".circleci/config.yml", "azure-pipelines.yml"),
    });
    const typescript = languages.facts.find((fact) => fact.key === "TypeScript")!;
    expect(typescript.evidence.map((id) => document.evidence[id]!.path).sort()).toEqual(["src/index.tsx", "src/util.ts", "vite.config.ts"]);
    expect(typescript.evidence.map((id) => document.evidence[id]!.location)).toEqual([{ kind: "entry" }, { kind: "entry" }, { kind: "entry" }]);
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
      { maxBlobBytes: 1_000, maxFiles: 100, maxTotalBytes: 100_000 },
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

  it("spends the file budget in path order, so the same tree always skips the same inputs", async () => {
    const files: FileTree = { "a/package.json": "{}\n", "b/package.json": "{}\n", "c/package.json": "{}\n", "src/app.ts": "export {};\n" };
    const first = await inventoryRun(files, { maxBlobBytes: 1_000, maxFiles: 2, maxTotalBytes: 100_000 });
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
