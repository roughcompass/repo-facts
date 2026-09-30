import { type FactDocument, MemoryReader, type MemoryFile, type ServiceDependency, factDocumentProblems, runDetectors } from "@repo-facts/contract";
import { CORE_DETECTORS } from "@repo-facts/core";
import { describe, expect, it } from "vitest";
import { SERVICE_DETECTORS, classify, networkZone, pathsMatch } from "../src/index.js";

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
const values = (document: FactDocument, category: string) => Object.fromEntries(document.categories[category]!.facts.map((fact) => [fact.key, fact.state === "inferred" ? [fact.state, fact.value] : fact.value]));

describe("access signals", () => {
  it("reports credential, certificate, authentication, proxy, and gateway names, never their values", async () => {
    const document = await profile({
      "src/api.ts": [
        'import { PublicClientApplication } from "@azure/msal-browser";',
        "const token = import.meta.env.VITE_ORDERS_TOKEN;",
        'export const listOrders = () => fetch("https://orders.internal/v1/orders", { headers: { Authorization: `Bearer ${token}` } });',
        "export const ca = process.env.NODE_EXTRA_CA_CERTS;",
        "const { HTTPS_PROXY, API_GATEWAY_URL } = process.env;",
        'export const clientId = process.env["OIDC_CLIENT_ID"];',
        "export const version = process.env.APP_VERSION;",
        "export const msal = new PublicClientApplication({ auth: { clientId } });",
        "",
      ].join("\n"),
      Dockerfile: 'FROM node:24-alpine\nARG NPM_TOKEN\nENV API_SECRET="do-not-leak-1" \\\n    LOG_LEVEL=info\nENV SSL_CERT_FILE /etc/ssl/cert.pem\n',
      ".env.production": "API_SECRET=do-not-leak-2\n",
      "config/client.pem": "-----BEGIN PRIVATE KEY-----\ndo-not-leak-3\n",
    });

    expect(values(document, "access_signals")).toEqual({
      "file:.env.production": { kind: "credential_file", path: ".env.production", format: "env-file", label: "Environment file" },
      "file:config/client.pem": { kind: "credential_file", path: "config/client.pem", format: "private-key", label: "Key or certificate bundle" },
      "library:@azure/msal-browser": { kind: "authentication_library", module: "@azure/msal-browser" },
      "name:API_SECRET": { kind: "credential_reference", name: "API_SECRET", read_from: ["Dockerfile"] },
      "name:NODE_EXTRA_CA_CERTS": { kind: "certificate_reference", name: "NODE_EXTRA_CA_CERTS", read_from: ["process.env"] },
      "name:NPM_TOKEN": { kind: "credential_reference", name: "NPM_TOKEN", read_from: ["Dockerfile"] },
      "name:OIDC_CLIENT_ID": { kind: "authentication_configuration", name: "OIDC_CLIENT_ID", read_from: ["process.env"] },
      "name:SSL_CERT_FILE": { kind: "certificate_reference", name: "SSL_CERT_FILE", read_from: ["Dockerfile"] },
      "name:VITE_ORDERS_TOKEN": { kind: "credential_reference", name: "VITE_ORDERS_TOKEN", read_from: ["import.meta.env"] },
      "zone:https://orders.internal": ["inferred", { kind: "network_zone", origin: "https://orders.internal", zone: "internal_domain" }],
    });
    expect(values(document, "egress_routes")).toEqual({
      "name:API_GATEWAY_URL": { kind: "gateway_configuration", name: "API_GATEWAY_URL", read_from: ["process.env"] },
      "name:HTTPS_PROXY": { kind: "proxy_variable", name: "HTTPS_PROXY", read_from: ["process.env"] },
    });
    expect(document.categories.access_signals!.state).toBe("mixed");

    // The token is reported by its key name on the service it authenticates, and access stays unknown.
    const orders = service(document, "https://orders.internal");
    expect(orders.authentication).toMatchObject({ state: "observed", value: [{ header: "Authorization", value_source: { kind: "template", configured: [{ source: "import.meta.env", key: "VITE_ORDERS_TOKEN" }] } }] });
    expect(orders.access).toMatchObject({ state: "unknown", reason: expect.stringContaining("entitlement") });
    expect(JSON.stringify(document)).not.toContain("do-not-leak");
  });

  it("retains conflicting authentication signals as a conflict", async () => {
    const document = await profile({
      "src/a.ts": 'export const a = () => fetch("https://api.example.test/a", { headers: { Authorization: process.env.API_TOKEN } });\n',
      "src/b.ts": 'export const b = () => fetch("https://api.example.test/b", { credentials: "include" });\n',
    });
    const api = service(document, "https://api.example.test");
    expect(api.authentication).toMatchObject({
      state: "conflicting",
      candidates: [{ value: [{ credentials: "include" }] }, { value: [{ header: "Authorization", value_source: { kind: "configured", source: "process.env", key: "API_TOKEN" } }] }],
    });
    expect(api.missing_evidence).toContain("authentication");
    expect(api.access.state).toBe("unknown");
  });

  it("reports no access signal only after every source was searched", async () => {
    const clean = await profile({ "src/a.ts": 'export const a = () => fetch("https://api.example.test/a");\n' });
    expect(clean.categories.access_signals).toMatchObject({ state: "absent", search: { complete: true, skipped: [], surface: ["src/a.ts"] } });
    const broken = await profile({ "src/a.ts": 'export const a = () => fetch("https://api.example.test/a");\n', "src/b.ts": "export const = ;\n" });
    expect(broken.categories.access_signals).toMatchObject({ state: "unknown", search: { skipped: ["src/b.ts"] } });
  });

  it.each<[string, string | null]>([
    ["ORDERS_API_TOKEN", "credential_reference"],
    ["ordersApiKey", "credential_reference"],
    ["DB_PASSWORD", "credential_reference"],
    ["NODE_EXTRA_CA_CERTS", "certificate_reference"],
    ["SSL_CERT_FILE", "certificate_reference"],
    ["OIDC_CLIENT_ID", "authentication_configuration"],
    ["VITE_AUTH_AUTHORITY", "authentication_configuration"],
    ["HTTPS_PROXY", "proxy_variable"],
    ["no_proxy", "proxy_variable"],
    ["API_GATEWAY_URL", "gateway_configuration"],
    ["AUTHOR_NAME", null],
    ["KEYBOARD_LAYOUT", null],
    ["CACHE_TTL", null],
    ["APP_VERSION", null],
  ])("classifies %s by its words", (name, expected) => {
    expect(classify(name)).toBe(expected);
  });

  it.each<[string, string | null]>([
    ["http://localhost:3000", "loopback"],
    ["http://127.0.0.1", "loopback"],
    ["http://[::1]:8080", "loopback"],
    ["http://10.1.2.3", "private_address"],
    ["http://172.20.0.5:9000", "private_address"],
    ["http://172.32.0.1", null],
    ["https://orders.internal", "internal_domain"],
    ["https://api.example.com", null],
  ])("places %s in a network zone", (origin, zone) => {
    expect(networkZone(origin)).toBe(zone);
  });
});

