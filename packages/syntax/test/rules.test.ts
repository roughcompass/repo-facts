import crypto from "node:crypto";
import { type BlobContent, type Detector, MemoryReader, factDocumentProblems, runDetectors } from "@repo-facts/contract";
import { describe, expect, it } from "vitest";
import { type Rule, SyntaxTree, captureValue, compileRules, matchRules, ruleDetector } from "../src/index.js";

const RULES = `
format: 1
rules:
  - id: services.fetch
    version: 1
    description: Direct fetch calls
    match: { call: { global: fetch } }
    capture:
      url: { argument: 0 }
      method: { argument: 1, property: [method] }
    emit: { signal: { kind: http } }
  - id: services.axios-create
    version: 1
    description: Configured axios instances
    match: { call: { module: axios, method: [create] } }
    capture:
      baseURL: { argument: 0, property: [baseURL] }
    emit: { signal: { kind: http-client } }
  - id: services.axios-instance-call
    version: 1
    description: Requests through a configured axios instance
    match: { call: { instanceOf: services.axios-create, method: [get, post] } }
    capture:
      path: { argument: 0 }
    emit: { signal: { kind: http } }
  - id: services.axios-call
    version: 1
    description: Requests through axios itself
    match: { call: { module: axios, method: [get, post] } }
    capture:
      url: { argument: 0 }
    emit: { signal: { kind: http } }
  - id: architecture.single-spa
    version: 1
    description: single-spa application registration
    match: { call: { module: single-spa, members: [registerApplication] } }
    capture:
      name: { argument: 0, property: [name] }
    emit:
      fact:
        category: composition
        key: "single-spa:{name}"
        value: { mechanism: single-spa, application: $name }
        basis: observed
  - id: architecture.module-federation
    version: 1
    description: Module Federation plugin configuration
    match: { new: { module: [webpack, "@rspack/core"], members: [container, ModuleFederationPlugin] } }
    capture:
      name: { argument: 0, property: [name] }
      remotes: { argument: 0, property: [remotes] }
    emit: { signal: { kind: federation } }
  - id: architecture.iframe
    version: 1
    description: Embedded frames
    match: { jsx: { element: [iframe] } }
    capture:
      src: { attribute: src }
    emit:
      reference: { type: iframe, role: embedder, identifier: { url: "{src}" }, basis: observed }
  - id: architecture.message-listener
    version: 1
    description: Window message listeners
    match: { call: { anyReceiver: true, method: [addEventListener] } }
    capture:
      event: { argument: 0 }
    where: [{ capture: event, equals: message }]
    emit: { signal: { kind: message-listener } }
  - id: services.graphql
    version: 1
    description: GraphQL documents
    match: { tagged: { module: graphql-tag } }
    capture:
      document: { template: true }
    emit: { signal: { kind: graphql } }
  - id: services.msw
    version: 1
    description: Mock Service Worker imports
    match: { import: { module: [msw, msw/node] } }
    capture:
      module: { module: true }
    emit: { signal: { kind: substitute } }
`;

const compiled = (() => {
  const result = compileRules([{ path: "test.yaml", text: RULES }]);
  if (!result.ok) throw new Error(result.problems.join("\n"));
  return result;
})();

function blob(path: string, text: string): BlobContent {
  const bytes = Buffer.from(text);
  return { entry: { path, mode: "100644", type: "file", objectId: "0".repeat(40), size: bytes.length }, bytes, text, binary: false, digest: crypto.createHash("sha256").update(bytes).digest("hex") };
}

function tree(text: string, path = "src/app.tsx"): SyntaxTree {
  const result = SyntaxTree.parse(blob(path, text));
  if (!result.ok) throw new Error(result.failure.detail);
  return result.tree;
}

/** [rule id, line, captures] for every match in +text+. */
const matches = (text: string, path?: string) =>
  matchRules(tree(text, path), compiled.rules).map((match) => [match.rule.id, match.node.getSourceFile().getLineAndCharacterOfPosition(match.node.getStart()).line + 1, Object.fromEntries(Object.entries(match.captures).map(([name, value]) => [name, captureValue(value)]))]);
const ids = (text: string, path?: string) => matches(text, path).map(([id, line]) => `${id}@${line}`);

