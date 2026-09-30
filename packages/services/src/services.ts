import { type Detector, type DetectorContext, type Evidence, type ServiceCandidate, type ServiceFactCandidate, type Value, compareCodeUnits, redactCredentials } from "@repo-facts/contract";
import { inventoryOf } from "@repo-facts/core";
import { type MatchedRule, type StaticValue, type SyntaxTree, literalText, nodeEvidence, resolveValue, ruleDetector, syntaxOf, unwrap } from "@repo-facts/syntax";
import ts from "typescript";
import { RULES } from "./rules.generated.js";

/**
 * Outbound Service Dependencies, from syntax alone. Nothing here resolves a
 * hostname, opens a connection, or loads a schema.
 *
 * Every request found by a rule becomes a call site with an endpoint
 * derivation (literal, relative, configured by key, host-provided, or
 * unknown), an operation, and whatever request shape, consumed response
 * fields, timeout, and authentication its syntax states. Call sites are
 * grouped by logical identity: an origin, a configuration key, a host
 * contract, or a packaged client. A call site whose destination is unknown is
 * its own dependency, so unrelated calls are never merged on a guess.
 */

type ClientKind = ServiceCandidate["client"]["kind"];

/** Where a request goes. `path` is null when the request's own path is not determined statically. */
type Endpoint =
  | { kind: "literal"; origin: string; path: string | null }
  | { kind: "relative"; path: string | null }
  | { kind: "configured"; source: string; key: string; path: string | null }
  | { kind: "host_provided"; expression: string; path: string | null }
  | { kind: "unknown"; reason: string; detail: string; path: string | null };

type Setting = { state: "set"; value: Value } | { state: "none" } | { state: "unknown"; reason: string };

interface Site {
  /** The path the client is configured with, such as an axios baseURL's `/v1`, or a packaged client's endpoint path. */
  basePath: string | null;
  match: MatchedRule;
  client: ClientKind;
  pkg: string | null;
  protocol: string;
  endpoint: Endpoint;
  endpointEvidence: Evidence[];
  operation: Value;
  request: Setting;
  response: string[] | null;
  timeout: Setting;
  authentication: Setting;
  retries: Setting;
}

const LIFECYCLE_FUNCTIONS = new Set(["bootstrap", "mount", "update", "unmount"]);
/** Signals that create a client instance other rules' requests go through. */
const INSTANCE_SIGNALS = new Set(["axios-instance", "generated-client"]);
/** Rules that match a request itself, rather than a client's configuration. */
const REQUEST_RULES = new Set(["services.fetch", "services.axios.request", "services.axios.request-with-data", "services.axios.config-call", "services.axios.instance-request", "services.axios.instance-request-with-data", "services.generated.openapi-fetch-request", "services.graphql.request"]);
const ADAPTER_METHODS = new Set(["fetch", "get", "post", "put", "patch", "delete", "request", "query", "mutate", "send"]);
const AUTH_HEADERS = /^(authorization|proxy-authorization|x-api-key|api-key|x-auth-token|x-access-token)$/i;
/** Packages whose calls other rules already interpret; they are never treated as packaged clients. */
const INTERPRETED_PACKAGES = new Set(["axios", "axios-retry", "openapi-fetch", "@hey-api/client-fetch", "graphql-request", "@apollo/client", "@apollo/client/core", "graphql-tag", "single-spa", "react", "react-dom", "vite", "webpack", "@rspack/core"]);

