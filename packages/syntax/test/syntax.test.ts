import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type BlobContent, type Detector, type Evidence, MemoryReader, lineEvidence, resolveEvidence, runDetectors } from "@repo-facts/contract";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { SYNTAX_DEPTH_LIMIT, SYNTAX_LAYER, type StaticValue, type SyntaxResult, SyntaxTree, dialectOf, nodeEvidence, resolveString, resolveValue, syntaxOf } from "../src/index.js";

/** Blob content for a path, as the SnapshotReader would supply it. */
function blob(filePath: string, text: string): BlobContent {
  const bytes = Buffer.from(text);
  return {
    entry: { path: filePath, mode: "100644", type: "file", objectId: "0".repeat(40), size: bytes.length },
    bytes,
    text,
    binary: false,
    digest: crypto.createHash("sha256").update(bytes).digest("hex"),
  };
}

function parse(filePath: string, text: string, limits?: { nodes: number; depth: number }): SyntaxTree {
  const result = SyntaxTree.parse(blob(filePath, text), limits);
  if (!result.ok) throw new Error(`${filePath}: ${result.failure.reason} ${result.failure.detail}`);
  return result.tree;
}

function failure(result: SyntaxResult) {
  if (result.ok) throw new Error("expected the parse to fail");
  return result.failure;
}

/** The first node of +kind+ whose text is +text+. */
function find<T extends ts.Node>(tree: SyntaxTree, test: (node: ts.Node) => node is T, text?: string): T {
  let found: T | undefined;
  tree.walk((node) => {
    if (!found && test(node) && (text === undefined || tree.text(node) === text)) found = node;
    return !found;
  });
  if (!found) throw new Error(`No ${text ?? "matching"} node`);
  return found;
}

/** The resolved first argument of the first call to +callee+. */
function argumentOf(tree: SyntaxTree, callee: string): StaticValue {
  const isCall = (node: ts.Node): node is ts.CallExpression => ts.isCallExpression(node) && tree.text(node.expression) === callee;
  return resolveValue(tree, find(tree, isCall).arguments[0]!);
}