describe("proxies and gateways", () => {
  it("records development proxy routes and ties them to same-origin services", async () => {
    const document = await profile({
      "vite.config.ts": 'import { defineConfig } from "vite";\nexport default defineConfig({\n  server: {\n    proxy: {\n      "/api": { target: "http://localhost:8080", changeOrigin: true },\n      "^/legacy/.*": "http://legacy.internal",\n    },\n  },\n});\n',
      "server/dev.ts": 'import express from "express";\nimport { createProxyMiddleware } from "http-proxy-middleware";\nconst app = express();\napp.use("/graphql", createProxyMiddleware({ target: "http://gateway.internal" }));\n',
      "src/orders.ts": 'export const list = () => fetch("/api/orders");\nexport const legacy = () => fetch("/legacy/report");\n',
      "deploy/nginx.conf": "server { location /api { proxy_pass http://orders; } }\n",
    });
    expect(values(document, "egress_routes")).toEqual({
      "dev-proxy:server/dev.ts:/graphql": { kind: "dev_proxy", route: "/graphql", target: { kind: "literal", value: "http://gateway.internal" }, configuration: "server/dev.ts" },
      "dev-proxy:vite.config.ts:/api": { kind: "dev_proxy", route: "/api", target: { kind: "literal", value: "http://localhost:8080" }, configuration: "vite.config.ts" },
      "dev-proxy:vite.config.ts:^/legacy/.*": { kind: "dev_proxy", route: "^/legacy/.*", target: { kind: "literal", value: "http://legacy.internal" }, configuration: "vite.config.ts" },
      "gateway-file:deploy/nginx.conf": { kind: "gateway_configuration_file", path: "deploy/nginx.conf", server: "nginx", rules: "not_analyzed" },
    });
    // The gateway's own rules are not analyzed, so the search is not bounded.
    expect(document.categories.egress_routes!.search.skipped).toEqual(["deploy/nginx.conf"]);

    expect(service(document, "same-origin:/api").proxy).toMatchObject({ state: "observed", value: { kind: "dev_proxy", route: "/api", configuration: "vite.config.ts" } });
    // A pattern route is recorded but never interpreted, and no route is never a bounded absence.
    expect(service(document, "same-origin:/legacy").proxy).toMatchObject({ state: "unknown", rule: "not-established" });
  });

  it("does not record proxy routes it cannot read", async () => {
    const document = await profile({ "vite.config.ts": 'import { defineConfig } from "vite";\nimport { routes } from "./routes";\nexport default defineConfig({ server: { proxy: routes } });\n' });
    expect(document.categories.egress_routes).toMatchObject({ state: "unknown", facts: [], search: { skipped: ["vite.config.ts"] } });
    expect(document.diagnostics).toContainEqual(expect.objectContaining({ path: "vite.config.ts", reason: "unsupported_value", detector: "service-signals" }));
  });
});