describe("rule compilation", () => {
  it("compiles to canonical data with a stable digest, instance targets first", () => {
    const again = compileRules([{ path: "test.yaml", text: RULES }]);
    expect(again.ok && again.digest).toBe(compiled.digest);
    const order = compiled.rules.map((rule) => rule.id);
    expect(order.indexOf("services.axios-create")).toBeLessThan(order.indexOf("services.axios-instance-call"));
    expect(Object.getPrototypeOf(compiled.rules[0])).toBeNull();
  });

  it("changes the digest when a rule changes", () => {
    const changed = compileRules([{ path: "test.yaml", text: RULES.replace("Direct fetch calls", "Direct fetch requests") }]);
    expect(changed.ok && changed.digest).not.toBe(compiled.digest);
  });

  const problemsOf = (text: string) => {
    const result = compileRules([{ path: "bad.yaml", text }]);
    return result.ok ? [] : result.problems;
  };
  const rule = (body: string) => `format: 1\nrules:\n  - id: test.rule\n    version: 1\n    description: A test rule\n${body}`;

  it.each([
    ["an unknown match kind", rule("    match: { selector: 'CallExpression[callee.name=fetch]' }\n    emit: { signal: { kind: x } }\n"), "match"],
    ["code in an identifier", rule("    match: { call: { global: '() => fetch' } }\n    emit: { signal: { kind: x } }\n"), "must be a plain identifier"],
    ["a YAML function tag", rule("    match: { call: { global: !!js/function 'function () { return fetch }' } }\n    emit: { signal: { kind: x } }\n"), "must be a plain identifier"],
    ["a pattern in an identifier", rule("    match: { call: { global: 'fe.*' } }\n    emit: { signal: { kind: x } }\n"), "must be a plain identifier"],
    ["a pattern field", rule("    match: { call: { global: fetch, pattern: '/fetch/' } }\n    emit: { signal: { kind: x } }\n"), "Unrecognized key"],
    ["a module name built like a pattern", rule("    match: { import: { module: 'axi(os|x)' } }\n    emit: { signal: { kind: x } }\n"), "package name"],
    ["two callee roots", rule("    match: { call: { global: fetch, module: axios } }\n    emit: { signal: { kind: x } }\n"), "exactly one of"],
    ["anyReceiver without methods", rule("    match: { call: { anyReceiver: true } }\n    emit: { signal: { kind: x } }\n"), "method list"],
    ["an unknown capture kind", rule("    match: { call: { global: fetch } }\n    capture: { url: { expression: 'args[0]' } }\n    emit: { signal: { kind: x } }\n"), "capture.url"],
    ["an inferred fact without reasoning", rule("    match: { call: { global: fetch } }\n    emit: { fact: { category: composition, key: k, value: v, basis: inferred } }\n"), "inferred facts need reasoning"],
    ["a condition on an undefined capture", rule("    match: { call: { global: fetch } }\n    where: [{ capture: url, equals: x }]\n    emit: { signal: { kind: x } }\n"), "tests capture url"],
    ["an instance of an unknown rule", rule("    match: { call: { instanceOf: services.missing, method: [get] } }\n    emit: { signal: { kind: x } }\n"), "unknown rule services.missing"],
    ["an unsupported format", "format: 2\nrules: []\n", "format"],
    ["invalid YAML", "format: 1\nrules: [\n", "Invalid YAML"],
  ])("rejects %s", (_name, text, message) => {
    expect(problemsOf(text).join("\n")).toContain(message);
  });

  it("rejects duplicate ids and instance cycles", () => {
    const duplicate = `format: 1\nrules:\n  - { id: a.b, version: 1, description: x, match: { call: { global: f } }, emit: { signal: { kind: x } } }\n  - { id: a.b, version: 1, description: x, match: { call: { global: g } }, emit: { signal: { kind: x } } }\n`;
    expect(problemsOf(duplicate)).toContain("rule a.b is defined 2 times");
    const cycle = `format: 1\nrules:\n  - { id: a.one, version: 1, description: x, match: { call: { instanceOf: a.two, method: [m] } }, emit: { signal: { kind: x } } }\n  - { id: a.two, version: 1, description: x, match: { call: { instanceOf: a.one, method: [m] } }, emit: { signal: { kind: x } } }\n`;
    expect(problemsOf(cycle).join("\n")).toContain("instanceOf cycle");
  });

  it("reports every problem across every file together", () => {
    const result = compileRules([
      { path: "one.yaml", text: "format: 1\nrules: [\n" },
      { path: "two.yaml", text: "format: 1\nrules:\n  - { id: bad, version: 1, description: x, match: { call: { global: f } }, emit: { signal: { kind: x } } }\n" },
    ]);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.problems.map((problem) => problem.split(":")[0])).toEqual(["one.yaml", "two.yaml"]);
  });
});

