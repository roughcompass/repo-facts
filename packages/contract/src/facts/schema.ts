import { z } from "zod";

/**
 * The fact document contract, version 2: what one detector run over one
 * snapshot or working tree established about a repository.
 *
 * Every shared category, and every extension category the consumer
 * registered, appears in every document. A category with no defensible
 * conclusion is "unknown"; it is "absent" only when its detectors searched
 * their complete declared surface with nothing skipped (a bounded negative).
 * Every observed or inferred fact cites evidence, every inferred fact explains
 * its reasoning, and a conflicting fact keeps every candidate and its evidence.
 * Service Dependencies never claim an access state other than unknown.
 */

export const FACT_DOCUMENT_SCHEMA = "repo_facts.fact_document";
export const FACT_DOCUMENT_VERSION = 2;

export const FACT_STATES = ["observed", "inferred", "conflicting", "unknown"] as const;
export type FactState = (typeof FACT_STATES)[number];

export const CATEGORY_STATES = ["observed", "inferred", "mixed", "conflicting", "unknown", "absent"] as const;
export type CategoryState = (typeof CATEGORY_STATES)[number];

export interface CategoryDefinition {
  id: string;
  label: string;
  group: string;
  /** A complete search may conclude the category is absent. */
  boundedNegative: boolean;
  description: string;
}

const category = (id: string, label: string, group: string, boundedNegative: boolean, description: string): CategoryDefinition => ({
  id,
  label,
  group,
  boundedNegative,
  description,
});

/** The shared category vocabulary. Products add namespaced extensions. */
export const SHARED_CATEGORIES: readonly CategoryDefinition[] = [
  category("languages", "Languages", "Inventory", true, "Languages by committed file extension"),
  category("submodules", "Submodules", "Inventory", true, "Git submodule declarations (never cloned)"),
  category("package_identity", "Package identity", "Packages", true, "Names and versions declared by package manifests"),
  category("workspaces", "Workspaces", "Packages", true, "Workspace package directories"),
  category("package_managers", "Package manager", "Tooling", true, "Package manager declared or implied by lockfiles"),
  category("build_tools", "Build tools", "Tooling", true, "Bundlers and compilers declared as dependencies or configuration"),
  category("test_frameworks", "Test frameworks", "Tooling", true, "Test runners declared as dependencies or configuration"),
  category("ci_systems", "CI systems", "Verification", true, "Supported CI definitions"),
  category("scripts", "Package scripts", "Verification", true, "Scripts declared in package manifests (never run)"),
  category("verification_commands", "Verification commands", "Verification", true, "Commands declared for testing, linting, and building (never run)"),
  category("runtime_requirements", "Runtime requirements", "Runtime", true, "Declared runtime versions"),
  category("dependencies", "Dependencies", "Dependencies", true, "Direct dependencies and their declared ranges"),
  category("resolved_dependencies", "Resolved versions", "Dependencies", false, "Direct dependency versions resolved by lockfiles"),
  category("frameworks", "Frameworks", "Architecture", true, "Application frameworks and their versions"),
  category("composition", "Composition", "Architecture", false, "Micro-frontend and composition mechanisms"),
  category("packages_produced", "Packages produced", "Architecture", true, "Packages this repository produces"),
  category("packages_consumed", "Packages consumed", "Architecture", true, "Packages this repository depends on"),
  category("served_origins", "Served origins", "Architecture", false, "Origins this application is configured to be served from"),
  category("runtime_integrations", "Runtime integrations", "Architecture", false, "Runtime contracts produced or consumed"),
  category("access_signals", "Access signals", "Services", true, "Source-visible authentication, credential, certificate, and network-zone signals (never values)"),
  category("egress_routes", "Proxies and gateways", "Services", true, "Proxy variables, reverse-proxy rules, and gateway configuration"),
  category("api_contracts", "API contracts", "Services", true, "Committed OpenAPI, GraphQL, and generated-client contracts"),
  category("test_substitutes", "Test substitutes", "Services", true, "Existing interceptors, mock servers, and fixtures (never generated)"),
  category("design_systems", "Design systems", "Interface", true, "Design systems recognized from catalogs, with their declared packages, theme stylesheet, and provider"),
  category("ui_elements", "UI elements", "Interface", true, "JSX elements by design-system component, intrinsic tag, and customization"),
  category("style_values", "Style values", "Interface", true, "Style declarations by value kind, and design-system adherence findings"),
];

export const SHARED_CATEGORY_IDS = SHARED_CATEGORIES.map((definition) => definition.id);
const SHARED_BY_ID = new Map(SHARED_CATEGORIES.map((definition) => [definition.id, definition]));

