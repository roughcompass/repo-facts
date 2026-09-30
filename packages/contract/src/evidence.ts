import crypto from "node:crypto";
import { dump } from "./canonical-json.js";
import type { BlobContent, SourceReader, TreeEntry } from "./reader/types.js";
import { type Format, StructuredParseError, parse, pointerLines, stableStringify, valueAt } from "./structured.js";

/**
 * Evidence records tie every asserted fact to repository content.
 *
 * A record names the commit (null for a working tree), the repository-relative
 * path, the blob's Git object id computed from its bytes, a SHA-256
 * of the blob's bytes, the detector and rule that produced it, and a location:
 * a line range, a JSON or YAML pointer, or the entry itself (for facts about a
 * file's presence or mode). It also carries a digest of the exact excerpt, so
 * resolving it later against a reader proves the fact still points at
 * the same content. Stale or mismatched records are refused.
 */

export type EvidenceLocation =
  | { kind: "lines"; start: number; end: number }
  | { kind: "pointer"; format: Format; pointer: string }
  | { kind: "entry" };

export interface Evidence {
  id: string;
  /** The snapshot commit, or null when the content came from a working tree. */
  commit: string | null;
  path: string;
  object_id: string;
  content_digest: string;
  detector: string;
  rule: string;
  location: EvidenceLocation;
  excerpt_digest: string;
}

export class EvidenceError extends Error {
  override name = "EvidenceError";
}

export interface EvidenceSource {
  commit: string | null;
  detector: string;
  rule: string;
}

export function lineEvidence(content: BlobContent, source: EvidenceSource, start: number, end = start): Evidence {
  const lines = linesOf(content);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end > lines.length) {
    throw new EvidenceError(`Lines ${start}-${end} are outside ${content.entry.path} (${lines.length} lines)`);
  }
  return build(content.entry, content.digest, source, { kind: "lines", start, end }, excerptDigest(lines.slice(start - 1, end).join("\n")));
}

export function pointerEvidence(content: BlobContent, source: EvidenceSource, format: Format, pointer: string): Evidence {
  const value = pointedValue(content, format, pointer);
  if (value === undefined) throw new EvidenceError(`${pointer || "(root)"} does not exist in ${content.entry.path}`);
  return build(content.entry, content.digest, source, { kind: "pointer", format, pointer }, excerptDigest(stableStringify(value)));
}

/** Evidence of an entry's existence, mode, or type, independent of its bytes. */
export function entryEvidence(entry: TreeEntry, source: EvidenceSource): Evidence {
  const identity = `${entry.mode} ${entry.type} ${entry.objectId} ${entry.path}`;
  return build(entry, excerptDigest(identity), source, { kind: "entry" }, excerptDigest(identity));
}

export type ResolvedEvidence =
  | { ok: true; evidence: Evidence; excerpt: string; lines: { start: number; end: number } | null }
  | { ok: false; reason: "commit_mismatch" | "path_missing" | "content_changed" | "unreadable" | "location_invalid" | "excerpt_changed" | "id_mismatch"; detail: string };

/** Re-reads the content an evidence record points at and verifies it. */
export async function resolveEvidence(reader: SourceReader, evidence: Evidence): Promise<ResolvedEvidence> {
  if (evidenceId(evidence) !== evidence.id) return { ok: false, reason: "id_mismatch", detail: "The evidence record was altered" };
  if (reader.commit !== evidence.commit) return { ok: false, reason: "commit_mismatch", detail: `The evidence names ${evidence.commit ?? "a working tree"}, not ${reader.commit ?? "a working tree"}` };

  const entry = reader.entry(evidence.path);
  if (!entry) return { ok: false, reason: "path_missing", detail: `${evidence.path} is not in the tree` };
  if (entry.objectId !== evidence.object_id) return { ok: false, reason: "content_changed", detail: `${evidence.path} is not the blob the evidence names` };

  if (evidence.location.kind === "entry") {
    const identity = `${entry.mode} ${entry.type} ${entry.objectId} ${entry.path}`;
    if (excerptDigest(identity) !== evidence.excerpt_digest) return { ok: false, reason: "excerpt_changed", detail: "The entry's mode or type changed" };
    return { ok: true, evidence, excerpt: identity, lines: null };
  }

  const read = await reader.read(evidence.path);
  if (!read.ok || read.content.text === null) return { ok: false, reason: "unreadable", detail: read.ok ? "The file is binary" : read.skip.detail };
  if (read.content.digest !== evidence.content_digest) return { ok: false, reason: "content_changed", detail: "The file's bytes differ from the evidence digest" };

  if (evidence.location.kind === "lines") {
    const { start, end } = evidence.location;
    const lines = linesOf(read.content);
    if (start < 1 || end < start || end > lines.length) return { ok: false, reason: "location_invalid", detail: `Lines ${start}-${end} are outside the file` };
    const excerpt = lines.slice(start - 1, end).join("\n");
    if (excerptDigest(excerpt) !== evidence.excerpt_digest) return { ok: false, reason: "excerpt_changed", detail: "The cited lines changed" };
    return { ok: true, evidence, excerpt, lines: { start, end } };
  }

  const { format, pointer } = evidence.location;
  let value;
  try {
    value = pointedValue(read.content, format, pointer);
  } catch (error) {
    return { ok: false, reason: "location_invalid", detail: (error as Error).message };
  }
  if (value === undefined) return { ok: false, reason: "location_invalid", detail: `${pointer || "(root)"} does not exist` };
  const excerpt = stableStringify(value);
  if (excerptDigest(excerpt) !== evidence.excerpt_digest) return { ok: false, reason: "excerpt_changed", detail: "The cited value changed" };
  return { ok: true, evidence, excerpt, lines: pointerLines(read.content.text, pointer) };
}

/** A stable id: the digest of everything the record asserts. */
export function evidenceId(evidence: Omit<Evidence, "id">): string {
  const { id: _id, ...fields } = evidence as Evidence;
  return `ev_${crypto.createHash("sha256").update(dump(fields)).digest("hex").slice(0, 24)}`;
}

function build(entry: TreeEntry, contentDigest: string, source: EvidenceSource, location: EvidenceLocation, excerpt: string): Evidence {
  const fields = {
    commit: source.commit,
    path: entry.path,
    object_id: entry.objectId,
    content_digest: contentDigest,
    detector: source.detector,
    rule: source.rule,
    location,
    excerpt_digest: excerpt,
  };
  return { id: evidenceId(fields), ...fields };
}

function pointedValue(content: BlobContent, format: Format, pointer: string) {
  if (content.text === null) throw new EvidenceError(`${content.entry.path} is binary`);
  try {
    return valueAt(parse(content.text, format), pointer);
  } catch (error) {
    if (error instanceof StructuredParseError) throw new EvidenceError(`${content.entry.path} could not be parsed: ${error.message}`);
    throw error;
  }
}

function linesOf(content: BlobContent): string[] {
  if (content.text === null) throw new EvidenceError(`${content.entry.path} is binary`);
  const lines = content.text.split("\n");
  if (lines.length > 1 && lines.at(-1) === "") lines.pop();
  return lines;
}

function excerptDigest(text: string): string {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}
