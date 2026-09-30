import type { Evidence } from "../evidence.js";
import type { ServiceFact } from "../facts/schema.js";
import type { BlobContent, SkipReason, SourceReader, TreeEntry } from "../reader/types.js";
import type { Format, Value } from "../structured.js";

/**
 * The detector contract, version 1. See docs/detector-contract.md.
 *
 * Detectors are trusted, reviewed code shipped in a detector release. Each has
 * a stable id and version, declares the inputs it reads, and runs in one
 * stage. It sees repository content only through its context's SourceReader,
 * and it reports structured candidates; it never writes a fact document
 * directly. Reconciliation turns every detector's candidates into facts.
 */

export const STAGES = ["inventory", "parse", "convention", "architecture", "services"] as const;
export type Stage = (typeof STAGES)[number];

export type Basis = "observed" | "inferred";

export interface Detector {
  readonly id: string;
  readonly version: string;
  readonly stage: Stage;
  /** The paths or patterns this detector reads, for documentation and coverage. */
  readonly inputs: readonly string[];
  /** Categories this detector searches; a failure leaves them incomplete. */
  readonly categories: readonly string[];
  run(context: DetectorContext): Promise<void>;
}

/** A proposed fact. Candidates with the same category and key are reconciled together. */
export interface FactCandidate {
  category: string;
  key: string;
  value: Value;
  basis: Basis;
  evidence: readonly Evidence[];
  rule: string;
  /** Required for inferred candidates: how the evidence supports the conclusion. */
  reasoning?: string;
}

/**
 * What a detector searched for a category. A category may be reported absent
 * only when every search for it was complete and skipped nothing.
 */
export interface SearchRecord {
  category: string;
  rule: string;
  surface: readonly string[];
  complete: boolean;
  skipped: readonly string[];
}

/**
 * A proposed Service Dependency fact. "unknown" records why a fact cannot be
 * established (for example, a computed endpoint) with the evidence that shows
 * the call. "absent" is a bounded negative and must carry its search.
 */
export interface ServiceFactCandidate {
  basis: Basis | "absent" | "unknown";
  value: Value;
  evidence: readonly Evidence[];
  rule: string;
  reasoning?: string;
  search?: { surface: readonly string[]; complete: boolean; skipped: readonly string[] };
}

export interface ServiceCandidate {
  /** Logical identity used to merge call sites of one dependency. */
  key: string;
  client: { kind: "fetch" | "axios" | "websocket" | "graphql" | "generated" | "packaged" | "host_adapter"; package: string | null };
  callSites: readonly Evidence[];
  facts: Partial<Record<ServiceFact, ServiceFactCandidate>>;
}

export interface ReferenceCandidate {
  type: "package" | "composition" | "iframe" | "runtime_contract" | "service";
  role: "consumer" | "producer" | "host" | "remote" | "embedder" | "caller";
  identifier: Record<string, string>;
  basis: Basis;
  evidence: readonly Evidence[];
  rule: string;
}

/**
 * Diagnostic reasons meaning an input was not read or not understood as a
 * whole. A path with one of these is a skipped input for every search whose
 * surface includes it. Other reasons, such as an unsupported value inside a
 * parsed file, are notes; the detector that raised one decides whether its
 * own search skipped something.
 */
const READER_SKIPS: Record<SkipReason, true> = {
  blob_too_large: true,
  file_budget_exhausted: true,
  total_budget_exhausted: true,
  binary: true,
  symlink: true,
  gitlink: true,
  not_a_file: true,
  path_rejected: true,
  protected_path: true,
  sensitive: true,
  missing: true,
};

export const SKIPPED_INPUT_REASONS: ReadonlySet<string> = new Set([
  ...Object.keys(READER_SKIPS),
  "parse_failed",
  "syntax_error",
  "syntax_node_limit",
  "syntax_depth_limit",
  "unsupported_shape",
  "unsupported_input",
  "unsupported_version",
]);

export interface ParsedFile {
  content: BlobContent;
  value: Value;
}

export interface DiagnosticOptions {
  /** Attributes the diagnostic to a shared layer, such as the syntax parser, instead of the calling detector. */
  detector?: string;
}

export interface DetectorContext {
  readonly reader: SourceReader;
  /** The commit being analyzed, or null for a working tree. */
  readonly commit: string | null;
  readonly signal?: AbortSignal;
  /** Entries whose path matches +pattern+ (see matchesPattern). */
  entries(pattern: string): TreeEntry[];
  /** Reads a text file; returns null when it cannot be read as text (the reader records why). */
  text(path: string): Promise<BlobContent | null>;
  /** Reads and parses a JSON or YAML file; parse failures become diagnostics. */
  parsed(path: string, format: Format): Promise<ParsedFile | null>;
  lines(content: BlobContent, rule: string, start: number, end?: number): Evidence;
  pointer(content: BlobContent, rule: string, format: Format, pointer: string): Evidence;
  entry(entry: TreeEntry, rule: string): Evidence;
  fact(candidate: FactCandidate): void;
  search(record: SearchRecord): void;
  service(candidate: ServiceCandidate): void;
  reference(candidate: ReferenceCandidate): void;
  diagnostic(path: string, reason: string, detail: string, options?: DiagnosticOptions): void;
  /** Results earlier stages shared, keyed by the producing detector or layer. */
  shared: Map<string, unknown>;
}

/**
 * A small, closed pattern language for declared inputs:
 *   "package.json"            exact path
 *   "**\/package.json"        that file name at any depth
 *   ".github/workflows/*"     direct children of a directory
 *   "**\/*.ts"                an extension at any depth
 * Patterns are matched structurally; they are never turned into regular expressions.
 */
export function matchesPattern(path: string, pattern: string): boolean {
  if (pattern.startsWith("**/*.")) return path.endsWith(pattern.slice(4));
  if (pattern.startsWith("**/")) {
    const name = pattern.slice(3);
    return path === name || path.endsWith(`/${name}`);
  }
  if (pattern.endsWith("/*")) {
    const directory = pattern.slice(0, -2);
    return path.startsWith(`${directory}/`) && !path.slice(directory.length + 1).includes("/");
  }
  return path === pattern;
}