/** Extension category ids are namespaced by the product that registers them, such as `web-doctor.entry_points`. */
export const EXTENSION_ID = /^[a-z][a-z0-9-]*\.[a-z][a-z0-9_]*$/;

export class CategoryError extends Error {
  override name = "CategoryError";
}

/** Validates a product's extension category. */
export function defineExtension(definition: CategoryDefinition): CategoryDefinition {
  if (!EXTENSION_ID.test(definition.id)) throw new CategoryError(`Extension category ${JSON.stringify(definition.id)} must be namespaced as <namespace>.<name>`);
  return definition;
}

/** Shared categories followed by +extensions+ in id order; rejects duplicates. */
export function categoriesFor(extensions: readonly CategoryDefinition[] = []): CategoryDefinition[] {
  const ids = new Set<string>(SHARED_CATEGORY_IDS);
  const sorted = [...extensions].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const extension of sorted) {
    defineExtension(extension);
    if (ids.has(extension.id)) throw new CategoryError(`Category ${extension.id} is defined more than once`);
    ids.add(extension.id);
  }
  return [...SHARED_CATEGORIES, ...sorted];
}

export function categoryDefinition(id: string, extensions: readonly CategoryDefinition[] = []): CategoryDefinition {
  const definition = SHARED_BY_ID.get(id) ?? extensions.find((extension) => extension.id === id);
  if (!definition) throw new CategoryError(`Unknown category ${id}`);
  return definition;
}

/** Facts every Service Dependency carries, each with its own epistemic state. */
export const SERVICE_FACTS = [
  "identity",
  "protocol",
  "endpoint",
  "operations",
  "request_shape",
  "consumed_response_fields",
  "authentication",
  "timeout",
  "retry",
  "proxy",
  "contracts",
  "substitutes",
] as const;
export type ServiceFact = (typeof SERVICE_FACTS)[number];

export const ENDPOINT_KINDS = ["literal", "template", "configured", "host_provided", "unknown"] as const;
export const CLIENT_KINDS = ["fetch", "axios", "websocket", "event_source", "graphql", "generated", "packaged", "host_adapter"] as const;
export const REFERENCE_TYPES = ["package", "composition", "iframe", "runtime_contract", "service"] as const;
export const REFERENCE_ROLES = ["consumer", "producer", "host", "remote", "embedder", "caller"] as const;

// Canonical JSON admits only safe integers, so fact values do too.
const json: z.ZodType<unknown> = z.lazy(() => z.union([z.string(), z.int(), z.boolean(), z.null(), z.array(json), z.record(z.string(), json)]));
const evidenceIds = z.array(z.string().regex(/^ev_[0-9a-f]{24}$/));

const factSchema = z.strictObject({
  key: z.string().min(1),
  state: z.enum(FACT_STATES),
  value: json,
  evidence: evidenceIds,
  rule: z.string().min(1),
  reasoning: z.string().min(1).optional(),
  candidates: z.array(z.strictObject({ value: json, evidence: evidenceIds, rule: z.string().min(1) })).optional(),
});

/** What was searched: the rules, the paths they examined, and anything skipped. */
const searchSchema = z.strictObject({
  rules: z.array(z.string().min(1)),
  surface: z.array(z.string()),
  complete: z.boolean(),
  skipped: z.array(z.string()),
});

const categorySchema = z.strictObject({
  state: z.enum(CATEGORY_STATES),
  facts: z.array(factSchema),
  search: searchSchema,
});

const serviceFactSchema = z.strictObject({
  state: z.enum([...FACT_STATES, "absent"]),
  value: json,
  evidence: evidenceIds,
  rule: z.string().min(1),
  reasoning: z.string().min(1).optional(),
  candidates: z.array(z.strictObject({ value: json, evidence: evidenceIds, rule: z.string().min(1) })).optional(),
  /** Required for absent: the bounded search that found nothing. */
  search: searchSchema.optional(),
});

const serviceSchema = z.strictObject({
  id: z.string().regex(/^svc_[0-9a-f]{24}$/),
  key: z.string().min(1),
  client: z.strictObject({ kind: z.enum(CLIENT_KINDS), package: z.string().nullable() }),
  call_sites: evidenceIds.min(1),
  access: z.strictObject({ state: z.literal("unknown"), reason: z.string().min(1) }),
  characterizable: z.boolean(),
  missing_evidence: z.array(z.enum(SERVICE_FACTS)),
  ...(Object.fromEntries(SERVICE_FACTS.map((name) => [name, serviceFactSchema])) as Record<ServiceFact, typeof serviceFactSchema>),
});

