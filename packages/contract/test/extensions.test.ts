import { describe, expect, it } from "vitest";
import { type CategoryDefinition, CategoryError, type Detector, MemoryReader, SHARED_CATEGORY_IDS, categoriesFor, defineExtension, factDocumentProblems, runDetectors } from "../src/index.js";

const ROUTES: CategoryDefinition = { id: "web-doctor.routes", label: "Routes", group: "Application", boundedNegative: true, description: "Client routes declared in source" };
const ENTRY_POINTS: CategoryDefinition = { id: "web-doctor.entry_points", label: "Entry points", group: "Application", boundedNegative: false, description: "Application entry modules" };

const reader = (commit: string | null = "a".repeat(40)) => MemoryReader.fromFiles({ "src/routes.ts": 'export const routes = ["/orders"];\n', "src/main.ts": "export {};\n" }, { commit });

const detector = (run: Detector["run"]): Detector => ({ id: "probe", version: "1", stage: "architecture", inputs: [], categories: [], run });

describe("extension categories", () => {
  it("adds registered extensions after the shared vocabulary, in id order, and records them in the document", async () => {
    const document = await runDetectors({
      reader: reader(),
      detectorRelease: "0.1.0",
      extensions: [ROUTES, ENTRY_POINTS],
      detectors: [
        detector(async (context) => {
          const content = (await context.text("src/routes.ts"))!;
          context.fact({ category: ROUTES.id, key: "/orders", value: { path: "/orders" }, basis: "observed", evidence: [context.lines(content, "routes.literal", 1)], rule: "routes.literal" });
          context.search({ category: ROUTES.id, rule: "routes.literal", surface: ["src/routes.ts"], complete: true, skipped: [] });
          context.search({ category: ENTRY_POINTS.id, rule: "entry.main", surface: [], complete: true, skipped: [] });
        }),
      ],
    });
    expect(Object.keys(document.categories)).toEqual([...SHARED_CATEGORY_IDS, "web-doctor.entry_points", "web-doctor.routes"]);
    expect(document.extensions).toEqual([
      { id: "web-doctor.entry_points", bounded_negative: false },
      { id: "web-doctor.routes", bounded_negative: true },
    ]);
    expect(document.categories["web-doctor.routes"]).toMatchObject({ state: "observed", facts: [{ key: "/orders" }] });
    // A complete search with no facts is absent only when the extension permits a bounded negative.
    expect(document.categories["web-doctor.entry_points"]!.state).toBe("unknown");
    expect(factDocumentProblems(document)).toEqual([]);
  });

  it("rejects a document with a category it does not register", async () => {
    const document = structuredClone(await runDetectors({ reader: reader(), detectorRelease: "0.1.0", detectors: [] }));
    document.categories["web-doctor.routes"] = structuredClone(document.categories.composition!);
    expect(factDocumentProblems(document)).toContainEqual("categories are not supported: web-doctor.routes");
  });

  it("rejects a registered extension that the document omits, and extensions out of order", async () => {
    const document = structuredClone(await runDetectors({ reader: reader(), detectorRelease: "0.1.0", extensions: [ROUTES, ENTRY_POINTS], detectors: [] }));
    const omitted = structuredClone(document);
    delete omitted.categories["web-doctor.routes"];
    expect(factDocumentProblems(omitted)).toContainEqual("categories are missing: web-doctor.routes");
    const reordered = structuredClone(document);
    reordered.extensions.reverse();
    expect(factDocumentProblems(reordered)).toContainEqual("extensions must be unique and in id order");
  });

  it("validates extension state rules from the document alone", async () => {
    const document = structuredClone(await runDetectors({ reader: reader(), detectorRelease: "0.1.0", extensions: [ENTRY_POINTS], detectors: [] }));
    document.categories["web-doctor.entry_points"]!.state = "absent";
    document.categories["web-doctor.entry_points"]!.search.complete = true;
    expect(factDocumentProblems(document)).toContainEqual("web-doctor.entry_points is absent but its facts and search make it unknown");
  });

  it.each([
    ["an un-namespaced id", { ...ROUTES, id: "routes" }, "must be namespaced"],
    ["an uppercase namespace", { ...ROUTES, id: "Web.routes" }, "must be namespaced"],
    ["a shared id", { ...ROUTES, id: "languages" }, "must be namespaced"],
  ])("refuses %s", (_name, definition, message) => {
    expect(() => defineExtension(definition)).toThrow(message);
  });

  it("refuses an extension registered twice", () => {
    expect(() => categoriesFor([ROUTES, ROUTES])).toThrow(CategoryError);
  });
});

describe("working-tree documents", () => {
  it("records a null commit and evidence without a commit", async () => {
    const document = await runDetectors({
      reader: reader(null),
      detectorRelease: "0.1.0",
      detectors: [
        detector(async (context) => {
          const content = (await context.text("src/main.ts"))!;
          context.fact({ category: "languages", key: "TypeScript", value: { files: 1, bytes: 11 }, basis: "observed", evidence: [context.lines(content, "inventory.language", 1)], rule: "inventory.language" });
        }),
      ],
    });
    expect(document.commit).toBeNull();
    expect(Object.values(document.evidence).map((evidence) => evidence.commit)).toEqual([null]);
    expect(factDocumentProblems(document)).toEqual([]);
  });
});

describe("diagnostics", () => {
  it("never records credentials quoted from repository content", async () => {
    const document = await runDetectors({
      reader: reader(),
      detectorRelease: "0.1.0",
      detectors: [detector(async (context) => context.diagnostic("package.json", "unsupported_value", "Cannot read git+https://deploy:s3cr3t@git.example.test/sdk.git"))],
    });
    expect(document.diagnostics).toContainEqual({ path: "package.json", reason: "unsupported_value", detail: "Cannot read git+https://[redacted]@git.example.test/sdk.git", detector: "probe" });
    expect(JSON.stringify(document)).not.toContain("s3cr3t");
  });

  it("attributes a shared layer's diagnostic to that layer", async () => {
    const document = await runDetectors({
      reader: reader(),
      detectorRelease: "0.1.0",
      detectors: [detector(async (context) => context.diagnostic("src/main.ts", "syntax_error", "Line 1: Expression expected.", { detector: "syntax" }))],
    });
    expect(document.diagnostics).toContainEqual(expect.objectContaining({ path: "src/main.ts", detector: "syntax" }));
  });
});
