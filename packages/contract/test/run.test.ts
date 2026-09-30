import { beforeAll, describe, expect, it } from "vitest";
import { type Detector, type DetectorContext, DetectorRunCanceled, MemoryReader, type Stage, factDocumentProblems, matchesPattern, runDetectors } from "../src/index.js";

const detector = (id: string, stage: Stage, run: (context: DetectorContext) => Promise<void>, categories: string[] = []): Detector => ({
  id,
  version: "1",
  stage,
  inputs: [],
  categories,
  run,
});

describe("detector runs", () => {
  let reader: MemoryReader;

  beforeAll(() => {
    reader = MemoryReader.fromFiles({
      "package.json": '{ "name": "orders-ui", "devDependencies": { "vitest": "3.2.4" } }\n',
      "broken.json": "{ not json",
      "packages/a/package.json": "{}\n",
      "src/index.ts": "export {};\n",
    }, { commit: "a".repeat(40) });
  });

  const run = (detectors: Detector[], options: { signal?: AbortSignal; checkpoint?: (stage: Stage) => void } = {}) =>
    runDetectors({ reader, detectorRelease: "0.1.0", detectors, ...options });

  it("runs stages in order and shares results between them", async () => {
    const order: string[] = [];
    const document = await run([
      detector("convention", "convention", async (context) => void order.push(`convention:${String(context.shared.get("inventory"))}`)),
      detector("inventory", "inventory", async (context) => {
        order.push("inventory");
        context.shared.set("inventory", context.entries("**/package.json").length);
      }),
      detector("services", "services", async () => void order.push("services")),
    ]);
    expect(order).toEqual(["inventory", "convention:2", "services"]);
    expect(factDocumentProblems(document)).toEqual([]);
  });

  it("publishes cited facts and reports supported absences", async () => {
    const document = await run([
      detector(
        "manifest",
        "convention",
        async (context) => {
          const manifest = (await context.parsed("package.json", "json"))!;
          context.fact({
            category: "test_frameworks",
            key: "vitest",
            value: { name: "vitest", range: "3.2.4" },
            basis: "observed",
            evidence: [context.pointer(manifest.content, "manifest.test-frameworks", "json", "/devDependencies/vitest")],
            rule: "manifest.test-frameworks",
          });
          context.search({ category: "test_frameworks", rule: "manifest.test-frameworks", surface: ["package.json"], complete: true, skipped: [] });
          context.search({ category: "ci_systems", rule: "ci.definitions", surface: [], complete: true, skipped: [] });
        },
        ["test_frameworks", "ci_systems"],
      ),
    ]);
    const fact = document.categories.test_frameworks!.facts[0]!;
    expect(fact).toMatchObject({ key: "vitest", state: "observed", rule: "manifest.test-frameworks" });
    expect(document.evidence[fact.evidence[0]!]).toMatchObject({ path: "package.json", detector: "manifest", location: { kind: "pointer", pointer: "/devDependencies/vitest" } });
    expect(document.categories.ci_systems!.state).toBe("absent");
  });

  it("records parse failures as diagnostics and keeps affected categories unknown", async () => {
    const document = await run([
      detector(
        "manifest",
        "parse",
        async (context) => {
          expect(await context.parsed("broken.json", "json")).toBeNull();
          context.search({ category: "package_identity", rule: "manifest.identity", surface: ["broken.json"], complete: false, skipped: ["broken.json"] });
        },
        ["package_identity"],
      ),
    ]);
    expect(document.diagnostics).toContainEqual(expect.objectContaining({ path: "broken.json", reason: "parse_failed", detector: "manifest" }));
    expect(document.categories.package_identity).toMatchObject({ state: "unknown", search: { skipped: ["broken.json"] } });
  });

  it("drops candidates without evidence or reasoning and says why", async () => {
    const document = await run([
      detector("guess", "architecture", async (context) => {
        context.fact({ category: "composition", key: "single-spa", value: "single-spa", basis: "observed", evidence: [], rule: "guess.no-evidence" });
        const entry = context.entries("src/index.ts")[0]!;
        context.fact({ category: "composition", key: "module-federation", value: "mf", basis: "inferred", evidence: [context.entry(entry, "guess.no-reasoning")], rule: "guess.no-reasoning" });
      }),
    ]);
    expect(document.categories.composition).toMatchObject({ state: "unknown", facts: [] });
    expect(document.diagnostics.filter((diagnostic) => diagnostic.reason === "unsupported_assertion").map((diagnostic) => diagnostic.detail)).toEqual([
      "composition/module-federation is inferred without reasoning and was not published",
      "composition/single-spa has no evidence and was not published",
    ]);
  });

  it("turns a failing detector into a diagnostic and never an absence", async () => {
    const document = await run([
      detector(
        "ci",
        "convention",
        async (context) => {
          context.search({ category: "ci_systems", rule: "ci.definitions", surface: [], complete: true, skipped: [] });
          throw new Error("unexpected shape");
        },
        ["ci_systems"],
      ),
    ]);
    expect(document.diagnostics).toContainEqual({ path: "", reason: "detector_failed", detail: "ci failed: unexpected shape", detector: "ci" });
    expect(document.categories.ci_systems!.state).toBe("unknown");
  });

  it("stops between stages when canceled", async () => {
    const controller = new AbortController();
    const ran: string[] = [];
    await expect(
      run(
        [
          detector("inventory", "inventory", async () => {
            ran.push("inventory");
            controller.abort();
          }),
          detector("convention", "convention", async () => void ran.push("convention")),
        ],
        { signal: controller.signal },
      ),
    ).rejects.toThrow(DetectorRunCanceled);
    expect(ran).toEqual(["inventory"]);
  });

  it("lets a checkpoint stop the run", async () => {
    const stages: Stage[] = [];
    const checkpoint = (stage: Stage) => {
      stages.push(stage);
      if (stage === "parse") throw new DetectorRunCanceled("cancellation requested");
    };
    await expect(run([], { checkpoint })).rejects.toThrow("cancellation requested");
    expect(stages).toEqual(["inventory", "parse"]);
  });
});

describe("input patterns", () => {
  it.each([
    ["package.json", "package.json", true],
    ["packages/a/package.json", "package.json", false],
    ["packages/a/package.json", "**/package.json", true],
    ["package.json", "**/package.json", true],
    ["apackage.json", "**/package.json", false],
    [".github/workflows/ci.yml", ".github/workflows/*", true],
    [".github/workflows/nested/ci.yml", ".github/workflows/*", false],
    ["src/deep/app.tsx", "**/*.tsx", true],
    ["src/app.ts", "**/*.tsx", false],
    ["a.b", "a?b", false],
  ])("%s against %s", (path, pattern, expected) => {
    expect(matchesPattern(path, pattern)).toBe(expected);
  });
});