const commitSchema = z.string().regex(/^[0-9a-f]{40}$/).nullable();

const evidenceSchema = z.strictObject({
  id: z.string().regex(/^ev_[0-9a-f]{24}$/),
  commit: commitSchema,
  path: z.string().min(1),
  object_id: z.string().regex(/^[0-9a-f]{40}$/),
  content_digest: z.string().regex(/^[0-9a-f]{64}$/),
  detector: z.string().min(1),
  rule: z.string().min(1),
  location: z.union([
    z.strictObject({ kind: z.literal("lines"), start: z.int().positive(), end: z.int().positive() }),
    z.strictObject({ kind: z.literal("pointer"), format: z.enum(["json", "yaml"]), pointer: z.string() }),
    z.strictObject({ kind: z.literal("entry") }),
  ]),
  excerpt_digest: z.string().regex(/^[0-9a-f]{64}$/),
});

const referenceSchema = z.strictObject({
  id: z.string().regex(/^ref_[0-9a-f]{24}$/),
  type: z.enum(REFERENCE_TYPES),
  role: z.enum(REFERENCE_ROLES),
  identifier: z.record(z.string(), z.string()),
  basis: z.enum(["observed", "inferred"]),
  evidence: evidenceIds.min(1),
  rule: z.string().min(1),
});

const diagnosticSchema = z.strictObject({
  path: z.string(),
  reason: z.string().min(1),
  detail: z.string(),
  detector: z.string().nullable(),
});

const extensionSchema = z.strictObject({ id: z.string().regex(EXTENSION_ID), bounded_negative: z.boolean() });

export const factDocumentSchema = z.strictObject({
  schema: z.literal(FACT_DOCUMENT_SCHEMA),
  schema_version: z.literal(FACT_DOCUMENT_VERSION),
  detector_release: z.string().min(1),
  /** The snapshot commit, or null for a working tree. */
  commit: commitSchema,
  /** Extension categories the document was produced with, in id order. */
  extensions: z.array(extensionSchema),
  categories: z.record(z.string(), categorySchema),
  service_dependencies: z.array(serviceSchema),
  relationship_references: z.array(referenceSchema),
  evidence: z.record(z.string(), evidenceSchema),
  diagnostics: z.array(diagnosticSchema),
  inventory: z.strictObject({
    entries: z.int().nonnegative(),
    files: z.int().nonnegative(),
    executables: z.int().nonnegative(),
    symlinks: z.int().nonnegative(),
    gitlinks: z.int().nonnegative(),
    bytes: z.int().nonnegative(),
    files_read: z.int().nonnegative(),
    bytes_read: z.int().nonnegative(),
  }),
});

export type FactDocument = z.infer<typeof factDocumentSchema>;
export type DocumentCategory = z.infer<typeof categorySchema>;
export type DocumentFact = z.infer<typeof factSchema>;
export type ServiceDependency = z.infer<typeof serviceSchema>;
export type ServiceFactValue = z.infer<typeof serviceFactSchema>;
export type DocumentEvidence = z.infer<typeof evidenceSchema>;
export type RelationshipReference = z.infer<typeof referenceSchema>;
export type DocumentDiagnostic = z.infer<typeof diagnosticSchema>;
export type DocumentSearch = z.infer<typeof searchSchema>;
export type DocumentExtension = z.infer<typeof extensionSchema>;

/**
 * Structural and semantic validation of a fact document. Returns every
 * problem found, or an empty list.
 */