describe("parse-only syntax trees", () => {
  it.each([
    ["app.js", "const App = () => <main>{items.map((item) => <p key={item}>{item}</p>)}</main>;\nexport default App;\n", "js"],
    ["app.mjs", 'import { a } from "./a.mjs";\nexport const b = a ?? 1;\n', "js"],
    ["app.cjs", 'module.exports = { name: "orders" };\n', "js"],
    ["app.jsx", "export const App = ({ title }) => <h1 className=\"title\">{title}</h1>;\n", "jsx"],
    ["app.ts", "interface Order { id: string }\nexport const load = async (id: string): Promise<Order> => ({ id });\n", "ts"],
    ["app.mts", "export type Id = `ord_${string}`;\nexport const id: Id = \"ord_1\";\n", "ts"],
    ["app.cts", "export = function handler(): void {};\n", "ts"],
    ["app.tsx", "export function App<T extends object>({ value }: { value: T }) {\n  return <pre>{JSON.stringify(value satisfies object)}</pre>;\n}\n", "tsx"],
  ])("parses %s as %s", (filePath, text, dialect) => {
    expect(dialectOf(filePath)).toBe(dialect);
    const tree = parse(filePath, text);
    expect(tree.dialect).toBe(dialect);
    expect(tree.nodeCount).toBeGreaterThan(5);
  });

  it("ignores files that are not JavaScript or TypeScript", () => {
    expect(dialectOf("styles.css")).toBeNull();
    expect(dialectOf("Makefile")).toBeNull();
    expect(dialectOf(".ts")).toBeNull();
    expect(failure(SyntaxTree.parse(blob("package.json", "{}"))).reason).toBe("not_source");
  });

  it.each([
    ["app.ts", "const x = ;\n", "Line 1: Expression expected."],
    ["app.tsx", "export const App = () => <div>\n  <span>\n</div>;\n", "Line 2: JSX element 'span' has no corresponding closing tag."],
    ["app.js", "function (\n", "Line 1"],
    ["app.ts", 'const text = "unterminated\n', "Line 1: Unterminated string literal."],
  ])("skips %s with a syntax error", (filePath, text, detail) => {
    const skipped = failure(SyntaxTree.parse(blob(filePath, text)));
    expect(skipped.reason).toBe("syntax_error");
    expect(skipped.detail).toContain(detail);
  });

  it("stops at the syntax-node limit", () => {
    const text = `export const values = [${"0,".repeat(200)}];\n`;
    expect(parse("values.ts", text).nodeCount).toBeGreaterThan(200);
    expect(failure(SyntaxTree.parse(blob("values.ts", text), { nodes: 100, depth: 500 }))).toMatchObject({ reason: "syntax_node_limit", detail: "The file has more than 100 syntax nodes" });
  });

  it("stops at the depth limit, including nesting deep enough to exhaust the parser's stack", () => {
    const nested = (levels: number) => `export const x = ${"[".repeat(levels)}${"]".repeat(levels)};\n`;
    expect(parse("shallow.ts", nested(SYNTAX_DEPTH_LIMIT - 10)).nodeCount).toBeGreaterThan(SYNTAX_DEPTH_LIMIT - 10);
    expect(failure(SyntaxTree.parse(blob("deep.ts", nested(SYNTAX_DEPTH_LIMIT + 100)))).reason).toBe("syntax_depth_limit");
    expect(failure(SyntaxTree.parse(blob("deeper.ts", nested(100_000))))).toMatchObject({ reason: "syntax_depth_limit", detail: "The file nests too deeply to parse" });
    // The parser recovers its state for the next file.
    expect(parse("after.ts", "export const ok = 1;\n").nodeCount).toBeGreaterThan(1);
  });

  it("parses hostile code without running any of it", () => {
    const sentinel = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "syntax-sentinel-")), "executed");
    const hostile = [
      `require("node:fs").writeFileSync(${JSON.stringify(sentinel)}, "ran");`,
      `import(${JSON.stringify(`data:text/javascript,require("fs").writeFileSync(${JSON.stringify(sentinel)},"ran")`)});`,
      `globalThis.__fabricateSyntaxTrap = true;`,
      `eval("globalThis.__fabricateSyntaxTrap = true");`,
      `new Function("globalThis.__fabricateSyntaxTrap = true")();`,
      `Object.defineProperty(Object.prototype, "polluted", { get() { throw new Error("trap"); } });`,
      `process.exit(97);`,
      `while (true) {}`,
    ].join("\n");
    for (const filePath of ["hostile.js", "hostile.ts", "hostile.tsx"]) expect(parse(filePath, hostile).nodeCount).toBeGreaterThan(20);
    expect(fs.existsSync(sentinel)).toBe(false);
    expect((globalThis as Record<string, unknown>).__fabricateSyntaxTrap).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty("polluted");
  });

  it("reports exact positions in UTF-16 columns and lines for evidence", () => {
    const text = 'const label = "🚀";\r\nexport async function load() {\r\n  return fetch(\r\n    "https://api.example.test/orders",\r\n  );\r\n}\r\n';
    const tree = parse("client.ts", text);
    const call = find(tree, ts.isCallExpression);
    expect(tree.position(call)).toMatchObject({ start: { line: 3, column: 10 }, end: { line: 5, column: 4 } });
    expect(tree.lines(call)).toEqual({ start: 3, end: 5 });
    const url = find(tree, ts.isStringLiteral, '"https://api.example.test/orders"');
    expect(tree.position(url)).toMatchObject({ start: { line: 4, column: 5 }, end: { line: 4, column: 38 } });
    expect(text.slice(tree.position(url).offset, tree.position(url).offset + tree.position(url).length)).toBe('"https://api.example.test/orders"');
    const rocket = find(tree, ts.isStringLiteral, '"🚀"');
    expect(tree.position(rocket).end.column - tree.position(rocket).start.column).toBe(4);
  });

  it("walks in source order and can skip subtrees", () => {
    const tree = parse("order.ts", "a(); function f() { b(); }\nc();\n");
    const calls: string[] = [];
    tree.walk((node) => {
      if (ts.isFunctionDeclaration(node)) return false;
      if (ts.isCallExpression(node)) calls.push(tree.text(node.expression));
    });
    expect(calls).toEqual(["a", "c"]);
  });
});

