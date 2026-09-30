import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type FactDocument, resolveEvidence } from "@repo-facts/contract";
import { describe, expect, it } from "vitest";
import { commandKinds, nodeImageTag, nodeTagRange, nodeVersionRange } from "../src/index.js";
import { type FileTree, profile } from "./support.js";

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const SENTINEL = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "repo-facts-ci-")), "command-ran");

const WORKFLOW = `name: CI
on: [push]
jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node: [18, 20]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: \${{ matrix.node }}
      - run: npm ci
      - name: Unit tests
        run: npm test
      - run: ./scripts/verify.sh
      - run: touch ${SENTINEL}
`;

const REPOSITORY: FileTree = {
  "package.json": json({ name: "orders-ui", engines: { node: ">=18" }, scripts: { test: "vitest run", lint: "eslint .", "ci:check": "npm run lint && npm test", deploy: "./deploy.sh", start: "vite" } }),
  ".github/workflows/ci.yml": WORKFLOW,
  "scripts/verify.sh": { content: `#!/bin/sh\nset -eu\n# Static checks\nnpm run lint\nnpm run ci:check\ntouch ${SENTINEL}\n`, executable: true },
  Makefile: `.PHONY: test lint deploy\n\ntest:\n\t@npm test\n\nlint:\n\tnpx eslint . \\\n\t  --max-warnings 0\n\ndeploy:\n\tkubectl apply -f k8s/\n`,
};

const facts = (document: FactDocument, category: string) => document.categories[category]!.facts;
const commands = (document: FactDocument) => Object.fromEntries(facts(document, "verification_commands").map((fact) => [fact.key, fact.value as { command: string; kinds: string[]; context: Record<string, unknown> }]));
const cited = (document: FactDocument, category: string, key: string) =>
  facts(document, category)
    .find((fact) => fact.key === key)!
    .evidence.map((id) => {
      const { path: file, location } = document.evidence[id]!;
      return `${file}${location.kind === "pointer" ? `#${location.pointer}` : location.kind === "lines" ? `:${location.start}-${location.end}` : ""}`;
    })
    .sort();

