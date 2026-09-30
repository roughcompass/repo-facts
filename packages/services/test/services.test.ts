import { type FactDocument, MemoryReader, type MemoryFile, type ServiceDependency, factDocumentProblems, runDetectors } from "@repo-facts/contract";
import { CORE_DETECTORS } from "@repo-facts/core";
import { describe, expect, it } from "vitest";
import { SERVICE_DETECTORS } from "../src/index.js";

async function profile(files: Record<string, MemoryFile>) {
  const reader = MemoryReader.fromFiles(files, { commit: "a".repeat(40) });
  const document = await runDetectors({ reader, detectorRelease: "0.1.0", detectors: [...CORE_DETECTORS, ...SERVICE_DETECTORS] });
  expect(factDocumentProblems(document)).toEqual([]);
  return document;
}

const service = (document: FactDocument, key: string): ServiceDependency => {
  const found = document.service_dependencies.find((item) => item.key === key);
  if (!found) throw new Error(`No service ${key}; found ${document.service_dependencies.map((item) => item.key).join(", ")}`);
  return found;
};
const state = (dependency: ServiceDependency, fact: keyof ServiceDependency) => [(dependency[fact] as { state: string }).state, (dependency[fact] as { value: unknown }).value];
const callSiteLines = (document: FactDocument, dependency: ServiceDependency) => dependency.call_sites.map((id) => `${document.evidence[id]!.path}:${(document.evidence[id]!.location as { start: number }).start}`).sort();

describe("HTTP clients", () => {
  it("reports a fetch call's endpoint, operation, request shape, consumed fields, timeout, and authentication", async () => {
    const document = await profile({
      "src/orders.ts": [
        'const BASE = "https://api.example.test";',
        "export async function reserve(id: string) {",
        "  const response = await fetch(`${BASE}/orders/${id}/reserve`, {",
        '    method: "POST",',
        "    body: JSON.stringify({ quantity: 1, note: '' }),",
        "    signal: AbortSignal.timeout(5000),",
        "    headers: { Authorization: `Bearer ${process.env.ORDERS_TOKEN}` },",
        "  });",
        "  const data = await response.json();",
        "  return { status: data.status, eta: data.eta };",
        "}",
        "",
      ].join("\n"),
    });
    const orders = service(document, "https://api.example.test");
    expect(orders.client).toEqual({ kind: "fetch", package: null });
    expect(state(orders, "identity")).toEqual(["observed", { kind: "origin", value: "https://api.example.test" }]);
    expect(state(orders, "protocol")).toEqual(["observed", "http"]);
    expect(state(orders, "endpoint")).toEqual(["observed", { derivation: "literal", origin: "https://api.example.test" }]);
    expect(state(orders, "operations")).toEqual(["observed", [{ method: "POST", path: "/orders/{param}/reserve" }]]);
    expect(state(orders, "request_shape")).toEqual(["observed", [{ operation: { method: "POST", path: "/orders/{param}/reserve" }, fields: ["note", "quantity"] }]]);
    expect(state(orders, "consumed_response_fields")).toEqual(["observed", ["eta", "status"]]);
    expect(state(orders, "timeout")).toEqual(["observed", { ms: 5000 }]);
    expect(state(orders, "authentication")).toEqual(["observed", [{ header: "Authorization", value_source: { kind: "template" } }]]);
    expect(callSiteLines(document, orders)).toEqual(["src/orders.ts:3"]);
    expect(orders.characterizable).toBe(true);
    expect(orders.access).toMatchObject({ state: "unknown" });
    expect(JSON.stringify(document)).not.toContain("ORDERS_TOKEN_VALUE");
  });

  it("applies an axios instance's base URL, timeout, and axios-retry configuration to its requests", async () => {
    const document = await profile({
      "src/billing.ts": [
        'import axios from "axios";',
        'import axiosRetry from "axios-retry";',
        'const api = axios.create({ baseURL: "https://billing.example.test/v1", timeout: 3000 });',
        "axiosRetry(api, { retries: 3 });",
        'export async function invoices() { const { data } = await api.get("/invoices"); return data.items; }',
        'export const create = (amount: number) => api.post("/invoices", { amount, currency: "EUR" });',
        "",
      ].join("\n"),
    });
    const billing = service(document, "https://billing.example.test");
    expect(state(billing, "endpoint")).toEqual(["observed", { derivation: "literal", origin: "https://billing.example.test", base_path: "/v1" }]);
    expect(state(billing, "operations")).toEqual(["observed", [{ method: "GET", path: "/v1/invoices" }, { method: "POST", path: "/v1/invoices" }]]);
    expect(state(billing, "request_shape")).toEqual(["observed", [{ operation: { method: "POST", path: "/v1/invoices" }, fields: ["amount", "currency"] }]]);
    expect(state(billing, "timeout")).toEqual(["observed", { ms: 3000 }]);
    expect(state(billing, "retry")).toEqual(["observed", { retries: 3 }]);
    // The create() response is not read, so consumed fields are only partly known.
    expect(state(billing, "consumed_response_fields")).toEqual(["unknown", { known: ["items"] }]);
    expect(billing.characterizable).toBe(false);
    expect(billing.missing_evidence).toContain("consumed_response_fields");
  });

  it("reports direct axios calls and calls with a configuration object", async () => {
    const document = await profile({ "src/a.ts": 'import axios from "axios";\naxios.delete("https://files.example.test/tmp/1");\naxios({ url: "https://files.example.test/upload", method: "put", data: { name: "x" } });\n' });
    expect(state(service(document, "https://files.example.test"), "operations")).toEqual(["observed", [{ method: "DELETE", path: "/tmp/1" }, { method: "PUT", path: "/upload" }]]);
  });
});

