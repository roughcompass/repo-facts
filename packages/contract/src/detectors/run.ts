import { entryEvidence, lineEvidence, pointerEvidence } from "../evidence.js";
import { type Findings, reconcileFacts } from "../facts/reconcile.js";
import { redactCredentials } from "../redaction.js";
import type { CategoryDefinition, FactDocument } from "../facts/schema.js";
import type { SourceReader } from "../reader/types.js";
import { type Format, StructuredParseError, parse } from "../structured.js";
import { type Detector, type DetectorContext, STAGES, type Stage, matchesPattern } from "./contract.js";

/**
 * Runs a detector bundle over one snapshot or working tree, stage by stage,
 * then reconciles the candidates into a fact document. Cancellation is checked before every stage.
 * A detector that fails is recorded as a diagnostic, and every category it
 * searches is left incomplete, so its failure can never read as an absence.
 */

export interface DetectorRunOptions {
  reader: SourceReader;
  detectorRelease: string;
  detectors: readonly Detector[];
  /** Extension categories the consumer registers for this run. */
  extensions?: readonly CategoryDefinition[];
  signal?: AbortSignal;
  /** Called before each stage; may throw to stop the run. */
  checkpoint?: (stage: Stage) => void;
}

export class DetectorRunCanceled extends Error {
  override name = "DetectorRunCanceled";
}

export async function runDetectors(options: DetectorRunOptions): Promise<FactDocument> {
  const { reader } = options;
  const findings: Findings = { facts: [], searches: [], services: [], references: [], diagnostics: [] };
  const shared = new Map<string, unknown>();

  for (const stage of STAGES) {
    if (options.signal?.aborted) throw new DetectorRunCanceled(`Analysis was canceled before the ${stage} stage`);
    options.checkpoint?.(stage);

    for (const detector of options.detectors.filter((candidate) => candidate.stage === stage)) {
      const context = contextFor(detector, { reader, findings, shared }, options.signal);
      try {
        await detector.run(context);
      } catch (error) {
        if (error instanceof DetectorRunCanceled) throw error;
        findings.diagnostics.push({ path: "", reason: "detector_failed", detail: `${detector.id} failed: ${(error as Error).message}`.slice(0, 500), detector: detector.id });
        for (const category of detector.categories) findings.searches.push({ category, rule: `${detector.id}:failed`, surface: [], complete: false, skipped: [] });
      }
    }
  }

  return reconcileFacts(findings, reader, { detectorRelease: options.detectorRelease, ...(options.extensions && { extensions: options.extensions }) });
}

interface RunState {
  reader: SourceReader;
  findings: Findings;
  shared: Map<string, unknown>;
}

function contextFor(detector: Detector, { reader, findings, shared }: RunState, signal?: AbortSignal): DetectorContext {
  const source = (rule: string) => ({ commit: reader.commit, detector: detector.id, rule });
  // Diagnostics quote repository content, so credentials are redacted before they are recorded.
  const diagnostic: DetectorContext["diagnostic"] = (path, reason, detail, options) =>
    findings.diagnostics.push({ path, reason, detail: redactCredentials(detail).slice(0, 500), detector: options?.detector ?? detector.id });

  const context: DetectorContext = {
    reader,
    commit: reader.commit,
    ...(signal && { signal }),
    shared,
    entries: (pattern) => reader.entries.filter((entry) => matchesPattern(entry.path, pattern)),
    async text(path) {
      const result = await reader.read(path);
      if (!result.ok) return null;
      return result.content.text === null ? null : result.content;
    },
    async parsed(path, format: Format) {
      const content = await context.text(path);
      if (!content) return null;
      try {
        return { content, value: parse(content.text!, format) };
      } catch (error) {
        if (!(error instanceof StructuredParseError)) throw error;
        diagnostic(path, "parse_failed", error.message);
        return null;
      }
    },
    lines: (content, rule, start, end) => lineEvidence(content, source(rule), start, end),
    pointer: (content, rule, format, pointer) => pointerEvidence(content, source(rule), format, pointer),
    entry: (entry, rule) => entryEvidence(entry, source(rule)),
    fact: (candidate) => findings.facts.push({ ...candidate, detector: detector.id }),
    search: (record) => findings.searches.push(record),
    service: (candidate) => findings.services.push(candidate),
    reference: (candidate) => findings.references.push(candidate),
    diagnostic,
  };
  return context;
}

