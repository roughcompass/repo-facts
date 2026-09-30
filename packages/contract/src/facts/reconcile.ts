import crypto from "node:crypto";
import { dump } from "../canonical-json.js";
import { type FactCandidate, type ReferenceCandidate, SKIPPED_INPUT_REASONS, type SearchRecord, type ServiceCandidate, type ServiceFactCandidate } from "../detectors/contract.js";
import type { Evidence } from "../evidence.js";
import { compareCodeUnits } from "../reader/policy.js";
import type { SourceReader } from "../reader/types.js";
import { type Value, stableStringify } from "../structured.js";
import {
  type CategoryDefinition,
  type DocumentCategory,
  type DocumentDiagnostic,
  type DocumentFact,
  type DocumentSearch,
  FACT_DOCUMENT_SCHEMA,
  FACT_DOCUMENT_VERSION,
  type FactDocument,
  type RelationshipReference,
  SERVICE_FACTS,
  SHARED_CATEGORIES,
  type ServiceDependency,
  type ServiceFact,
  type ServiceFactValue,
  categoriesFor,
  categoryState,
  factDocumentProblems,
  isCharacterizable,
} from "./schema.js";

/**
 * Reconciles every detector's candidates into one fact document.
 *
 * - A candidate without evidence, or an inferred candidate without reasoning,
 *   is not published; it becomes a diagnostic.
 * - Candidates with the same category and key merge when they agree. When they
 *   disagree, the fact is conflicting and keeps every candidate with its
 *   evidence; no value is chosen.
 * - A category is absent only when every search for it was complete and
 *   nothing on its surface was skipped or failed to parse; a skipped input
 *   makes it unknown.
 * - Every list is sorted, so identical inputs produce an identical document.
 */

/** A fact candidate tagged with the detector that proposed it. */
export interface DetectedFact extends FactCandidate {
  detector: string;
}

export interface Findings {
  facts: DetectedFact[];
  searches: SearchRecord[];
  services: ServiceCandidate[];
  references: ReferenceCandidate[];
  diagnostics: DocumentDiagnostic[];
}

export interface ReconcileOptions {
  detectorRelease: string;
  /** Extension categories the consumer registered for this run. */
  extensions?: readonly CategoryDefinition[];
}

/** Records evidence in the Profile and returns its sorted ids. */
type Cite = (items: readonly Evidence[]) => string[];

const ACCESS_REASON = "Static discovery cannot establish entitlement, credentials, or reachability; no connectivity check is performed.";