describe("other client kinds", () => {
  it("reports WebSocket and server-sent event connections", async () => {
    const document = await profile({ "src/live.ts": 'export const socket = new WebSocket("wss://events.example.test/stream");\nexport const feed = new EventSource("/api/feed", { withCredentials: true });\n' });
    expect(state(service(document, "websocket:wss://events.example.test"), "operations")).toEqual(["observed", [{ kind: "connect", path: "/stream" }]]);
    const feed = service(document, "sse:same-origin:/api");
    expect(feed.client.kind).toBe("event_source");
    expect(state(feed, "operations")).toEqual(["observed", [{ kind: "stream", path: "/api/feed" }]]);
    expect(state(feed, "authentication")).toEqual(["observed", [{ credentials: "include" }]]);
  });

  it("attributes GraphQL documents to the only GraphQL client, as an inference", async () => {
    const document = await profile({
      "src/graph.ts": 'import { ApolloClient, gql } from "@apollo/client";\nexport const client = new ApolloClient({ uri: "https://graph.example.test/graphql" });\n',
      "src/queries.ts": 'import { gql } from "@apollo/client";\nexport const ORDERS = gql`query Orders { orders { id } }`;\nexport const CANCEL = gql`mutation CancelOrder($id: ID!) { cancel(id: $id) }`;\n',
    });
    const graph = service(document, "graphql:https://graph.example.test");
    expect(graph.client.kind).toBe("graphql");
    expect(graph.operations).toMatchObject({ state: "inferred", value: [{ operation: "mutation CancelOrder" }, { operation: "query Orders" }], reasoning: expect.stringContaining("only GraphQL client") });
  });

  it("reports requests through a generated OpenAPI client", async () => {
    const document = await profile({ "src/api.ts": 'import createClient from "openapi-fetch";\nconst client = createClient({ baseUrl: process.env.CATALOG_API });\nexport const items = () => client.GET("/items", {});\n' });
    const catalog = service(document, "config:process.env:CATALOG_API");
    expect(catalog.client.kind).toBe("generated");
    expect(state(catalog, "operations")).toEqual(["observed", [{ method: "GET", path: "/items" }]]);
  });

  it("recognizes a packaged client configured with an endpoint, as an inference", async () => {
    const document = await profile({ "src/analytics.ts": 'import { init } from "@acme/analytics";\ninit({ appId: "mf-admin", endpoint: "/__analytics" });\n' });
    const analytics = service(document, "package:@acme/analytics");
    expect(analytics.client).toEqual({ kind: "packaged", package: "@acme/analytics" });
    expect(analytics.identity).toMatchObject({ state: "inferred", value: { kind: "package", value: "@acme/analytics" }, reasoning: expect.stringContaining("packaged service clients") });
    expect(state(analytics, "endpoint")).toEqual(["observed", { derivation: "relative", base_path: "/__analytics" }]);
    expect(state(analytics, "operations")[0]).toBe("unknown");
  });

  it("reports calls through a host-provided client in a single-spa lifecycle", async () => {
    const document = await profile({ "src/lifecycles.ts": 'export async function mount(props) {\n  await props.api.get("/reports");\n}\n' });
    const host = service(document, "host:props.api");
    expect(host.client.kind).toBe("host_adapter");
    expect(host.endpoint).toMatchObject({ state: "inferred", value: { derivation: "host_provided", expression: "props.api" } });
    expect(state(host, "operations")).toEqual(["observed", [{ method: "GET", path: "/reports", method_source: "adapter" }]]);
  });
});

