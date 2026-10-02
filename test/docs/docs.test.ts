import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { type CategoryDefinition, type Detector, MemoryReader, SHARED_CATEGORIES, dump, factDocumentProblems, parseCanonical, runDetectors } from "@repo-facts/contract";
import { adapterCatalogSchema, catalogSchema } from "@repo-facts/design-system";
import * as syntax from "@repo-facts/syntax";
import type { z } from "zod";
import { compileRules, ruleDetector } from "@repo-facts/syntax";

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

  it("runs the syntax rule guide's worked example exactly as documented", async () => {
    const doc = fs.readFileSync(path.join(DOCS, "syntax-rules.md"), "utf8");
    const block = (marker: string, language: string) => {
      const start = doc.indexOf(marker);
      expect(start, marker).toBeGreaterThan(-1);
      return new RegExp("```" + language + "\\n([\\s\\S]*?)```").exec(doc.slice(start))![1]!;
    };
    const compiled = compileRules([{ path: "docs/syntax-rules.md", text: block("<!-- example-rule -->", "yaml") }]);
    if (!compiled.ok) throw new Error(compiled.problems.join("\n"));
    const sourcePath = /<!-- example-source: (\S+) -->/.exec(doc)![1]!;
    const reader = MemoryReader.fromFiles({ [sourcePath]: block("<!-- example-source:", "ts") });
    const detector = ruleDetector({ id: "example-rules", version: "1", stage: "architecture", rules: compiled.rules, sources: () => [sourcePath] });
    const document = await runDetectors({ reader, detectorRelease: "0.1.0", detectors: [detector] });
    const facts = document.categories.composition!.facts.map((fact) => ({ key: fact.key, value: fact.value }));
    expect(facts).toEqual(JSON.parse(block("<!-- example-facts -->", "json")));
  });

  it("names only real syntax-layer exports in the tags and stylesheets section", () => {
    const doc = fs.readFileSync(path.join(DOCS, "syntax-rules.md"), "utf8");
    const section = doc.slice(doc.indexOf("## Beyond rules: tags and stylesheets"));
    const functions = [...section.matchAll(/`([a-zA-Z]+)\(/g)].map((match) => match[1]!).filter((name) => !["styled", "var", "url", "require"].includes(name));
    const constants = [...section.matchAll(/`([A-Z][A-Z_]+)`/g)].map((match) => match[1]!);
    expect(new Set(functions)).toEqual(new Set(["resolveTag", "resolveReference", "styledWrapperOf", "parseStylesheet", "tokenize", "walkStylesheet"]));
    const exports = syntax as Record<string, unknown>;
    for (const name of functions) expect(typeof exports[name], name).toBe("function");
    for (const name of constants) expect(exports[name], name).toBeDefined();
    expect(constants.length).toBeGreaterThanOrEqual(4);
  });

  it("documents exactly the catalog and adapter fields the schemas accept", () => {
    const doc = fs.readFileSync(path.join(DOCS, "design-system-catalogs.md"), "utf8");
    const documented = (marker: string) => {
      const table = doc.slice(doc.indexOf(marker)).split("\n\n")[0]!.split("\n").slice(3);
      return table.map((row) => /^\| `([^`]+)` \|/.exec(row)![1]!);
    };
    expect(documented("<!-- catalog-fields -->")).toEqual(fieldsOf(catalogSchema));
    expect(documented("<!-- adapter-fields -->")).toEqual(fieldsOf(adapterCatalogSchema));
  });
});

describe("documented names", () => {
  it("lists exactly the packages the repository has, in the README", () => {
    const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
    const listed = [...readme.matchAll(/^\| `@repo-facts\/([a-z-]+)` \|/gm)].map((match) => match[1]!);
    const packages = fs.readdirSync(path.join(ROOT, "packages")).filter((name) => fs.existsSync(path.join(ROOT, "packages", name, "package.json")));
    expect([...listed].sort()).toEqual(packages.sort());
  });

  it("lists exactly the shared categories, by group, in the detector contract", () => {
    const doc = fs.readFileSync(path.join(DOCS, "detector-contract.md"), "utf8");
    const rows = [...doc.matchAll(/^\| ([A-Z][A-Za-z]+) \| (`[a-z_]+`(?:, `[a-z_]+`)*) \|$/gm)].map((match) => [match[1]!, [...match[2]!.matchAll(/`([a-z_]+)`/g)].map((name) => name[1]!)] as const);
    const groups = new Map<string, string[]>();
    for (const definition of SHARED_CATEGORIES) groups.set(definition.group, [...(groups.get(definition.group) ?? []), definition.id]);
    expect(rows).toEqual([...groups.entries()]);
    expect(doc).toContain(`The contract owns ${SHARED_CATEGORIES.length} shared categories`);
  });

  it("links only to files that exist", () => {
    const documents = [path.join(ROOT, "README.md"), ...fs.readdirSync(DOCS).filter((name) => name.endsWith(".md")).map((name) => path.join(DOCS, name))];
    for (const document of documents) {
      const text = fs.readFileSync(document, "utf8");
      for (const [, target] of text.matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)) {
        if (/^[a-z]+:/.test(target!)) continue;
        expect(fs.existsSync(path.resolve(path.dirname(document), target!)), `${path.relative(ROOT, document)} links to ${target}`).toBe(true);
      }
    }
  });
});

/** Every field of an object schema, with nested object fields as `parent[].child`, in declaration order. */
function fieldsOf(schema: z.ZodType, prefix = ""): string[] {
  const unwrap = (type: z.ZodType): z.ZodType => {
    const def = (type as unknown as { def: { type: string; innerType?: z.ZodType; element?: z.ZodType } }).def;
    if (def.type === "optional" && def.innerType) return unwrap(def.innerType);
    return type;
  };
  const shape = (unwrap(schema) as unknown as { shape?: Record<string, z.ZodType> }).shape;
  if (!shape) return [];
  return Object.entries(shape).flatMap(([name, field]) => {
    const inner = unwrap(field);
    const def = (inner as unknown as { def: { type: string; element?: z.ZodType } }).def;
    const nested = def.type === "array" && def.element ? fieldsOf(def.element, `${prefix}${name}[].`) : [];
    return [`${prefix}${name}`, ...nested];
  });
}