export const serviceDependencyDetector: Detector = {
  id: "service-dependencies",
  version: "1",
  stage: "services",
  inputs: ["**/*.js", "**/*.jsx", "**/*.ts", "**/*.tsx", "**/*.mjs", "**/*.cjs"],
  categories: [],
  async run(context) {
    const matches: MatchedRule[] = [];
    await ruleDetector({ id: "service-rules", version: "1", stage: "services", rules: RULES, sources: (inner) => inventoryOf(inner).sources, onMatch: (_inner, match) => void matches.push(match) }).run(context);

    // Instances are created by these rules only; other rules can match the same node (a packaged-client rule matches `axios.create({ baseURL })`).
    const byNode = new Map<ts.Node, MatchedRule>(matches.filter((match) => "signal" in match.rule.emit && INSTANCE_SIGNALS.has(match.rule.emit.signal.kind)).map((match) => [match.node, match]));
    const retried = new Map<ts.Node, Setting>();
    for (const match of matches.filter((item) => item.rule.id === "services.axios-retry")) {
      const creation = creationOf(match.tree, (match.node as ts.CallExpression).arguments[0], byNode);
      const retries = match.captures.retries;
      if (creation) retried.set(creation.node, retries?.kind === "number" ? { state: "set", value: { retries: retries.value } } : { state: "unknown", reason: "The retry count is not a literal" });
    }

    const sites: Site[] = [];
    for (const match of matches) {
      if (!("service" in match.rule.emit)) continue;
      const site = siteOf(context, match, byNode, retried);
      if (site) sites.push(site);
    }
    for (const path of inventoryOf(context).sources) {
      const tree = await syntaxOf(context, path);
      if (tree) sites.push(...hostAdapterSites(context, tree));
    }
    const documents = matches.filter((match) => "signal" in match.rule.emit && match.rule.emit.signal.kind === "graphql-document");
    report(context, sites, documents);
  },
};

function siteOf(context: DetectorContext, match: MatchedRule, byNode: ReadonlyMap<ts.Node, MatchedRule>, retried: ReadonlyMap<ts.Node, Setting>): Site | null {
  const emit = match.rule.emit as Extract<MatchedRule["rule"]["emit"], { service: unknown }>;
  const { captures, tree } = match;
  const call = match.node as ts.CallExpression | ts.NewExpression;
  const client = emit.service.client;
  const protocolFact = emit.service.facts.protocol;
  const protocol = protocolFact && "literal" in protocolFact && typeof protocolFact.literal === "string" ? protocolFact.literal : "http";
  const pkg = client === "packaged" ? literalText(captures.calleeModule) : null;
  if (client === "packaged" && (pkg === null || INTERPRETED_PACKAGES.has(pkg))) return null;

  // Instance calls inherit the base URL, timeout, and headers their instance was created with.
  const creation = match.rule.id.includes("instance-request") || match.rule.id.endsWith("openapi-fetch-request") ? creationOf(tree, ts.isCallExpression(call) && ts.isPropertyAccessExpression(call.expression) ? call.expression.expression : undefined, byNode) : null;
  const base = captures.baseURL ?? creation?.captures.baseURL;
  const endpoint = deriveEndpoint(tree, base, captures.url);
  const configured = base && base.kind !== "undefined" ? derive(tree, base) : client === "packaged" && captures.url ? derive(tree, captures.url) : null;
  const basePath = configured && configured.path !== "/" ? configured.path : null;
  const endpointEvidence = [...new Set([captures.url, base].flatMap((value) => (value && value.node !== call && value.node.getSourceFile() === tree.file && value.kind !== "undefined" ? [nodeEvidence(context, tree, value.node, match.rule.id)] : [])))];

  const request = REQUEST_RULES.has(match.rule.id);
  const method = request ? methodOf(match) : null;
  const path = endpoint.path;
  const operation: Value =
    protocol === "websocket" || protocol === "sse"
      ? path === null
        ? { kind: "unresolved", detail: "The connection path is not determined statically" }
        : { kind: protocol === "websocket" ? "connect" : "stream", path }
      : !request
        ? { kind: "unresolved", detail: client === "packaged" ? "The packaged client makes its requests internally" : "The client's operations are not stated where it is created" }
        : method === null || path === null
          ? { kind: "unresolved", detail: method === null ? "The request method is not a literal" : "The request path is not determined statically" }
          : { method: method.method, path, ...(method.defaulted && { method_source: "default" }) };

  const headers = captures.headers ?? creation?.captures.headers;
  return {
    basePath,
    match,
    client,
    pkg,
    protocol,
    endpoint,
    endpointEvidence,
    operation,
    request: request ? requestShape(tree, match) : { state: "unknown", reason: "The request body is not stated where the client is configured" },
    response: request ? responseFields(tree, call, client) : null,
    timeout: timeoutOf(tree, match, creation),
    authentication: authenticationOf(headers, captures.credentials),
    retries: creation ? (retried.get(creation.node) ?? { state: "unknown", reason: "Retries could be added outside the call site" }) : { state: "unknown", reason: "Retries could be added outside the call site" },
  };
}