export function reconcileFacts(findings: Findings, reader: SourceReader, options: ReconcileOptions): FactDocument {
  const definitions = categoriesFor(options.extensions);
  const evidence = new Map<string, Evidence>();
  const diagnostics: DocumentDiagnostic[] = [
    ...reader.diagnostics().map((skip) => ({ path: skip.path, reason: skip.reason, detail: skip.detail, detector: null })),
    ...findings.diagnostics,
  ];
  // An input that was not read or not understood as a whole, whether the
  // reader skipped it or a detector could not parse it, is a skipped input
  // for every search whose surface includes it.
  const skippedPaths = new Set(diagnostics.filter((diagnostic) => diagnostic.path !== "" && SKIPPED_INPUT_REASONS.has(diagnostic.reason)).map((diagnostic) => diagnostic.path));
  const cite: Cite = (items) => {
    for (const item of items) evidence.set(item.id, item);
    return sortedUnique(items.map((item) => item.id));
  };

  const accepted = findings.facts.filter((candidate) => {
    const reason = candidate.evidence.length === 0 ? "has no evidence" : candidate.basis === "inferred" && !candidate.reasoning ? "is inferred without reasoning" : null;
    if (reason) diagnostics.push({ path: "", reason: "unsupported_assertion", detail: `${candidate.category}/${candidate.key} ${reason} and was not published`, detector: candidate.detector });
    return reason === null;
  });

  const categories: Record<string, DocumentCategory> = {};
  for (const definition of definitions) {
    const groups = groupBy(accepted.filter((candidate) => candidate.category === definition.id), (candidate) => candidate.key);
    const facts = [...groups.entries()].sort(([a], [b]) => compareCodeUnits(a, b)).map(([key, group]) => reconcileFact(key, group, cite));

    const search = mergeSearches(
      findings.searches.filter((record) => record.category === definition.id),
      skippedPaths,
    );
    categories[definition.id] = { state: categoryState(facts, search.complete && search.skipped.length === 0, definition.boundedNegative), facts, search };
  }

  const services = [...groupBy(findings.services, (candidate) => candidate.key).entries()]
    .sort(([a], [b]) => compareCodeUnits(a, b))
    .map(([key, group]) => reconcileService(key, group, cite, skippedPaths));

  const references = [...groupBy(findings.references, (candidate) => stableStringify({ type: candidate.type, role: candidate.role, identifier: candidate.identifier })).values()]
    .map((group): RelationshipReference => {
      const [first] = group;
      const basis = group.some((candidate) => candidate.basis === "observed") ? "observed" : "inferred";
      return {
        id: identifier("ref", { type: first!.type, role: first!.role, identifier: first!.identifier }),
        type: first!.type,
        role: first!.role,
        identifier: first!.identifier,
        basis,
        evidence: cite(group.flatMap((candidate) => candidate.evidence)),
        rule: sortedUnique(group.filter((candidate) => candidate.basis === basis).map((candidate) => candidate.rule))[0]!,
      };
    })
    .sort((a, b) => compareCodeUnits(a.id, b.id));

  const entries = reader.entries;
  const usage = reader.usage();
  const document: FactDocument = {
    schema: FACT_DOCUMENT_SCHEMA,
    schema_version: FACT_DOCUMENT_VERSION,
    detector_release: options.detectorRelease,
    commit: reader.commit,
    extensions: definitions.slice(SHARED_CATEGORIES.length).map((definition) => ({ id: definition.id, bounded_negative: definition.boundedNegative })),
    categories,
    service_dependencies: services,
    relationship_references: references,
    evidence: Object.fromEntries([...evidence.entries()].sort(([a], [b]) => compareCodeUnits(a, b))),
    diagnostics: uniqueDiagnostics(diagnostics),
    inventory: {
      entries: entries.length,
      files: entries.filter((entry) => entry.type === "file" || entry.type === "executable").length,
      executables: entries.filter((entry) => entry.type === "executable").length,
      symlinks: entries.filter((entry) => entry.type === "symlink").length,
      gitlinks: entries.filter((entry) => entry.type === "gitlink").length,
      bytes: entries.reduce((sum, entry) => sum + (entry.type === "file" || entry.type === "executable" ? (entry.size ?? 0) : 0), 0),
      files_read: usage.files,
      bytes_read: usage.bytes,
    },
  };

  const problems = factDocumentProblems(document);
  if (problems.length) throw new Error(`Reconciliation produced an invalid fact document: ${problems.slice(0, 5).join("; ")}`);
  return document;
}

function reconcileFact(key: string, group: readonly FactCandidate[], cite: Cite): DocumentFact {
  const byValue = groupBy(group, (candidate) => stableStringify(candidate.value));
  if (byValue.size === 1) {
    const basis = group.some((candidate) => candidate.basis === "observed") ? "observed" : "inferred";
    const strongest = group.filter((candidate) => candidate.basis === basis);
    return {
      key,
      state: basis,
      value: group[0]!.value,
      evidence: cite(group.flatMap((candidate) => candidate.evidence)),
      rule: sortedUnique(strongest.map((candidate) => candidate.rule))[0]!,
      ...(basis === "inferred" && { reasoning: sortedUnique(strongest.map((candidate) => candidate.reasoning!)).join(" ") }),
    };
  }

  const candidates = [...byValue.entries()]
    .sort(([a], [b]) => compareCodeUnits(a, b))
    .map(([, values]) => ({ value: values[0]!.value, evidence: cite(values.flatMap((candidate) => candidate.evidence)), rule: sortedUnique(values.map((candidate) => candidate.rule))[0]! }));
  return {
    key,
    state: "conflicting",
    value: null,
    evidence: sortedUnique(candidates.flatMap((candidate) => candidate.evidence)),
    rule: sortedUnique(group.map((candidate) => candidate.rule))[0]!,
    candidates,
  };
}

function reconcileService(key: string, group: readonly ServiceCandidate[], cite: Cite, skippedPaths: ReadonlySet<string>): ServiceDependency {
  const facts = {} as Record<ServiceFact, ServiceFactValue>;
  for (const name of SERVICE_FACTS) {
    const proposals = group.flatMap((candidate) => (candidate.facts[name] ? [candidate.facts[name]] : []));
    facts[name] = reconcileServiceFact(proposals, cite, skippedPaths);
  }
  const missing = SERVICE_FACTS.filter((name) => facts[name].state === "unknown" || facts[name].state === "conflicting");
  const clients = [...group.map((candidate) => candidate.client)].sort((a, b) => compareCodeUnits(stableStringify(a), stableStringify(b)));

  return {
    id: identifier("svc", { key }),
    key,
    client: clients[0]!,
    call_sites: cite(group.flatMap((candidate) => candidate.callSites)),
    access: { state: "unknown", reason: ACCESS_REASON },
    characterizable: isCharacterizable(missing),
    missing_evidence: missing,
    ...facts,
  };
}