describe("API contracts", () => {
  const orders = "openapi: 3.1.0\ninfo:\n  title: Orders\n  version: 1.0.0\nservers:\n  - url: https://api.example.test\npaths:\n  /orders:\n    get: {}\n";

  it("ties a document by its server origin, and records none only when every document is ruled out", async () => {
    const document = await profile({
      "openapi.yaml": orders,
      "src/a.ts": 'export const a = () => fetch("https://api.example.test/orders");\n',
      "src/b.ts": 'export const b = () => fetch("https://other.example.test/x");\n',
    });
    expect(values(document, "api_contracts")).toEqual({ "openapi.yaml": { kind: "openapi", path: "openapi.yaml", version: "3.1.0", title: "Orders", servers: ["https://api.example.test"], operations: 1 } });
    expect(service(document, "https://api.example.test").contracts).toMatchObject({ state: "observed", value: [{ kind: "openapi", path: "openapi.yaml", association: "server_origin" }] });
    expect(service(document, "https://other.example.test").contracts).toMatchObject({ state: "absent", search: { complete: true, skipped: [] } });
  });

  it("ties a document whose operations match a request under its server base path", async () => {
    const document = await profile({
      "openapi.yaml": "openapi: 3.0.3\ninfo: { title: Orders, version: '1' }\nservers:\n  - url: /api\npaths:\n  /orders/{id}:\n    get: {}\n",
      "src/a.ts": "export const a = (id: string) => fetch(`/api/orders/${id}`);\n",
    });
    expect(service(document, "same-origin:/api").contracts).toMatchObject({ state: "observed", value: [{ kind: "openapi", path: "openapi.yaml", association: "operation_paths" }] });
  });

  it("infers the only document for a generated client, and reports competing documents as a conflict", async () => {
    const client = 'import createClient from "openapi-fetch";\nconst client = createClient({ baseUrl: import.meta.env.VITE_BILLING });\nexport const billing = (route: string) => client.GET(route);\n';
    const invoices = "openapi: 3.1.0\ninfo: { title: Billing, version: '1' }\npaths:\n  /invoices:\n    get: {}\n";
    const single = await profile({ "src/billing.ts": client, "contracts/billing.openapi.yaml": invoices });
    expect(service(single, "config:import.meta.env:VITE_BILLING").contracts).toMatchObject({ state: "inferred", value: [{ kind: "openapi", path: "contracts/billing.openapi.yaml", association: "generated_client" }], reasoning: expect.stringContaining("generated from an OpenAPI document") });

    const competing = await profile({ "src/billing.ts": client, "contracts/billing.openapi.yaml": invoices, "contracts/payments.openapi.yaml": invoices.replace("/invoices", "/payments") });
    const billing = service(competing, "config:import.meta.env:VITE_BILLING");
    expect(billing.contracts).toMatchObject({ state: "conflicting", candidates: [{ value: [{ path: "contracts/billing.openapi.yaml" }] }, { value: [{ path: "contracts/payments.openapi.yaml" }] }] });
    expect(billing.missing_evidence).toContain("contracts");
  });

  it("ties a generated schema imported where the service is called", async () => {
    const document = await profile({
      "src/schema.d.ts": "/**\n * This file was auto-generated by openapi-typescript.\n * Do not make direct changes to the file.\n */\nexport interface paths {}\n",
      "src/api.ts": 'import createClient from "openapi-fetch";\nimport type { paths } from "./schema";\nconst client = createClient<paths>({ baseUrl: "https://api.example.test" });\nexport const list = () => client.GET("/orders");\n',
    });
    expect(values(document, "api_contracts")).toEqual({ "src/schema.d.ts": { kind: "generated_schema", path: "src/schema.d.ts", generator: "openapi-typescript", contract: "openapi" } });
    expect(service(document, "https://api.example.test").contracts).toMatchObject({ state: "observed", value: [{ kind: "generated_schema", path: "src/schema.d.ts", association: "imported_at_call_site" }] });
  });

  it("infers a committed GraphQL schema for the only GraphQL service", async () => {
    const document = await profile({
      "schema.graphql": "# The order graph\ntype Query {\n  orders: [Order!]!\n}\ntype Order {\n  id: ID!\n}\n",
      "src/queries.graphql": "query Orders {\n  orders { id }\n}\n",
      "src/graph.ts": 'import { ApolloClient } from "@apollo/client";\nexport const client = new ApolloClient({ uri: "https://graph.example.test/graphql" });\n',
    });
    expect(values(document, "api_contracts")).toEqual({
      "schema.graphql": { kind: "graphql_schema", path: "schema.graphql", definitions: 2, operations: [] },
      "src/queries.graphql": { kind: "graphql_operations", path: "src/queries.graphql", definitions: 0, operations: ["query Orders"] },
    });
    expect(service(document, "graphql:https://graph.example.test").contracts).toMatchObject({ state: "inferred", value: [{ kind: "graphql_schema", path: "schema.graphql", association: "only_graphql_service" }] });
  });

  it("leaves contracts unknown when a document cannot be read as a contract", async () => {
    const document = await profile({ "openapi.yaml": "title: not a contract\n", "src/a.ts": 'export const a = () => fetch("https://api.example.test/a");\n' });
    expect(service(document, "https://api.example.test").contracts).toMatchObject({ state: "unknown", value: { reason: "Some inputs could not be searched" } });
    expect(document.categories.api_contracts).toMatchObject({ state: "unknown", search: { skipped: ["openapi.yaml"] } });
    expect(document.diagnostics).toContainEqual(expect.objectContaining({ path: "openapi.yaml", reason: "unsupported_shape" }));
  });
});