/** The rule match that created the instance an identifier refers to, through a same-file const. */
function creationOf(tree: SyntaxTree, receiver: ts.Node | undefined, byNode: ReadonlyMap<ts.Node, MatchedRule>): MatchedRule | null {
  if (!receiver) return null;
  const root = unwrap(receiver);
  if (!ts.isIdentifier(root)) return null;
  const binding = tree.binding(root.text);
  if (!binding?.constant) return null;
  let node = unwrap(binding.constant);
  if (ts.isAwaitExpression(node)) node = unwrap(node.expression);
  return byNode.get(node) ?? null;
}

function methodOf(match: MatchedRule): { method: string; defaulted: boolean } | null {
  const { captures, rule } = match;
  if (rule.id.startsWith("services.graphql")) return { method: "POST", defaulted: true };
  const explicit = captures.requestMethod;
  if (explicit && explicit.kind !== "undefined") return explicit.kind === "string" ? { method: explicit.value.toUpperCase(), defaulted: false } : null;
  const named = captures.method;
  if (named?.kind === "string") return { method: named.value.toUpperCase(), defaulted: false };
  // fetch and a configured axios call both default to GET.
  if (rule.id === "services.fetch") return captures.init === undefined || captures.init.kind === "undefined" || (captures.init.kind === "object" && captures.init.complete) ? { method: "GET", defaulted: true } : null;
  if (rule.id === "services.axios.config-call") return { method: "GET", defaulted: true };
  return { method: "POST", defaulted: true };
}

/** How a request's destination is derived; the path is kept for its operation. */
export function deriveEndpoint(tree: SyntaxTree, base: StaticValue | undefined, url: StaticValue | undefined): Endpoint {
  const own = url && url.kind !== "undefined" ? derive(tree, url) : null;
  if (!base || base.kind === "undefined") return own ?? { kind: "unknown", reason: "absent", detail: "The request names no destination", path: null };
  // An absolute URL ignores the base; otherwise the request's path is relative to it.
  if (own?.kind === "literal") return own;
  const origin = derive(tree, base);
  if (origin.kind === "unknown") return origin;
  const suffix = own === null ? "" : own.kind === "relative" ? own.path : null;
  return { ...origin, path: suffix === null || origin.path === null ? null : joinPath(origin.path, suffix) };
}

function derive(tree: SyntaxTree, value: StaticValue): Endpoint {
  if (value.kind === "string") return fromText(redactCredentials(value.value));
  if (value.kind === "configured") return { kind: "configured", source: value.source, key: value.key, path: "/" };
  if (value.kind === "template") {
    const [first, ...rest] = value.parts;
    const tail = rest.map((part) => (part.kind === "text" ? part.value : "{param}")).join("");
    if (first?.kind === "text") {
      const head = fromText(redactCredentials(first.value));
      return head.kind === "literal" || head.kind === "relative" ? { ...head, path: normalizePath((head.path ?? "") + tail) } : head;
    }
    if (first?.kind === "configured") return { kind: "configured", source: first.source, key: first.key, path: normalizePath(tail) };
    if (first?.kind === "unresolved") return hostProvided(tree, first, normalizePath(tail)) ?? { kind: "unknown", reason: first.reason, detail: first.detail, path: null };
  }
  if (value.kind === "unresolved") return hostProvided(tree, value, "/") ?? { kind: "unknown", reason: value.reason, detail: value.detail, path: null };
  return { kind: "unknown", reason: "unsupported", detail: `A ${value.kind} value is not a destination`, path: null };
}