describe("CI and repository conventions", () => {
  it("reports GitHub Actions run steps with step-level evidence and never runs them", async () => {
    const { document, reader } = await profile(REPOSITORY);
    const found = commands(document);
    expect(found[".github/workflows/ci.yml#test/3"]).toEqual({ source: ".github/workflows/ci.yml", context: { job: "test", step: "Unit tests" }, command: "npm test", kinds: ["test"] });
    expect(found[".github/workflows/ci.yml#test/2"]).toMatchObject({ command: "npm ci", kinds: [] });
    expect(cited(document, "verification_commands", ".github/workflows/ci.yml#test/3")).toEqual([".github/workflows/ci.yml#/jobs/test/steps/3/run"]);
    const [id] = facts(document, "verification_commands").find((fact) => fact.key === ".github/workflows/ci.yml#test/3")!.evidence;
    expect(await resolveEvidence(reader, document.evidence[id!]!)).toMatchObject({ ok: true, excerpt: '"npm test"', lines: { start: 16, end: 16 } });
    expect(facts(document, "ci_systems").map((fact) => fact.value)).toEqual([{ system: "github-actions", path: ".github/workflows/ci.yml" }]);
    expect(fs.existsSync(SENTINEL)).toBe(false);
  });

  it("follows referenced shell scripts and package scripts that CI invokes", async () => {
    const found = commands((await profile(REPOSITORY)).document);
    expect(found["scripts/verify.sh#4"]).toEqual({ source: "scripts/verify.sh", context: { script: "scripts/verify.sh", via: [".github/workflows/ci.yml#test/4"] }, command: "npm run lint", kinds: ["lint"] });
    expect(Object.keys(found).filter((key) => key.startsWith("scripts/verify.sh"))).toEqual(["scripts/verify.sh#4", "scripts/verify.sh#5", "scripts/verify.sh#6"]);
    expect(found["package.json#scripts/ci:check"]).toMatchObject({ command: "npm run lint && npm test", context: { script: "ci:check", via: ["scripts/verify.sh#5"] } });
    expect(found["package.json#scripts/test"]!.context.via).toEqual([".github/workflows/ci.yml#test/3", "Makefile#test/4"]);
    // Scripts neither named for verification nor invoked are not verification commands.
    expect(found["package.json#scripts/deploy"]).toBeUndefined();
    expect(found["package.json#scripts/start"]).toBeUndefined();
  });

  it("reports Make recipes for verification targets, joined across continuations", async () => {
    const { document } = await profile(REPOSITORY);
    const found = commands(document);
    expect(found["Makefile#test/4"]).toMatchObject({ command: "npm test", context: { target: "test" }, kinds: ["test"] });
    expect(found["Makefile#lint/7"]).toMatchObject({ command: "npx eslint . --max-warnings 0", kinds: ["lint"] });
    expect(cited(document, "verification_commands", "Makefile#lint/7")).toEqual(["Makefile:7-8"]);
    expect(Object.keys(found).some((key) => key.startsWith("Makefile#deploy"))).toBe(false);
    expect(document.categories.verification_commands!.search).toMatchObject({ complete: true, skipped: [] });
  });

  it("reads GitLab CI jobs, default scripts, and images, and marks inherited configuration incomplete", async () => {
    const { document } = await profile({
      ".gitlab-ci.yml": "image: node:20.11.1\ndefault:\n  before_script:\n    - npm ci\nstages: [test]\nunit:\n  stage: test\n  script:\n    - npm test\n    - npm run lint\n.template:\n  script: echo template\nlint:\n  extends: .template\n",
    });
    const found = commands(document);
    expect(Object.keys(found)).toEqual([".gitlab-ci.yml#.template/script/0", ".gitlab-ci.yml#default/before_script/0", ".gitlab-ci.yml#unit/script/0", ".gitlab-ci.yml#unit/script/1"]);
    expect(found[".gitlab-ci.yml#unit/script/1"]).toMatchObject({ command: "npm run lint", context: { job: "unit", section: "script" } });
    expect(document.categories.verification_commands!.search.complete).toBe(false);
    expect(facts(document, "runtime_requirements").find((fact) => fact.key === "node")).toMatchObject({ state: "observed", value: { range: "20.11.1", declared: ["20.11.1"] }, rule: "ci.gitlab.image" });
  });

  it("reads Jenkinsfile string steps and images, and never claims the search is complete", async () => {
    const { document } = await profile({
      Jenkinsfile: "pipeline {\n  agent { docker { image 'node:22-alpine' } }\n  stages {\n    stage('Test') {\n      steps {\n        sh 'npm ci'\n        sh(script: \"npm test\")\n        sh '''\n          npm run lint\n          npm run build\n        '''\n      }\n    }\n  }\n}\n",
    });
    const found = commands(document);
    expect(Object.values(found).map((command) => command.command)).toEqual(["npm ci", "npm test", "npm run lint\n          npm run build"]);
    expect(cited(document, "verification_commands", "Jenkinsfile#8")).toEqual(["Jenkinsfile:8-11"]);
    expect(document.categories.verification_commands).toMatchObject({ state: "observed", search: { complete: false } });
    expect(facts(document, "runtime_requirements")[0]).toMatchObject({ value: { range: ">=22.0.0 <23.0.0-0", declared: ["22-alpine"] } });
  });

  it("labels commands by the tools they name", () => {
    expect(commandKinds("npx playwright test")).toEqual(["e2e", "test"]);
    expect(commandKinds("tsc --noEmit && eslint .")).toEqual(["lint", "typecheck"]);
    expect(commandKinds("npm ci")).toEqual([]);
    expect(commandKinds("pnpm audit --prod")).toEqual(["audit"]);
  });
});

