import fs from "node:fs";
import path from "node:path";
import { DEFAULT_BUDGETS, MemoryReader, STAGES, digestOf, factDocumentProblems } from "@repo-facts/contract";
import { ADAPTERS_DIGEST } from "@repo-facts/design-system";
import { STYLESHEET_PARSER, SYNTAX_PARSER } from "@repo-facts/syntax";
import { describe, expect, it } from "vitest";
import { CATALOG_FIXTURES, entryFromCatalog, fixtureEntry } from "../../../test/catalog/entries.js";
import { type ConfigurationParts, DETECTORS, SURVEYOR_RELEASE, analyze, configurationFor, detectorConfiguration } from "../src/index.js";

const PARTS: ConfigurationParts = {
  release: "1.2.3",
  detectors: [
    { id: "inventory", version: "1", stage: "inventory" },
    { id: "tooling", version: "1", stage: "convention" },
  ],
  parser: { name: "typescript", version: "6.0.3", maxNodes: 200_000, maxDepth: 500 },
  stylesheetParser: { name: "repo-facts-css", version: "1.0.0", maxNodes: 200_000, maxDepth: 64 },
  limits: DEFAULT_BUDGETS,
  rulesDigest: "0".repeat(64),
  adaptersDigest: "0".repeat(64),
};
const digest = (parts: ConfigurationParts) => digestOf(configurationFor(parts)).digest;