export function factDocumentProblems(document: unknown): string[] {
  const parsed = factDocumentSchema.safeParse(document);
  if (!parsed.success) return parsed.error.issues.map((issue) => `${issue.path.join(".") || "document"}: ${issue.message}`);

  const facts = parsed.data;
  const problems: string[] = [];
  const known = new Set(Object.keys(facts.evidence));
  const cite = (label: string, ids: readonly string[]) => {
    for (const id of ids) if (!known.has(id)) problems.push(`${label} cites unknown evidence ${id}`);
  };

  for (const [id, evidence] of Object.entries(facts.evidence)) {
    if (evidence.id !== id) problems.push(`evidence ${id} is filed under the wrong id`);
    if (evidence.commit !== facts.commit) problems.push(`evidence ${id} names another commit`);
  }

  const extensionIds = facts.extensions.map((extension) => extension.id);
  if (extensionIds.join() !== [...new Set(extensionIds)].sort().join()) problems.push("extensions must be unique and in id order");
  for (const id of extensionIds) if (SHARED_BY_ID.has(id)) problems.push(`extension ${id} redefines a shared category`);
  const boundedNegative = new Map<string, boolean>([...SHARED_CATEGORIES.map((definition) => [definition.id, definition.boundedNegative] as const), ...facts.extensions.map((extension) => [extension.id, extension.bounded_negative] as const)]);

  const missing = [...boundedNegative.keys()].filter((id) => !Object.hasOwn(facts.categories, id));
  const extra = Object.keys(facts.categories).filter((id) => !boundedNegative.has(id));
  if (missing.length) problems.push(`categories are missing: ${missing.join(", ")}`);
  if (extra.length) problems.push(`categories are not supported: ${extra.join(", ")}`);

  for (const [id, entry] of Object.entries(facts.categories)) {
    const bounded = boundedNegative.get(id);
    if (bounded === undefined) continue;
    for (const fact of entry.facts) problems.push(...factProblems(`${id}/${fact.key}`, fact));
    for (const fact of entry.facts) {
      cite(`${id}/${fact.key}`, fact.evidence);
      for (const candidate of fact.candidates ?? []) cite(`${id}/${fact.key}`, candidate.evidence);
    }
    const expected = categoryState(entry.facts, entry.search.complete && entry.search.skipped.length === 0, bounded);
    if (entry.state !== expected) problems.push(`${id} is ${entry.state} but its facts and search make it ${expected}`);
    const keys = entry.facts.map((fact) => fact.key);
    if (new Set(keys).size !== keys.length) problems.push(`${id} repeats a fact key`);
  }

  for (const service of facts.service_dependencies) {
    const label = `service ${service.key}`;
    cite(label, service.call_sites);
    for (const name of SERVICE_FACTS) {
      const fact = service[name];
      problems.push(...factProblems(`${label} ${name}`, fact));
      if (fact.state === "absent" && !(fact.search?.complete && fact.search.skipped.length === 0)) {
        problems.push(`${label} ${name} is absent without a complete bounded search`);
      }
      if (fact.state !== "absent" && fact.state !== "unknown" && fact.search) problems.push(`${label} ${name} records a search without a negative or unknown result`);
      cite(`${label} ${name}`, fact.evidence);
      for (const candidate of fact.candidates ?? []) cite(`${label} ${name}`, candidate.evidence);
    }
    const expectedMissing = SERVICE_FACTS.filter((name) => service[name].state === "unknown" || service[name].state === "conflicting");
    if (service.missing_evidence.join() !== expectedMissing.join()) problems.push(`${label} misreports its missing evidence`);
    if (service.characterizable !== isCharacterizable(expectedMissing)) {
      problems.push(`${label} misreports whether its boundary is characterizable`);
    }
  }

  for (const reference of facts.relationship_references) cite(`reference ${reference.id}`, reference.evidence);
  return problems;
}

/** Facts a Service Dependency boundary needs before it can be described completely. */
export const BOUNDARY_FACTS: readonly ServiceFact[] = ["endpoint", "operations", "consumed_response_fields"];

export function isCharacterizable(missing: readonly ServiceFact[]): boolean {
  return !BOUNDARY_FACTS.some((name) => missing.includes(name));
}

/** The state a category must have, derived from its facts and search coverage. */
export function categoryState(facts: readonly { state: FactState }[], searchedCompletely: boolean, boundedNegative: boolean): CategoryState {
  if (facts.length === 0) return searchedCompletely && boundedNegative ? "absent" : "unknown";
  const states = new Set(facts.map((fact) => fact.state));
  if (states.has("conflicting")) return "conflicting";
  if (states.has("observed") && states.has("inferred")) return "mixed";
  if (states.has("inferred")) return "inferred";
  if (states.has("observed")) return "observed";
  return "unknown";
}

function factProblems(label: string, fact: { state: string; evidence: readonly string[]; reasoning?: string | undefined; candidates?: readonly unknown[] | undefined }): string[] {
  const problems: string[] = [];
  if ((fact.state === "observed" || fact.state === "inferred") && fact.evidence.length === 0) problems.push(`${label} asserts a fact without evidence`);
  if (fact.state === "inferred" && !fact.reasoning) problems.push(`${label} is inferred without explaining its reasoning`);
  if (fact.state === "conflicting" && (fact.candidates?.length ?? 0) < 2) problems.push(`${label} is conflicting without its candidates`);
  if (fact.state !== "conflicting" && fact.candidates !== undefined) problems.push(`${label} lists candidates without a conflict`);
  return problems;
}