describe("same-file bindings", () => {
  const tree = parse(
    "bindings.ts",
    [
      'import base, { API_ROOT } from "./config";',
      'import * as settings from "./settings";',
      'export const ORIGIN = "https://api.example.test";',
      "const { nested } = settings;",
      "let mutable = ORIGIN;",
      "var legacy = 1;",
      'const shadowed = "outer";',
      'function handler(shadowed: string, [first]: string[]) { const inner = "x"; return shadowed + first + inner; }',
      "try {} catch (error) {}",
      "enum Kind { A }",
      "class Client {}",
      "for (const item of []) {}",
    ].join("\n"),
  );

  it.each([
    ["ORIGIN", ["const"], true],
    ["inner", ["const"], true],
    ["base", ["import"], false],
    ["API_ROOT", ["import"], false],
    ["settings", ["import"], false],
    ["nested", ["const"], false],
    ["mutable", ["let"], false],
    ["legacy", ["var"], false],
    ["shadowed", ["const", "parameter"], false],
    ["first", ["parameter"], false],
    ["error", ["catch"], false],
    ["Kind", ["enum"], false],
    ["Client", ["class"], false],
    ["handler", ["function"], false],
    ["item", ["const"], false],
  ])("records %s", (name, kinds, constant) => {
    const binding = tree.binding(name)!;
    expect(binding.kinds).toEqual(kinds);
    expect(binding.constant !== null).toBe(constant);
  });

  it("does not bind globals", () => {
    expect(tree.binding("fetch")).toBeUndefined();
  });
});

describe("static values", () => {
  const source = [
    'const ORIGIN = "https://api.example.test";',
    "const VERSION = 2;",
    "const BASE = `${ORIGIN}/v${VERSION}`;",
    "const CONFIG = { baseUrl: BASE, retries: 3, nested: { path: '/orders' }, ...defaults } as const;",
    "const PLAIN = { timeout: 5000, headers: ['accept'] } satisfies object;",
    "const FROM_ENV = process.env.ORDERS_API_URL;",
    "const LOOP_A = LOOP_B;",
    "const LOOP_B = LOOP_A;",
    'import { imported } from "./config";',
    "let reassignable = ORIGIN;",
    "export async function calls(id: string) {",
    "  fetch(ORIGIN + '/orders');",
    "  fetch(`${BASE}/orders/${id}`);",
    "  fetch(CONFIG.baseUrl);",
    "  fetch(CONFIG.nested.path);",
    "  fetch(CONFIG.other);",
    "  fetch(PLAIN.timeout);",
    "  fetch(PLAIN.missing);",
    "  fetch(PLAIN.headers[0]);",
    "  fetch(FROM_ENV + '/orders');",
    "  fetch(process.env['PAYMENTS_URL']);",
    "  fetch(import.meta.env.VITE_API);",
    "  fetch(process.env[name]);",
    "  fetch(imported);",
    "  fetch(reassignable);",
    "  fetch(id);",
    "  fetch(LOOP_A);",
    "  fetch(buildUrl());",
    "  fetch(tag`x`);",
    "  fetch(flag ? ORIGIN : BASE);",
    "  fetch(-1);",
    "  fetch(undefined);",
    "}",
  ].join("\n");
  const tree = parse("values.ts", source);
  const values: StaticValue[] = [];
  tree.walk((node) => {
    if (ts.isCallExpression(node) && tree.text(node.expression) === "fetch") values.push(resolveValue(tree, node.arguments[0]!));
  });
  const summary = (value: StaticValue): unknown => {
    switch (value.kind) {
      case "string":
      case "number":
      case "boolean":
        return value.value;
      case "template":
        return value.parts.map((part) => (part.kind === "text" ? part.value : part.kind === "configured" ? `{${part.source}.${part.key}}` : `{unresolved:${part.reason}}`));
      case "configured":
        return `{${value.source}.${value.key}}`;
      case "unresolved":
        return `unresolved:${value.reason}`;
      default:
        return value.kind;
    }
  };

  it.each([
    [0, "https://api.example.test/orders"],
    [1, ["https://api.example.test/v2/orders/", "{unresolved:parameter}"]],
    [2, "https://api.example.test/v2"],
    [3, "/orders"],
    [4, "unresolved:computed"],
    [5, 5000],
    [6, "undefined"],
    [7, "accept"],
    [8, ["{process.env.ORDERS_API_URL}", "/orders"]],
    [9, "{process.env.PAYMENTS_URL}"],
    [10, "{import.meta.env.VITE_API}"],
    [11, "unresolved:computed"],
    [12, "unresolved:imported"],
    [13, "unresolved:reassignable"],
    [14, "unresolved:parameter"],
    [15, "unresolved:cycle"],
    [16, "unresolved:computed"],
    [17, "unresolved:computed"],
    [18, "unresolved:computed"],
    [19, -1],
    [20, "undefined"],
  ])("resolves fetch argument %i", (index, expected) => {
    expect(summary(values[index]!)).toEqual(expected);
  });

  it("keeps the literal's node so evidence can cite the declaration", () => {
    const value = values[2]!;
    expect(value.kind).toBe("string");
    expect(tree.lines(value.node)).toEqual({ start: 3, end: 3 });
  });

  it("never resolves a shadowed name", () => {
    const shadowing = parse("shadow.ts", 'const URL_BASE = "https://a.example.test";\nfunction f(URL_BASE: string) { return URL_BASE; }\nfetch(URL_BASE);\n');
    expect(summary(argumentOf(shadowing, "fetch"))).toBe("unresolved:ambiguous_binding");
    expect(resolveString(shadowing, find(shadowing, ts.isStringLiteral))).toBe("https://a.example.test");
  });
});