function fromText(text: string): Endpoint {
  const absolute = /^((?:https?|wss?):\/\/[^/?#]+)([^?#]*)/i.exec(text);
  if (absolute) return { kind: "literal", origin: absolute[1]!.toLowerCase(), path: normalizePath(absolute[2]!) };
  return { kind: "relative", path: normalizePath(text.split(/[?#]/)[0]!) };
}

function normalizePath(path: string): string {
  const trimmed = path.split(/[?#]/)[0]!;
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function joinPath(base: string, suffix: string): string {
  if (!suffix || suffix === "/") return base || "/";
  return `${base.replace(/\/+$/, "")}/${suffix.replace(/^\/+/, "")}`;
}

/**
 * An endpoint read from a single-spa lifecycle's parameter comes from the host
 * that mounts the application: a host contract, not a guess.
 */
function hostProvided(tree: SyntaxTree, value: Extract<StaticValue, { kind: "unresolved" }>, path: string): Endpoint | null {
  if (value.reason !== "parameter") return null;
  let root: ts.Node = unwrap(value.node);
  while (ts.isPropertyAccessExpression(root) || ts.isElementAccessExpression(root)) root = unwrap(root.expression);
  if (!ts.isIdentifier(root)) return null;
  const declaration = tree.binding(root.text)?.declarations[0];
  const owner = declaration && ts.isParameter(declaration) ? declaration.parent : undefined;
  if (!owner || !LIFECYCLE_FUNCTIONS.has(functionName(owner) ?? "")) return null;
  return { kind: "host_provided", expression: tree.text(value.node), path };
}

function functionName(node: ts.Node): string | null {
  if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) && node.name) return node.name.text;
  if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)) return node.parent.name.text;
  if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) return node.name.text;
  return null;
}

/** Fields of the body a request sends; `none` when the call's arguments show there is no body. */
function requestShape(tree: SyntaxTree, match: MatchedRule): Setting {
  const { captures, rule } = match;
  if (rule.id === "services.fetch") {
    const init = (match.node as ts.CallExpression).arguments[1];
    if (!init) return { state: "none" };
    const literal = unwrap(init);
    if (!ts.isObjectLiteralExpression(literal)) return { state: "unknown", reason: "The request options are computed" };
    const body = literal.properties.find((property): property is ts.PropertyAssignment => ts.isPropertyAssignment(property) && ts.isIdentifier(property.name) && property.name.text === "body");
    if (!body) return literal.properties.some((property) => !ts.isPropertyAssignment(property)) ? { state: "unknown", reason: "The request options may include a body from a spread" } : { state: "none" };
    const expression = unwrap(body.initializer);
    const stringified = ts.isCallExpression(expression) && tree.text(expression.expression) === "JSON.stringify" && expression.arguments[0] ? resolveValue(tree, expression.arguments[0]) : resolveValue(tree, expression);
    return fieldsOf(stringified);
  }
  const data = captures.data;
  if (data === undefined || data.kind === "undefined") return { state: "none" };
  return fieldsOf(data);
}

function fieldsOf(value: StaticValue): Setting {
  if (value.kind === "object") return value.complete ? { state: "set", value: [...value.properties.keys()].sort(compareCodeUnits) } : { state: "unknown", reason: "The body may include fields from a spread" };
  return { state: "unknown", reason: value.kind === "unresolved" ? value.detail : `The body is a ${value.kind} value` };
}

/**
 * Response fields the code reads, followed through same-file consts:
 * `const res = await fetch(...)`, `const data = await res.json()`, then
 * `data.orders` or `const { orders } = data`; for axios, `res.data.orders` or
 * `const { data } = await api.get(...)`. Anything else is not established.
 */
function responseFields(tree: SyntaxTree, call: ts.Node, client: ClientKind): string[] | null {
  const response = boundResult(call);
  if (!response) return null;
  if (client === "fetch") {
    if (response.kind !== "name") return null;
    const parsed = findBoundCall(tree, response.name, "json");
    if (!parsed) return null;
    return parsed.kind === "keys" ? parsed.keys : readFields(tree, parsed.name);
  }
  if (client === "axios" || client === "generated") {
    // `const { data } = await api.get(...)`, or `const response = ...` read as `response.data.x`.
    if (response.kind === "keys") return response.names.data ? readFields(tree, response.names.data) : null;
    return readProperty(tree, response.name, "data");
  }
  return null;
}

type Bound = { kind: "name"; name: string } | { kind: "keys"; keys: string[]; names: Record<string, string> };

/** What the awaited result of +call+ is bound to: a const name, or destructured keys. */
function boundResult(call: ts.Node): Bound | null {
  let node: ts.Node = call;
  while (ts.isParenthesizedExpression(node.parent) || ts.isAwaitExpression(node.parent)) node = node.parent;
  const declaration = node.parent;
  if (!ts.isVariableDeclaration(declaration) || declaration.initializer !== node || !(ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const)) return null;
  if (ts.isIdentifier(declaration.name)) return { kind: "name", name: declaration.name.text };
  if (ts.isObjectBindingPattern(declaration.name)) {
    const names: Record<string, string> = {};
    for (const element of declaration.name.elements) {
      const key = element.propertyName && ts.isIdentifier(element.propertyName) ? element.propertyName.text : ts.isIdentifier(element.name) ? element.name.text : null;
      if (key && ts.isIdentifier(element.name)) names[key] = element.name.text;
    }
    return { kind: "keys", keys: Object.keys(names).sort(compareCodeUnits), names };
  }
  return null;
}

function findBoundCall(tree: SyntaxTree, receiver: string, method: string): Bound | null {
  let found: Bound | null = null;
  tree.walk((node) => {
    if (found) return false;
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === method && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === receiver) found = boundResult(node);
  });
  return tree.binding(receiver)?.kinds.length === 1 ? found : null;
}

/** Property names read from a const, one level deep, including destructuring from it. */
function readFields(tree: SyntaxTree, name: string): string[] | null {
  if (tree.binding(name)?.kinds.length !== 1) return null;
  const fields = new Set<string>();
  let escapes = false;
  tree.walk((node) => {
    if (!ts.isIdentifier(node) || node.text !== name) return;
    const parent = node.parent;
    // Declarations and member names are not uses of the value.
    if ((ts.isVariableDeclaration(parent) || ts.isBindingElement(parent) || ts.isParameter(parent)) && parent.name === node) return;
    if ((ts.isPropertyAccessExpression(parent) || ts.isPropertyAssignment(parent)) && parent.name === node) return;
    if (ts.isBindingElement(parent) && parent.propertyName === node) return;
    if (ts.isPropertyAccessExpression(parent) && parent.expression === node) fields.add(parent.name.text);
    else if (ts.isVariableDeclaration(parent) && parent.initializer === node && ts.isObjectBindingPattern(parent.name)) {
      for (const element of parent.name.elements) {
        const key = element.propertyName && ts.isIdentifier(element.propertyName) ? element.propertyName.text : ts.isIdentifier(element.name) ? element.name.text : null;
        if (key) fields.add(key);
      }
    } else escapes = true;
  });
  // A value passed along whole may be read anywhere, so its fields are not established.
  return escapes || fields.size === 0 ? null : [...fields].sort(compareCodeUnits);
}

/** `response.data.x` reads, or reads from a const bound to `response.data`. */
function readProperty(tree: SyntaxTree, name: string, property: string): string[] | null {
  if (tree.binding(name)?.kinds.length !== 1) return null;
  const fields = new Set<string>();
  let unknown = false;
  tree.walk((node) => {
    if (!ts.isIdentifier(node) || node.text !== name || !ts.isPropertyAccessExpression(node.parent) || node.parent.expression !== node) return;
    if (node.parent.name.text !== property) return;
    const outer = node.parent.parent;
    if (ts.isPropertyAccessExpression(outer) && outer.expression === node.parent) fields.add(outer.name.text);
    else unknown = true;
  });
  return unknown || fields.size === 0 ? null : [...fields].sort(compareCodeUnits);
}

function timeoutOf(tree: SyntaxTree, match: MatchedRule, creation: MatchedRule | null): Setting {
  const { captures, rule } = match;
  if (rule.id === "services.fetch") {
    const init = (match.node as ts.CallExpression).arguments[1];
    if (!init) return { state: "none" };
    const literal = unwrap(init);
    if (!ts.isObjectLiteralExpression(literal)) return { state: "unknown", reason: "The request options are computed" };
    const signal = literal.properties.find((property): property is ts.PropertyAssignment => ts.isPropertyAssignment(property) && ts.isIdentifier(property.name) && property.name.text === "signal");
    if (!signal) return literal.properties.some((property) => !ts.isPropertyAssignment(property)) ? { state: "unknown", reason: "The options may include a signal from a spread" } : { state: "none" };
    const expression = unwrap(signal.initializer);
    if (ts.isCallExpression(expression) && tree.text(expression.expression) === "AbortSignal.timeout" && expression.arguments[0]) {
      const ms = resolveValue(tree, expression.arguments[0]);
      return ms.kind === "number" && Number.isSafeInteger(ms.value) ? { state: "set", value: { ms: ms.value } } : { state: "unknown", reason: "The timeout is not a literal" };
    }
    return { state: "unknown", reason: "An abort signal may end the request" };
  }
  if (rule.id.startsWith("services.axios")) {
    for (const timeout of [captures.timeout, creation?.captures.timeout]) {
      if (!timeout || timeout.kind === "undefined") continue;
      return timeout.kind === "number" && Number.isSafeInteger(timeout.value) ? { state: "set", value: { ms: timeout.value } } : { state: "unknown", reason: "The timeout is not a literal" };
    }
    const configs = [captures.config, creation?.captures.config].filter((config): config is StaticValue => config !== undefined && config.kind !== "undefined");
    return configs.every((config) => config.kind === "object" && config.complete) ? { state: "none" } : { state: "unknown", reason: "The request configuration is computed" };
  }
  return { state: "unknown", reason: "This client's timeout is not stated at the call site" };
}

/** Authentication the call site states: credential headers by name and cookie credentials. Never values. */
function authenticationOf(headers: StaticValue | undefined, credentials: StaticValue | undefined): Setting {
  const signals: Value[] = [];
  if (headers?.kind === "object") {
    for (const [name, value] of [...headers.properties.entries()].sort(([a], [b]) => compareCodeUnits(a, b))) {
      if (!AUTH_HEADERS.test(name)) continue;
      const source = value.kind === "configured" ? { kind: "configured", source: value.source, key: value.key } : value.kind === "template" ? { kind: "template" } : value.kind === "string" ? { kind: "literal" } : { kind: "unresolved", reason: value.kind === "unresolved" ? value.reason : value.kind };
      signals.push({ header: name, value_source: source });
    }
  }
  if (credentials?.kind === "string" && credentials.value === "include") signals.push({ credentials: "include" });
  if (credentials?.kind === "boolean" && credentials.value) signals.push({ credentials: "include" });
  // Interceptors and wrappers can add credentials elsewhere, so no signal is not a bounded absence.
  return signals.length ? { state: "set", value: signals } : { state: "unknown", reason: "No authentication is stated at the call site" };
}

/**
 * Calls through a single-spa lifecycle's props, such as `props.api.get("/orders")`:
 * a client the host provides.
 */
function hostAdapterSites(context: DetectorContext, tree: SyntaxTree): Site[] {
  const sites: Site[] = [];
  tree.walk((node) => {
    if (!ts.isFunctionLike(node) || !LIFECYCLE_FUNCTIONS.has(functionName(node) ?? "")) return;
    const [parameter] = node.parameters;
    if (!parameter || !ts.isIdentifier(parameter.name)) return;
    const props = parameter.name.text;
    const body = "body" in node ? node.body : undefined;
    if (!body) return;
    const visit = (child: ts.Node) => {
      if (ts.isCallExpression(child)) {
        const chain: string[] = [];
        let root: ts.Node = unwrap(child.expression);
        while (ts.isPropertyAccessExpression(root)) {
          chain.unshift(root.name.text);
          root = unwrap(root.expression);
        }
        const method = chain.at(-1);
        if (ts.isIdentifier(root) && root.text === props && chain.length >= 1 && method && ADAPTER_METHODS.has(method)) {
          const expression = [props, ...chain.slice(0, -1)].join(".");
          const path = literalText(child.arguments[0] ? resolveValue(tree, child.arguments[0]) : undefined);
          const evidence = nodeEvidence(context, tree, child, "services.host-adapter");
          sites.push({
            basePath: null,
            match: { rule: { id: "services.host-adapter" } as MatchedRule["rule"], node: child, captures: {}, tree, evidence },
            client: "host_adapter",
            pkg: null,
            protocol: "http",
            endpoint: { kind: "host_provided", expression, path: path === null ? "" : normalizePath(path) },
            endpointEvidence: [],
            operation: path === null ? { kind: "unresolved", detail: "The request path is not determined statically" } : { method: method.toUpperCase(), path: normalizePath(path), method_source: "adapter" },
            request: { state: "unknown", reason: "The host adapter's request is not visible" },
            response: null,
            timeout: { state: "unknown", reason: "The host adapter's timeout is not visible" },
            authentication: { state: "unknown", reason: "The host adapter handles authentication" },
            retries: { state: "unknown", reason: "The host adapter's retries are not visible" },
          });
        }
      }
      ts.forEachChild(child, visit);
    };
    ts.forEachChild(body, visit);
  });
  return sites;
}

/** The logical service a call site belongs to. */
export function identityOf(site: Pick<Site, "endpoint" | "protocol" | "pkg" | "match" | "client">): { key: string; kind: string; value: string; inferred: boolean } {
  const prefix = site.protocol === "http" ? "" : `${site.protocol}:`;
  if (site.client === "packaged" && site.pkg) return { key: `package:${site.pkg}`, kind: "package", value: site.pkg, inferred: true };
  const { endpoint } = site;
  switch (endpoint.kind) {
    case "literal":
      return { key: `${prefix}${endpoint.origin}`, kind: "origin", value: endpoint.origin, inferred: false };
    case "relative": {
      const segment = endpoint.path?.split("/")[1] ?? "";
      return { key: `${prefix}same-origin:/${segment}`, kind: "same_origin", value: `/${segment}`, inferred: true };
    }
    case "configured":
      return { key: `${prefix}config:${endpoint.source}:${endpoint.key}`, kind: "configuration", value: `${endpoint.source}.${endpoint.key}`, inferred: false };
    case "host_provided":
      return { key: `${prefix}host:${endpoint.expression}`, kind: "host", value: endpoint.expression, inferred: true };
    case "unknown":
      return { key: `${prefix}unresolved:${site.match.tree.path}:${site.match.tree.lines(site.match.node).start}`, kind: "call_site", value: `${site.match.tree.path}:${site.match.tree.lines(site.match.node).start}`, inferred: false };
  }
}

const IDENTITY_REASONS: Record<string, string> = {
  package: "The call configures a client exported by a package with an endpoint, which is how packaged service clients are pointed at their service.",
  same_origin: "Relative requests go to the origin the application is served from; they are grouped by their first path segment.",
  host: "The endpoint or client comes from the props single-spa passes to a lifecycle, so the host that mounts the application provides it.",
};

function endpointValue(endpoint: Endpoint, basePath: string | null): Value {
  const path = basePath === null ? {} : { base_path: basePath };
  switch (endpoint.kind) {
    case "literal":
      return { derivation: "literal", origin: endpoint.origin, ...path };
    case "relative":
      return { derivation: "relative", ...path };
    case "configured":
      return { derivation: "configured", source: endpoint.source, key: endpoint.key, ...path };
    case "host_provided":
      return { derivation: "host_provided", expression: endpoint.expression };
    case "unknown":
      return { derivation: "unknown", reason: endpoint.reason, detail: endpoint.detail };
  }
}

function report(context: DetectorContext, sites: Site[], documents: MatchedRule[]) {
  const groups = new Map<string, Site[]>();
  for (const site of sites) {
    const { key } = identityOf(site);
    groups.set(key, [...(groups.get(key) ?? []), site]);
  }
  const graphqlKeys = [...groups.keys()].filter((key) => groups.get(key)!.some((site) => site.protocol === "graphql"));

  for (const [key, group] of [...groups.entries()].sort(([a], [b]) => compareCodeUnits(a, b))) {
    const [first] = group as [Site, ...Site[]];
    const identity = identityOf(first);
    const rule = first.match.rule.id;
    const callSites = group.map((site) => site.match.evidence);
    const all = [...callSites, ...group.flatMap((site) => site.endpointEvidence)];
    const proposal = (basis: ServiceFactCandidate["basis"], value: Value, evidence: readonly Evidence[] = callSites, extra: Partial<ServiceFactCandidate> = {}): ServiceFactCandidate => ({ basis, value, evidence, rule, ...extra });

    const facts: ServiceCandidate["facts"] = {
      identity: identity.inferred ? proposal("inferred", { kind: identity.kind, value: identity.value }, callSites, { reasoning: IDENTITY_REASONS[identity.kind]! }) : proposal("observed", { kind: identity.kind, value: identity.value }),
      protocol: proposal("observed", first.protocol),
    };
    const endpointOf = (site: Site, evidence: readonly Evidence[]) =>
      site.endpoint.kind === "unknown"
        ? proposal("unknown", endpointValue(site.endpoint, null), evidence)
        : site.endpoint.kind === "host_provided"
          ? proposal("inferred", endpointValue(site.endpoint, site.basePath), evidence, { reasoning: IDENTITY_REASONS.host! })
          : proposal("observed", endpointValue(site.endpoint, site.basePath), evidence);
    const endpoints = uniqueValues(group.map((site) => endpointValue(site.endpoint, site.basePath)));
    if (endpoints.length === 1) facts.endpoint = endpointOf(first, all);

    // Set-valued facts are aggregated across the group's call sites.
    const operations = uniqueValues(group.map((site) => site.operation));
    const graphqlOperations = first.protocol === "graphql" && graphqlKeys.length === 1 ? documentOperations(documents) : [];
    if (graphqlOperations.length) {
      facts.operations = proposal("inferred", graphqlOperations.map((name) => ({ operation: name })), [...callSites, ...documents.map((document) => document.evidence)], { reasoning: "The repository's GraphQL documents are sent through its only GraphQL client." });
    } else {
      facts.operations = operations.some((operation) => isUnresolved(operation)) ? proposal("unknown", { known: operations.filter((operation) => !isUnresolved(operation)) }) : proposal("observed", operations);
    }

    const requests = group.map((site) => site.request);
    const withBodies = group.flatMap((site) => (site.request.state === "set" ? [{ operation: site.operation, fields: site.request.value }] : []));
    facts.request_shape = requests.some((request) => request.state === "unknown")
      ? proposal("unknown", null)
      : withBodies.length === 0
        ? proposal("absent", null, callSites, { search: { surface: [...new Set(group.map((site) => site.match.tree.path))].sort(compareCodeUnits), complete: true, skipped: [] } })
        : proposal("observed", uniqueValues(withBodies));

    const responses = group.map((site) => site.response);
    facts.consumed_response_fields = responses.every((fields) => fields !== null) ? proposal("observed", [...new Set(responses.flat() as string[])].sort(compareCodeUnits)) : proposal("unknown", { known: [...new Set(responses.flatMap((fields) => fields ?? []))].sort(compareCodeUnits) });

    const candidates: ServiceCandidate[] = [{ key, client: { kind: first.client, package: first.pkg }, callSites, facts }];
    // Call sites of one service that derive its endpoint differently conflict rather than hide behind the first.
    if (endpoints.length > 1) for (const site of group) candidates.push({ key, client: { kind: site.client, package: site.pkg }, callSites: [site.match.evidence], facts: { endpoint: endpointOf(site, [site.match.evidence, ...site.endpointEvidence]) } });
    // Per-call-site facts: agreeing sites merge, and disagreeing ones surface as a conflict.
    for (const [name, settings] of [
      ["timeout", group.map((site) => site.timeout)],
      ["authentication", group.map((site) => site.authentication)],
      ["retry", group.map((site) => site.retries)],
    ] as const) {
      const unknown = settings.find((setting) => setting.state === "unknown");
      if (unknown?.state === "unknown" && settings.every((setting) => setting.state !== "set")) {
        facts[name] = proposal("unknown", { reason: unknown.reason });
      } else if (settings.every((setting) => setting.state === "none") && name === "timeout") {
        facts[name] = proposal("absent", null, callSites, { search: { surface: [...new Set(group.map((site) => site.match.tree.path))].sort(compareCodeUnits), complete: true, skipped: [] } });
      } else {
        group.forEach((site, index) => {
          const setting = settings[index]!;
          if (setting.state === "unknown") return;
          const value = setting.state === "set" ? setting.value : name === "timeout" ? { ms: null } : null;
          candidates.push({ key, client: { kind: site.client, package: site.pkg }, callSites: [site.match.evidence], facts: { [name]: proposal("observed", value, [site.match.evidence]) } });
        });
      }
    }
    for (const candidate of candidates) context.service(candidate);
    if (identity.kind !== "call_site") context.reference({ type: "service", role: "caller", identifier: { key }, basis: identity.inferred ? "inferred" : "observed", evidence: callSites, rule });
  }
}

function uniqueValues(values: readonly Value[]): Value[] {
  const seen = new Map<string, Value>();
  for (const value of values) seen.set(JSON.stringify(sortKeys(value)), value);
  return [...seen.entries()].sort(([a], [b]) => compareCodeUnits(a, b)).map(([, value]) => value);
}

function sortKeys(value: Value): Value {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key]!)]));
  return value;
}

function isUnresolved(value: Value): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value) && value.kind === "unresolved";
}

/** Named operations in the repository's GraphQL documents, such as `query Orders`. */
function documentOperations(documents: readonly MatchedRule[]): string[] {
  const names = new Set<string>();
  for (const document of documents) {
    const text = document.captures.document?.kind === "string" ? document.captures.document.value : null;
    if (text === null) continue;
    for (const match of text.matchAll(/\b(query|mutation|subscription)\s+([A-Za-z_][A-Za-z0-9_]*)/g)) names.add(`${match[1]} ${match[2]}`);
  }
  return [...names].sort(compareCodeUnits);
}