describe("the detector bundle", () => {
  it("declares the release its package.json does", () => {
    const manifest = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "../package.json"), "utf8")) as { version: string };
    expect(SURVEYOR_RELEASE).toBe(manifest.version);
  });

  it("lists detectors in stage order", () => {
    const stages = DETECTORS.map((detector) => STAGES.indexOf(detector.stage));
    expect(stages).toEqual([...stages].sort((a, b) => a - b));
    expect(new Set(DETECTORS.map((detector) => detector.id)).size).toBe(DETECTORS.length);
  });

  it("describes this release with its parser, limits, and detectors", () => {
    const { configuration } = detectorConfiguration(DEFAULT_BUDGETS);
    expect(configuration).toMatchObject({
      schema: "repo_facts.detector_configuration",
      release: SURVEYOR_RELEASE,
      fact_document: { schema: "repo_facts.fact_document", schema_version: 3 },
      syntax: { parser: "typescript", parser_version: SYNTAX_PARSER.version },
      stylesheets: { parser: "repo-facts-css", parser_version: STYLESHEET_PARSER.version, max_nodes: 200_000, max_depth: 64 },
      adapters: { digest: ADAPTERS_DIGEST },
      limits: { max_blob_bytes: DEFAULT_BUDGETS.maxBlobBytes, max_lockfile_bytes: DEFAULT_BUDGETS.maxLockfileBytes, max_files: DEFAULT_BUDGETS.maxFiles, max_total_bytes: DEFAULT_BUDGETS.maxTotalBytes },
    });
    expect((configuration.detectors as { id: string }[]).map((detector) => detector.id)).toEqual(DETECTORS.map((detector) => detector.id));
  });

  it("gives identical configurations identical digests", () => {
    expect(detectorConfiguration(DEFAULT_BUDGETS).digest).toBe(detectorConfiguration({ ...DEFAULT_BUDGETS }).digest);
    expect(digest(PARTS)).toBe(digest(structuredClone(PARTS)));
  });

  it.each<[string, Partial<ConfigurationParts>]>([
    ["the parser version", { parser: { ...PARTS.parser, version: "6.1.0" } }],
    ["a syntax limit", { parser: { ...PARTS.parser, maxNodes: 100_000 } }],
    ["a detector version", { detectors: [PARTS.detectors[0]!, { ...PARTS.detectors[1]!, version: "2" }] }],
    ["the detector set", { detectors: [PARTS.detectors[0]!] }],
    ["a read limit", { limits: { ...DEFAULT_BUDGETS, maxBlobBytes: 2_000_000 } }],
    ["the lockfile read limit", { limits: { ...DEFAULT_BUDGETS, maxLockfileBytes: 8_000_000 } }],
    ["the release", { release: "1.2.4" }],
    ["the rules", { rulesDigest: "1".repeat(64) }],
    ["the stylesheet parser version", { stylesheetParser: { ...PARTS.stylesheetParser, version: "1.1.0" } }],
    ["a stylesheet limit", { stylesheetParser: { ...PARTS.stylesheetParser, maxDepth: 32 } }],
    ["the styling adapters", { adaptersDigest: "1".repeat(64) }],
  ])("changes the configuration digest when %s changes", (_name, change) => {
    expect(digest({ ...PARTS, ...change })).not.toBe(digest(PARTS));
  });

  it("runs the design-system detectors after the architecture detectors, in the architecture stage", () => {
    const ids = DETECTORS.map((detector) => detector.id);
    expect(ids.indexOf("design-system.recognize")).toBeGreaterThan(ids.indexOf("composition"));
    expect(ids.indexOf("design-system.usage")).toBe(ids.indexOf("design-system.recognize") + 1);
    expect(DETECTORS.filter((detector) => detector.id.startsWith("design-system.")).map((detector) => detector.stage)).toEqual(["architecture", "architecture"]);
  });

  it("keeps the release and configuration digest when an entry's token list changes, and names the new entry's digest (Catalog update)", async () => {
    const files = { "package.json": '{ "name": "app", "dependencies": { "@salt-ds/core": "1.50.0" } }\n', "src/app.css": ".a { gap: var(--salt-spacing-9999) }\n" };
    const salt = fixtureEntry("salt-1.50.0");
    const changed = entryFromCatalog(fs.readFileSync(path.join(CATALOG_FIXTURES, "salt-1.50.0.yaml"), "utf8"), (entry) => entry.content.tokens!.push({ name: "--salt-spacing-9999" }));
    expect(changed.digest).not.toBe(salt.digest);
    const configuration = detectorConfiguration(DEFAULT_BUDGETS).digest;

    const before = await analyze(MemoryReader.fromFiles(files, { commit: "a".repeat(40) }), { entries: [salt] });
    const after = await analyze(MemoryReader.fromFiles(files, { commit: "a".repeat(40) }), { entries: [changed] });
    expect(after.detector_release).toBe(before.detector_release);
    expect(detectorConfiguration(DEFAULT_BUDGETS).digest).toBe(configuration);
    expect(before.catalog_entries.map((entry) => entry.digest)).toEqual([salt.digest]);
    expect(after.catalog_entries.map((entry) => entry.digest)).toEqual([changed.digest]);
    expect(before.categories.style_values!.facts.map((fact) => fact.key)).toContain("unknown-token:--salt-spacing-9999");
    expect(after.categories.style_values!.facts.map((fact) => fact.key)).not.toContain("unknown-token:--salt-spacing-9999");
  });

  it("produces byte-identical documents from the same content, release, configuration, and entries", async () => {
    const files = { "package.json": '{ "name": "app", "dependencies": { "@salt-ds/core": "^1.50.0" } }\n', "src/App.tsx": 'import { Button } from "@salt-ds/core";\nexport const A = () => <Button appearance="solid" />;\n' };
    const entries = [fixtureEntry("salt-1.75.0"), fixtureEntry("salt-1.50.0"), fixtureEntry("mui-6.1.0")];
    const first = await analyze(MemoryReader.fromFiles(files, { commit: "a".repeat(40) }), { entries });
    const second = await analyze(MemoryReader.fromFiles(files, { commit: "a".repeat(40) }), { entries: [...entries].reverse() });
    expect(digestOf(second).digest).toBe(digestOf(first).digest);
  });

  it("recognizes no design system when no entries are supplied, and still succeeds", async () => {
    const reader = MemoryReader.fromFiles({ "package.json": '{ "name": "app", "dependencies": { "@salt-ds/core": "1.75.0" } }\n', "src/App.tsx": 'import { Button } from "@salt-ds/core";\nexport const A = () => <Button />;\n' }, { commit: "a".repeat(40) });
    const document = await analyze(reader);
    expect(factDocumentProblems(document)).toEqual([]);
    expect(document.categories.design_systems).toMatchObject({ state: "unknown", facts: [] });
    expect(document.catalog_entries).toEqual([]);
  });

  it("analyzes a tree into a valid fact document that records the release", async () => {
    const reader = MemoryReader.fromFiles({ "package.json": '{ "name": "app", "devDependencies": { "vitest": "3.2.4" } }\n', "src/app.ts": "export {};\n" }, { commit: "a".repeat(40) });
    const document = await analyze(reader);
    expect(document.detector_release).toBe(SURVEYOR_RELEASE);
    expect(document.categories.test_frameworks!.facts.map((fact) => fact.key)).toEqual(["vitest"]);
    expect(factDocumentProblems(document)).toEqual([]);
  });
});