describe("syntax in detector runs", () => {
  it("shares trees, cites nodes, and records failures and budget skips as skipped inputs", async () => {
    const reader = MemoryReader.fromFiles(
      {
        "src/client.ts": 'export const load = () => fetch("https://api.example.test/orders");\n',
        "src/broken.tsx": "export const App = () => <div>;\n",
        "src/huge.ts": `export const values = [${"0,".repeat(210_000)}];\n`,
        "src/oversized.js": `// ${"x".repeat(600_000)}\n`,
        "src/missing-parse.css": "body {}\n",
      },
      { commit: "a".repeat(40), budgets: { maxBlobBytes: 500_000, maxFiles: 100, maxTotalBytes: 10_000_000 } },
    );
    const seen: (SyntaxTree | null)[] = [];
    let cited: Evidence | undefined;
    const reading = (id: string): Detector => ({
      id,
      version: "1",
      stage: "architecture",
      inputs: ["**/*.ts", "**/*.tsx", "**/*.js"],
      categories: [],
      async run(context) {
        for (const file of ["src/client.ts", "src/broken.tsx", "src/huge.ts", "src/oversized.js", "src/missing-parse.css"]) seen.push(await syntaxOf(context, file));
        const tree = seen[0]!;
        cited = nodeEvidence(context, tree, find(tree, ts.isCallExpression), "services.fetch");
        context.search({ category: "api_contracts", rule: "contracts.imports", surface: ["src/broken.tsx", "src/client.ts"], complete: true, skipped: [] });
      },
    });

    const document = await runDetectors({ reader, detectorRelease: "0.1.0", detectors: [reading("first"), reading("second")] });
    expect(seen[0]).toBeInstanceOf(SyntaxTree);
    expect(seen[5]).toBe(seen[0]);
    expect(seen.slice(1, 5)).toEqual([null, null, null, null]);
    expect(document.diagnostics.map(({ path: file, reason, detector }) => ({ file, reason, detector }))).toEqual([
      { file: "src/broken.tsx", reason: "syntax_error", detector: SYNTAX_LAYER },
      { file: "src/huge.ts", reason: "syntax_node_limit", detector: SYNTAX_LAYER },
      { file: "src/oversized.js", reason: "blob_too_large", detector: null },
    ]);
    expect(document.categories.api_contracts).toMatchObject({ state: "unknown", search: { complete: true, skipped: ["src/broken.tsx"] } });

    expect(cited).toMatchObject({ path: "src/client.ts", detector: "second", rule: "services.fetch", location: { kind: "lines", start: 1, end: 1 } });
    expect(await resolveEvidence(reader, cited!)).toMatchObject({ ok: true, excerpt: 'export const load = () => fetch("https://api.example.test/orders");' });
    expect(cited).toEqual(lineEvidence(seen[0]!.content, { commit: reader.commit, detector: "second", rule: "services.fetch" }, 1));
  });
});