describe("rule matching", () => {
  it("never matches calls inside comments or strings", () => {
    expect(ids('// fetch("https://a.example.test")\n/* new webpack.container.ModuleFederationPlugin({}) */\nconst s = "fetch(\'x\')";\nconst t = `registerApplication(${1})`;\n')).toEqual([]);
  });

  it("matches globals directly and through globalThis, window, and self", () => {
    expect(ids('fetch("/a");\nglobalThis.fetch("/b");\nwindow.fetch("/c");\nself.fetch("/d");\n')).toEqual(["services.fetch@1", "services.fetch@2", "services.fetch@3", "services.fetch@4"]);
  });

  it("treats a global name bound anywhere in the file as never the global, since bindings are not scoped", () => {
    // Only calls through globalThis still match; the bare call might refer to the parameter.
    expect(ids('fetch("/a");\nglobalThis.fetch("/b");\nfunction local(fetch) { return fetch("/e"); }\n')).toEqual(["services.fetch@2"]);
  });

  it("resolves module bindings through default, namespace, aliased, and CommonJS imports", () => {
    const text = [
      'import ax from "axios";',
      'import * as spa from "single-spa";',
      'import { registerApplication as register } from "single-spa";',
      'const webpack = require("webpack");',
      'const { ModuleFederationPlugin } = require("@rspack/core").container;',
      'ax.get("/orders");',
      'spa.registerApplication({ name: "@acme/orders" });',
      'register({ name: "@acme/reports" });',
      'new webpack.container.ModuleFederationPlugin({ name: "shell" });',
      'new ModuleFederationPlugin({ name: "admin" });',
      'new (require("webpack").container.ModuleFederationPlugin)({ name: "inline" });',
    ].join("\n");
    expect(ids(text, "webpack.config.js")).toEqual([
      "services.axios-call@6",
      "architecture.single-spa@7",
      "architecture.single-spa@8",
      "architecture.module-federation@9",
      "architecture.module-federation@10",
      "architecture.module-federation@11",
    ]);
  });

  it("does not resolve a name that is bound more than once", () => {
    const text = 'import { registerApplication } from "single-spa";\nfunction boot(registerApplication) { registerApplication({ name: "x" }); }\nregisterApplication({ name: "y" });\n';
    expect(ids(text)).toEqual([]);
  });

  it("tracks const instances created by another rule, but not reassignable ones", () => {
    const text = 'import axios from "axios";\nconst api = axios.create({ baseURL: "https://api.example.test" });\napi.get("/orders");\nlet other = axios.create();\nother.get("/nope");\n';
    expect(matches(text)).toEqual([
      ["services.axios-create", 2, { baseURL: { kind: "literal", value: "https://api.example.test" }, method: { kind: "literal", value: "create" } }],
      ["services.axios-instance-call", 3, { path: { kind: "literal", value: "/orders" }, method: { kind: "literal", value: "get" } }],
      ["services.axios-create", 4, { baseURL: { kind: "absent" }, method: { kind: "literal", value: "create" } }],
    ]);
  });

  it("captures literals, configuration keys, templates, and computed values as unresolved", () => {
    const text = [
      "const BASE = process.env.ORDERS_API;",
      'fetch(`${BASE}/orders`, { method: "POST" });',
      "fetch(buildUrl(), options);",
      'fetch("/plain");',
      "fetch(...args);",
    ].join("\n");
    expect(matches(text).map(([, , captures]) => captures)).toEqual([
      { url: { kind: "template", parts: [{ kind: "configured", source: "process.env", key: "ORDERS_API" }, { kind: "text", value: "/orders" }] }, method: { kind: "literal", value: "POST" } },
      { url: { kind: "unresolved", reason: "computed", detail: "The value is computed at runtime" }, method: { kind: "unresolved", reason: "unbound", detail: "options is not bound in this file" } },
      { url: { kind: "literal", value: "/plain" }, method: { kind: "absent" } },
      { url: { kind: "unresolved", reason: "computed", detail: "Arguments come from a spread" }, method: { kind: "unresolved", reason: "computed", detail: "Arguments come from a spread" } },
    ]);
  });

  it("captures JSX attributes, tagged templates, and import specifiers, and applies conditions", () => {
    const text = [
      'import gql from "graphql-tag";',
      'import { http } from "msw";',
      "const ORIGIN = 'http://127.0.0.1:9103';",
      'export const Frame = () => <iframe src={ORIGIN} title="legacy" />;',
      "export const Query = gql`query Orders { orders { id } }`;",
      'window.addEventListener("message", onMessage);',
      'window.addEventListener("click", onClick);',
    ].join("\n");
    expect(matches(text)).toEqual([
      ["services.msw", 2, { module: { kind: "literal", value: "msw" } }],
      ["architecture.iframe", 4, { src: { kind: "literal", value: "http://127.0.0.1:9103" } }],
      ["services.graphql", 5, { document: { kind: "literal", value: "query Orders { orders { id } }" } }],
      ["architecture.message-listener", 6, { event: { kind: "literal", value: "message" }, method: { kind: "literal", value: "addEventListener" } }],
    ]);
  });

  it("tests the kind of a captured value", () => {
    const result = compileRules([{ path: "kind.yaml", text: "format: 1\nrules:\n  - id: t.object\n    version: 1\n    description: x\n    match: { call: { global: register } }\n    capture: { first: { argument: 0 } }\n    where: [{ capture: first, is: object }]\n    emit: { signal: { kind: object } }\n  - id: t.string\n    version: 1\n    description: x\n    match: { call: { global: register } }\n    capture: { first: { argument: 0 } }\n    where: [{ capture: first, is: string }]\n    emit: { signal: { kind: string } }\n" }]);
    if (!result.ok) throw new Error(result.problems.join("\n"));
    const found = matchRules(tree('register({ name: "a" });\nregister("b", app);\nregister(compute());\n'), result.rules).map((match) => match.rule.id);
    expect(found).toEqual(["t.object", "t.string"]);
  });

  it("redacts credentials in captured strings", () => {
    const [[, , captures]] = matches('fetch("https://deploy:s3cr3t@api.example.test/orders");') as [[string, number, Record<string, unknown>]];
    expect(captures.url).toEqual({ kind: "literal", value: "https://[redacted]@api.example.test/orders" });
  });
});

