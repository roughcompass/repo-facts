import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { type CategoryDefinition, type Detector, MemoryReader, dump, factDocumentProblems, parseCanonical, runDetectors } from "@repo-facts/contract";

const ROOT = path.resolve(import.meta.dirname, "../..");
const DOCS = path.join(ROOT, "docs");
const EXAMPLES = path.join(DOCS, "examples");
const update = process.env.REPO_FACTS_UPDATE_EXAMPLES === "1";

const ROUTES: CategoryDefinition = { id: "example.routes", label: "Routes", group: "Application", boundedNegative: true, description: "Client routes declared in source" };

/** A small run whose output is the documented example. */
async function example(extensions: CategoryDefinition[] = []) {
  const reader = MemoryReader.fromFiles({ "package.json": '{\n  "name": "orders-ui",\n  "engines": { "node": ">=20" }\n}\n', ".nvmrc": "18\n", "src/routes.ts": 'export const routes = ["/orders"];\n' });
  const detector: Detector = {
    id: "example",
    version: "1",
    stage: "convention",
    inputs: ["package.json", ".nvmrc", "src/routes.ts"],
    categories: ["runtime_requirements", "test_frameworks", ...extensions.map((extension) => extension.id)],
    async run(context) {
      const manifest = (await context.parsed("package.json", "json"))!;
      const nvmrc = (await context.text(".nvmrc"))!;
      context.fact({ category: "runtime_requirements", key: "node", value: { range: ">=20.0.0", declared: [">=20"] }, basis: "observed", evidence: [context.pointer(manifest.content, "manifest.engines", "json", "/engines/node")], rule: "manifest.engines" });
      context.fact({ category: "runtime_requirements", key: "node", value: { range: "18.0.0 - 18", declared: ["18"] }, basis: "observed", evidence: [context.lines(nvmrc, "runtime.nvmrc", 1)], rule: "runtime.nvmrc" });
      context.search({ category: "runtime_requirements", rule: "runtime.declarations", surface: ["package.json", ".nvmrc"], complete: true, skipped: [] });
      context.search({ category: "test_frameworks", rule: "manifest.test-frameworks", surface: ["package.json"], complete: true, skipped: [] });
      if (extensions.length) {
        const routes = (await context.text("src/routes.ts"))!;
        context.fact({ category: ROUTES.id, key: "/orders", value: { path: "/orders" }, basis: "observed", evidence: [context.lines(routes, "routes.literal", 1)], rule: "routes.literal" });
        context.search({ category: ROUTES.id, rule: "routes.literal", surface: ["src/routes.ts"], complete: true, skipped: [] });
      }
    },
  };
  return runDetectors({ reader, detectorRelease: "0.1.0", detectors: [detector], extensions });
}

const EXPECTED: Record<string, () => Promise<unknown>> = {
  "fact-document.json": () => example(),
  "fact-document-with-extension.json": () => example([ROUTES]),
};

describe("documentation", () => {
  it.each(Object.keys(EXPECTED))("keeps docs/examples/%s current and valid", async (name) => {
    const text = `${JSON.stringify(parseCanonical(dump(await EXPECTED[name]!())), null, 2)}\n`;
    const file = path.join(EXAMPLES, name);
    if (update) fs.writeFileSync(file, text);
    expect(fs.readFileSync(file, "utf8")).toBe(text);
    expect(factDocumentProblems(JSON.parse(text))).toEqual([]);
  });

  it("validates and links every example document", () => {
    const examples = fs.readdirSync(EXAMPLES).filter((name) => name.endsWith(".json"));
    expect(examples.sort()).toEqual(Object.keys(EXPECTED).sort());
    const docs = fs.readdirSync(DOCS).filter((name) => name.endsWith(".md")).map((name) => fs.readFileSync(path.join(DOCS, name), "utf8")).join("\n");
    for (const name of examples) {
      expect(factDocumentProblems(JSON.parse(fs.readFileSync(path.join(EXAMPLES, name), "utf8"))), name).toEqual([]);
      expect(docs, name).toContain(`examples/${name}`);
    }
  });

  it("documents reader conformance with the exact usage its test runs", () => {
    const doc = fs.readFileSync(path.join(DOCS, "source-reader.md"), "utf8");
    const marker = "<!-- usage: packages/contract/test/documented-usage.test.ts -->";
    expect(doc).toContain(marker);
    const block = /```ts\n([\s\S]*?)```/.exec(doc.slice(doc.indexOf(marker)))![1];
    expect(block).toBe(fs.readFileSync(path.join(ROOT, "packages/contract/test/documented-usage.test.ts"), "utf8"));
  });
});