describe("endpoint derivation", () => {
  it.each<[string, string, string, unknown]>([
    ["a literal URL", 'fetch("https://a.example.test/x");', "https://a.example.test", ["observed", { derivation: "literal", origin: "https://a.example.test" }]],
    ["a template on a literal", 'const HOST = "https://b.example.test";\nfetch(`${HOST}/x`);', "https://b.example.test", ["observed", { derivation: "literal", origin: "https://b.example.test" }]],
    ["a configuration key, without its value", 'fetch(process.env.ORDERS_API + "/x");', "config:process.env:ORDERS_API", ["observed", { derivation: "configured", source: "process.env", key: "ORDERS_API" }]],
    ["a Vite configuration key", "fetch(`${import.meta.env.VITE_API}/x`);", "config:import.meta.env:VITE_API", ["observed", { derivation: "configured", source: "import.meta.env", key: "VITE_API" }]],
    ["a relative path", 'fetch("/api/x");', "same-origin:/api", ["observed", { derivation: "relative" }]],
    ["a host-provided value", 'export async function mount(props) { await fetch(props.apiBase + "/orders"); }', "host:props.apiBase", ["inferred", { derivation: "host_provided", expression: "props.apiBase" }]],
  ])("derives an endpoint from %s", async (_name, source, key, endpoint) => {
    const document = await profile({ "src/a.ts": `${source}\n` });
    expect(state(service(document, key), "endpoint")).toEqual(endpoint);
  });

  it("reports cross-file and computed destinations as unknown, each its own dependency", async () => {
    const document = await profile({ "src/a.ts": 'import { API } from "./config";\nfetch(API);\nfetch(buildUrl("orders"));\n' });
    expect(document.service_dependencies.map((item) => item.key)).toEqual(["unresolved:src/a.ts:2", "unresolved:src/a.ts:3"]);
    expect(state(service(document, "unresolved:src/a.ts:2"), "endpoint")).toEqual(["unknown", { derivation: "unknown", reason: "imported", detail: "API is imported from another module" }]);
    expect(state(service(document, "unresolved:src/a.ts:3"), "endpoint")).toMatchObject(["unknown", { reason: "computed" }]);
    expect(service(document, "unresolved:src/a.ts:3").missing_evidence).toContain("endpoint");
    // No reference is made for a destination nobody knows.
    expect(document.relationship_references.filter((reference) => reference.type === "service")).toEqual([]);
  });

  it("never records configuration values or credentials", async () => {
    const document = await profile({ "src/a.ts": 'fetch("https://svc:p4ssw0rd@internal.example.test/x", { headers: { "X-API-Key": "k3y-literal" } });\n' });
    const text = JSON.stringify(document);
    expect(text).not.toContain("p4ssw0rd");
    expect(text).not.toContain("k3y-literal");
    expect(state(service(document, "https://[redacted]@internal.example.test"), "authentication")).toEqual(["observed", [{ header: "X-API-Key", value_source: { kind: "literal" } }]]);
  });
});