describe("test substitutes", () => {
  it("ties interceptors by origin, path, and configuration key", async () => {
    const document = await profile({
      "src/api.ts": ['export const a = () => fetch("https://api.example.test/orders");', "export const b = (id: string) => fetch(`/api/orders/${id}`);", "export const c = () => fetch(`${import.meta.env.VITE_CATALOG}/items`);", 'export const d = () => fetch("/api/users");', ""].join("\n"),
      "src/api.test.ts": [
        'import { http, HttpResponse } from "msw";',
        'import { setupServer } from "msw/node";',
        'import nock from "nock";',
        "export const server = setupServer(",
        '  http.get("/api/orders/:id", () => HttpResponse.json({})),',
        "  http.get(`${import.meta.env.VITE_CATALOG}/items`, () => HttpResponse.json([])),",
        ");",
        'nock("https://api.example.test").get("/orders").reply(200, []);',
        "",
      ].join("\n"),
    });
    expect(service(document, "https://api.example.test").substitutes).toMatchObject({ state: "observed", value: [{ kind: "request_interceptor", library: "nock", association: "intercepted_origin" }] });
    expect(service(document, "same-origin:/api").substitutes).toMatchObject({ state: "observed", value: [{ kind: "request_interceptor", library: "msw", association: "intercepted_path" }] });
    expect(service(document, "config:import.meta.env:VITE_CATALOG").substitutes).toMatchObject({ state: "observed", value: [{ kind: "request_interceptor", association: "intercepted_configuration_key" }] });
    expect(values(document, "test_substitutes")["mock-server:src/api.test.ts:4"]).toEqual({ kind: "mock_server", library: "msw/node" });
  });

  it("ties module mocks of the calling module or the client package", async () => {
    const document = await profile({
      "src/orders.ts": 'export const list = () => fetch("https://orders.example.test/orders");\n',
      "src/billing.ts": 'import axios from "axios";\nexport const invoices = () => axios.get("https://billing.example.test/invoices");\n',
      "src/orders.test.ts": 'import { vi } from "vitest";\nvi.mock("./orders");\nvi.mock("./unrelated");\n',
      "src/unrelated.ts": "export const x = 1;\n",
      "src/billing.test.ts": 'jest.mock("axios");\njest.mock("lodash");\n',
    });
    expect(service(document, "https://orders.example.test").substitutes).toMatchObject({ state: "observed", value: [{ kind: "module_mock", module: "./orders", resolved: "src/orders.ts", association: "mocks_call_site_module" }] });
    expect(service(document, "https://billing.example.test").substitutes).toMatchObject({ state: "observed", value: [{ kind: "module_mock", module: "axios", association: "mocks_client_package" }] });
  });

  it("infers a global fetch stub and the fixtures its test imports, without claiming equivalence", async () => {
    const document = await profile({
      "src/profile.ts": 'export const load = () => fetch("/api/profile");\n',
      "src/profile.test.ts": 'import { vi } from "vitest";\nimport { load } from "./profile";\nimport profile from "./__fixtures__/profile.json";\nvi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(profile))));\nexport { load };\n',
      "src/__fixtures__/profile.json": '{ "name": "Ada" }\n',
    });
    const substitutes = service(document, "same-origin:/api").substitutes;
    expect(substitutes).toMatchObject({
      state: "inferred",
      value: [
        { kind: "fixture", path: "src/__fixtures__/profile.json", association: "imported_with_substitute" },
        { kind: "global_stub", global: "fetch", association: "global_fetch" },
      ],
    });
    expect((substitutes as { reasoning: string }).reasoning).toContain("not shown to answer them like the service");
    expect(values(document, "test_substitutes")["fixtures:src/__fixtures__"]).toEqual({ kind: "fixture_directory", path: "src/__fixtures__" });
  });

  it("reports no detected substitute only after a complete search that rules every candidate out", async () => {
    const files = { "src/a.ts": 'export const a = () => fetch("https://api.example.test/a");\n', "src/a.test.ts": 'import { http } from "msw";\nhttp.get("https://other.example.test/a", () => null);\n' };
    const ruledOut = await profile(files);
    expect(service(ruledOut, "https://api.example.test").substitutes).toMatchObject({ state: "absent", search: { complete: true, skipped: [], surface: ["src/a.test.ts", "src/a.ts"] } });

    // An alias could name any module, so it keeps the question open.
    const alias = await profile({ ...files, "src/b.test.ts": 'import { vi } from "vitest";\nvi.mock("@/api/client");\n' });
    expect(service(alias, "https://api.example.test").substitutes).toMatchObject({ state: "unknown", value: { reason: expect.stringContaining("could apply") } });

    const broken = await profile({ ...files, "src/c.test.ts": "it(\n" });
    expect(service(broken, "https://api.example.test").substitutes).toMatchObject({ state: "unknown", value: { reason: "Some inputs could not be searched" } });
  });

  it.each<[string, string, boolean]>([
    ["/orders/:id", "/orders/{param}", true],
    ["/orders/{id}", "/orders/42", true],
    ["/orders", "/orders/1", false],
    ["/api/*", "/api/orders/1", true],
    ["/api/*", "/other", false],
  ])("matches route %s against request %s", (pattern, path, expected) => {
    expect(pathsMatch(pattern, path)).toBe(expected);
  });
});