describe("Node.js version declarations", () => {
  it("combines engines, .nvmrc codenames, .node-version, .tool-versions, Dockerfiles, and a CI matrix", async () => {
    const { document } = await profile({
      "package.json": json({ name: "app", engines: { node: ">=18" } }),
      ".nvmrc": "lts/iron\n",
      ".node-version": "20.11.1\n",
      ".tool-versions": "# asdf\nnodejs 20.11.1\npnpm 9.1.0\n",
      Dockerfile: "FROM --platform=linux/amd64 node:20.11.1-bookworm-slim AS build\nRUN npm ci\nFROM nginx:1.27\n",
      ".github/workflows/ci.yml": WORKFLOW.replace(`      - run: touch ${SENTINEL}\n`, ""),
    });
    const node = facts(document, "runtime_requirements").find((fact) => fact.key === "node")!;
    expect(node).toMatchObject({ state: "observed", value: { range: "20.11.1", declared: ["18 || 20", "20.11.1", "20.11.1-bookworm-slim", ">=18", "lts/iron"] } });
    expect(cited(document, "runtime_requirements", "node")).toEqual([
      ".github/workflows/ci.yml#/jobs/test/steps/1/with/node-version",
      ".node-version:1-1",
      ".nvmrc:1-1",
      ".tool-versions:2-2",
      "Dockerfile:1-1",
      "package.json#/engines/node",
    ]);
    expect(facts(document, "runtime_requirements").find((fact) => fact.key === "pnpm")).toMatchObject({ value: { range: "9.1.0", declared: ["9.1.0"] } });
    expect(document.categories.runtime_requirements!.search.surface).toEqual([".github/workflows/ci.yml", ".node-version", ".nvmrc", ".tool-versions", "Dockerfile", "package.json"]);
  });

  it("reports an engines range of at least 20 and an .nvmrc of 18 as a conflict", async () => {
    const { document } = await profile({ "package.json": json({ name: "app", engines: { node: ">=20" } }), ".nvmrc": "18\n" });
    const node = facts(document, "runtime_requirements").find((fact) => fact.key === "node")!;
    expect(node.state).toBe("conflicting");
    expect(node.candidates!.map((candidate) => [candidate.value, candidate.rule])).toEqual([
      [{ range: ">=18.0.0 <19.0.0-0", declared: ["18"] }, "runtime.nvmrc"],
      [{ range: ">=20.0.0", declared: [">=20"] }, "manifest.engines"],
    ]);
  });

  it("keeps the requirement unknown when a declaration has no fixed version", async () => {
    const { document } = await profile({ ".nvmrc": "lts/*\n", Dockerfile: "FROM node:latest\n" });
    expect(document.categories.runtime_requirements).toMatchObject({ state: "unknown", facts: [], search: { skipped: [".nvmrc", "Dockerfile"] } });
    expect(document.diagnostics.filter((diagnostic) => diagnostic.reason === "unsupported_runtime_declaration").map((diagnostic) => diagnostic.path)).toEqual([".nvmrc", "Dockerfile"]);
  });

  it.each([
    ["lts/iron", "20"],
    ["lts/Krypton", "24"],
    ["lts/*", null],
    ["20", null],
  ])("maps the version file entry %s to %s", (declared, range) => {
    expect(nodeVersionRange(declared)).toBe(range);
  });

  it.each([
    ["node:20-alpine", "20-alpine", "20"],
    ["docker.io/library/node:20.11.1", "20.11.1", "20.11.1"],
    ["node", "latest", null],
    ["node:hydrogen-slim", "hydrogen-slim", "18"],
    ["node@sha256:0123", "latest", null],
    ["ghcr.io/acme/node:20", null, null],
    ["nginx:1.27", null, null],
  ])("reads the image %s as tag %s, range %s", (image, tag, range) => {
    expect(nodeImageTag(image)).toBe(tag);
    if (tag !== null) expect(nodeTagRange(tag)).toBe(range);
  });
});

describe("unsupported or unreadable CI", () => {
  it("never reports CI facts absent when a CI definition is unsupported", async () => {
    const { document } = await profile({ ".circleci/config.yml": "version: 2.1\njobs: {}\n" });
    expect(document.categories.ci_systems).toMatchObject({ state: "unknown", search: { skipped: [".circleci/config.yml"] } });
    expect(document.categories.verification_commands).toMatchObject({ state: "unknown", search: { skipped: [".circleci/config.yml"] } });
  });

  it("never reports CI facts absent when a workflow is over budget", async () => {
    const { document } = await profile({ ".github/workflows/ci.yml": `on: push\n# ${"x".repeat(3_000)}\njobs: {}\n` }, { budgets: { maxBlobBytes: 1_000, maxFiles: 100, maxTotalBytes: 100_000 } });
    expect(document.categories.ci_systems).toMatchObject({ state: "unknown", search: { skipped: [".github/workflows/ci.yml"] } });
    expect(document.categories.verification_commands!.state).toBe("unknown");
    expect(document.diagnostics).toContainEqual(expect.objectContaining({ path: ".github/workflows/ci.yml", reason: "blob_too_large" }));
  });

  it("reports supported systems while recording the unsupported one as skipped", async () => {
    const { document } = await profile({ ".circleci/config.yml": "version: 2.1\n", ".github/workflows/ci.yml": "on: push\njobs:\n  t:\n    steps:\n      - run: npm test\n" });
    expect(document.categories.ci_systems).toMatchObject({ state: "observed", search: { skipped: [".circleci/config.yml"] } });
  });

  it("reports no CI system after a complete search of a repository without one", async () => {
    const { document } = await profile({ "README.md": "# app\n" });
    expect(document.categories.ci_systems).toMatchObject({ state: "absent", search: { complete: true, skipped: [] } });
  });
});