describe("logical identity", () => {
  it("merges call sites of one service across files and emits one reference", async () => {
    const document = await profile({ "src/a.ts": 'fetch("https://api.example.test/a");\n', "src/b.ts": 'fetch("https://api.example.test/b");\n' });
    const api = service(document, "https://api.example.test");
    expect(callSiteLines(document, api)).toEqual(["src/a.ts:1", "src/b.ts:1"]);
    expect(state(api, "operations")).toEqual(["observed", [{ method: "GET", path: "/a", method_source: "default" }, { method: "GET", path: "/b", method_source: "default" }]]);
    expect(document.relationship_references.filter((reference) => reference.type === "service").map((reference) => reference.identifier)).toEqual([{ key: "https://api.example.test" }]);
  });

  it("reports disagreeing call sites of one service as conflicts", async () => {
    const document = await profile({ "src/a.ts": 'fetch("https://api.example.test/a", { signal: AbortSignal.timeout(5000) });\nfetch("https://api.example.test/b");\n' });
    const api = service(document, "https://api.example.test");
    expect(api.timeout).toMatchObject({ state: "conflicting", candidates: [{ value: { ms: 5000 } }, { value: { ms: null } }] });
    expect(api.missing_evidence).toContain("timeout");
  });

  it("reports no timeout only when every call site's options are fully known", async () => {
    const document = await profile({ "src/a.ts": 'fetch("https://api.example.test/a");\nfetch("https://api.example.test/b", { method: "GET" });\n' });
    expect(service(document, "https://api.example.test").timeout).toMatchObject({ state: "absent", search: { complete: true, surface: ["src/a.ts"] } });
    const computed = await profile({ "src/a.ts": 'fetch("https://api.example.test/a", options);\n' });
    expect(service(computed, "https://api.example.test").timeout.state).toBe("unknown");
  });
});

describe("the fleet's analytics client", () => {
  const CLIENT = [
    "let configuration = null;",
    "export function init(options) {",
    "  configuration = options;",
    "}",
    "export async function track(name, properties) {",
    "  const response = await fetch(configuration.endpoint, { method: 'POST', body: JSON.stringify({ name, properties }) });",
    "  return response.ok;",
    "}",
    "",
  ].join("\n");

  it("reports an unknown endpoint in the client package itself", async () => {
    const document = await profile({ "packages/analytics/package.json": '{ "name": "@acme/analytics", "version": "1.0.0" }\n', "packages/analytics/src/index.js": CLIENT });
    const [dependency] = document.service_dependencies;
    expect(dependency!.key).toBe("unresolved:packages/analytics/src/index.js:6");
    expect(state(dependency!, "endpoint")).toEqual(["unknown", { derivation: "unknown", reason: "reassignable", detail: "configuration can be reassigned (reading endpoint)" }]);
    // The body is known even though the destination is not.
    expect(state(dependency!, "request_shape")).toEqual(["observed", [{ operation: { kind: "unresolved", detail: "The request path is not determined statically" }, fields: ["name", "properties"] }]]);
    expect(dependency!.characterizable).toBe(false);
  });

  it("reports the configured endpoint in a consumer", async () => {
    const document = await profile({ "src/useAnalytics.ts": 'import { init, track } from "@acme/analytics";\nexport function start(sessionId) {\n  init({ appId: "mf-admin", sessionId, endpoint: "/__analytics" });\n  track("admin-opened", {});\n}\n' });
    expect(document.service_dependencies.map((item) => item.key)).toEqual(["package:@acme/analytics"]);
    expect(state(service(document, "package:@acme/analytics"), "endpoint")).toEqual(["observed", { derivation: "relative", base_path: "/__analytics" }]);
  });
});