function reconcileServiceFact(proposals: readonly ServiceFactCandidate[], cite: Cite, skippedPaths: ReadonlySet<string>): ServiceFactValue {
  const asserted = proposals.filter((proposal) => (proposal.basis === "observed" || proposal.basis === "inferred") && proposal.evidence.length > 0 && (proposal.basis === "observed" || proposal.reasoning));
  if (asserted.length === 0) {
    const negatives = proposals.filter((proposal) => proposal.basis === "absent");
    const search = mergeSearches(
      negatives.map((proposal) => ({ rule: proposal.rule, surface: proposal.search?.surface ?? [], complete: proposal.search?.complete ?? false, skipped: proposal.search?.skipped ?? [] })),
      skippedPaths,
    );
    const unknowns = proposals.filter((proposal) => proposal.basis !== "absent");
    if (negatives.length > 0 && unknowns.length === 0 && search.complete && search.skipped.length === 0) {
      return { state: "absent", value: null, evidence: cite(negatives.flatMap((proposal) => proposal.evidence)), rule: search.rules[0]!, search };
    }
    // Unknown keeps whatever established the call and why the fact is open.
    const [first] = [...unknowns].sort((a, b) => compareCodeUnits(stableStringify(a.value), stableStringify(b.value)));
    return {
      state: "unknown",
      value: first?.value ?? null,
      evidence: cite([...unknowns, ...negatives].flatMap((proposal) => proposal.evidence)),
      rule: first?.rule ?? search.rules[0] ?? NOT_ESTABLISHED,
      ...(negatives.length > 0 && { search }),
    };
  }

  const byValue = groupBy(asserted, (proposal) => stableStringify(proposal.value));
  if (byValue.size === 1) {
    const basis = asserted.some((proposal) => proposal.basis === "observed") ? "observed" : "inferred";
    const strongest = asserted.filter((proposal) => proposal.basis === basis);
    return {
      state: basis,
      value: asserted[0]!.value,
      evidence: cite(asserted.flatMap((proposal) => proposal.evidence)),
      rule: sortedUnique(strongest.map((proposal) => proposal.rule))[0]!,
      ...(basis === "inferred" && { reasoning: sortedUnique(strongest.map((proposal) => proposal.reasoning!)).join(" ") }),
    };
  }
  const candidates = [...byValue.entries()]
    .sort(([a], [b]) => compareCodeUnits(a, b))
    .map(([, values]) => ({ value: values[0]!.value, evidence: cite(values.flatMap((proposal) => proposal.evidence)), rule: sortedUnique(values.map((proposal) => proposal.rule))[0]! }));
  return { state: "conflicting", value: null, evidence: sortedUnique(candidates.flatMap((candidate) => candidate.evidence)), rule: candidates[0]!.rule, candidates };
}

/** Rule name for a Service Dependency fact that no detector addressed. */
export const NOT_ESTABLISHED = "not-established";

function mergeSearches(records: readonly { rule: string; surface: readonly string[]; complete: boolean; skipped: readonly string[] }[], skippedPaths: ReadonlySet<string>): DocumentSearch {
  const surface = sortedUnique(records.flatMap((record) => record.surface));
  return {
    rules: sortedUnique(records.map((record) => record.rule)),
    surface,
    complete: records.length > 0 && records.every((record) => record.complete),
    skipped: sortedUnique([...records.flatMap((record) => record.skipped), ...surface.filter((path) => skippedPaths.has(path))]),
  };
}

export function identifier(prefix: "svc" | "ref", fields: Record<string, Value>): string {
  return `${prefix}_${crypto.createHash("sha256").update(dump(fields)).digest("hex").slice(0, 24)}`;
}

function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const group = groups.get(key(item));
    if (group) group.push(item);
    else groups.set(key(item), [item]);
  }
  return groups;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareCodeUnits);
}

function uniqueDiagnostics(diagnostics: readonly DocumentDiagnostic[]): DocumentDiagnostic[] {
  const seen = new Map<string, DocumentDiagnostic>();
  for (const diagnostic of diagnostics) seen.set(stableStringify(diagnostic as unknown as Value), diagnostic);
  return [...seen.values()].sort((a, b) => compareCodeUnits(a.path, b.path) || compareCodeUnits(a.reason, b.reason) || compareCodeUnits(a.detector ?? "", b.detector ?? "") || compareCodeUnits(a.detail, b.detail));
}