describe("rule detectors", () => {
  const rules = compiled.rules.filter((rule) => rule.id.startsWith("architecture."));
  const detector = (onMatch?: Parameters<typeof ruleDetector>[0]["onMatch"]): Detector =>
    ruleDetector({ id: "architecture-rules", version: "1", stage: "architecture", rules, sources: (context) => context.reader.files().map((entry) => entry.path).filter((path) => /\.(tsx?|jsx?)$/.test(path)), ...(onMatch && { onMatch }) });

  it("emits facts and references from templates with evidence, and searches every file it parsed", async () => {
    const signals: string[] = [];
    const reader = MemoryReader.fromFiles(
      {
        "src/root-config.ts": 'import { registerApplication } from "single-spa";\nregisterApplication({ name: "@acme/orders" });\nregisterApplication({ name: appName() });\n',
        "src/Frame.tsx": 'export const Frame = () => <iframe src="http://127.0.0.1:9103" />;\nexport const Dynamic = () => <iframe src={url()} />;\n',
        "src/listen.ts": 'window.addEventListener("message", () => {});\n',
        "src/broken.ts": "export const = ;\n",
      },
      { commit: "a".repeat(40) },
    );
    const document = await runDetectors({ reader, detectorRelease: "0.1.0", detectors: [detector((_context, match) => void ("signal" in match.rule.emit && signals.push(`${match.rule.id}:${match.tree.path}`)))] });
    expect(factDocumentProblems(document)).toEqual([]);
    const composition = document.categories.composition!;
    expect(composition.facts.map((fact) => [fact.key, fact.value])).toEqual([
      ["single-spa:@acme/orders", { mechanism: "single-spa", application: { kind: "literal", value: "@acme/orders" } }],
      // An unresolved key falls back to the match location.
      ["src/root-config.ts:3", { mechanism: "single-spa", application: { kind: "unresolved", reason: "computed", detail: "The value is computed at runtime" } }],
    ]);
    expect(document.evidence[composition.facts[0]!.evidence[0]!]).toMatchObject({ path: "src/root-config.ts", rule: "architecture.single-spa", location: { kind: "lines", start: 2, end: 2 } });
    expect(document.relationship_references.map((reference) => [reference.type, reference.role, reference.identifier])).toEqual([["iframe", "embedder", { url: "http://127.0.0.1:9103" }]]);
    expect(document.diagnostics).toContainEqual(expect.objectContaining({ path: "src/Frame.tsx", reason: "unresolved_reference", detector: "architecture-rules" }));
    expect(signals).toEqual(["architecture.message-listener:src/listen.ts"]);
    expect(composition.search).toEqual({ rules: ["architecture-rules"], surface: ["src/Frame.tsx", "src/broken.ts", "src/listen.ts", "src/root-config.ts"], complete: true, skipped: ["src/broken.ts"] });
    expect(composition.state).toBe("observed");
  });

  it("carries only data: compiled rules contain no functions", () => {
    const walk = (value: unknown): boolean => (typeof value === "function" ? false : value && typeof value === "object" ? Object.values(value).every(walk) : true);
    expect(compiled.rules.every((rule: Rule) => walk(rule))).toBe(true);
  });
});
