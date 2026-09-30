import crypto from "node:crypto";
import { isSensitivePath } from "./sensitive.js";
import type { BlobContent, Budgets, EntryType, ReadResult, SkipDiagnostic, SourceReader, TreeEntry } from "./types.js";

/**
 * The read policy every reader applies, and a base class that applies it.
 *
 * A reader implementation only fetches bytes. The policy decides what may be
 * read: it refuses traversal-shaped paths, `.git`, and consumer-protected
 * directories; never reads files that commonly hold credentials; records
 * symbolic links and submodules as metadata; classifies binary content; and
 * spends per-file, file-count, and total-byte budgets in path order. Every
 * refusal is recorded as a diagnostic.
 */

export const DEFAULT_BUDGETS: Budgets = { maxBlobBytes: 1_048_576, maxFiles: 4_000, maxTotalBytes: 67_108_864 };
export const MAX_LINK_BYTES = 4_096;
const BINARY_SNIFF_BYTES = 8_000;
const utf8 = new TextDecoder("utf-8", { fatal: true });

export interface ReadPolicyOptions {
  /** Directory names that are never read at any depth, compared case-insensitively. */
  protectedDirectories?: readonly string[];
}

export class ReadPolicy {
  private readonly protectedDirectories: readonly string[];

  constructor(options: ReadPolicyOptions = {}) {
    this.protectedDirectories = (options.protectedDirectories ?? []).map((name) => name.toLowerCase());
  }

  /** Refuses paths that could escape or alias outside the tree, `.git`, and protected directories. */
  rejectPath(path: string): SkipDiagnostic | null {
    const segments = path.split("/");
    const control = [...path].some((character) => character.charCodeAt(0) < 0x20);
    if (!path || path.startsWith("/") || path.includes("\\") || control || segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
      return { path, reason: "path_rejected", detail: "The path is not a plain relative path inside the tree" };
    }
    if (segments.some((segment) => segment.toLowerCase() === ".git")) return { path, reason: "path_rejected", detail: "Paths inside .git are never read" };
    const protectedName = segments.find((segment) => this.protectedDirectories.includes(segment.toLowerCase()));
    if (protectedName) return { path, reason: "protected_path", detail: `Paths under a ${protectedName}/ directory are never read` };
    return null;
  }

  /** Splits a raw tree listing into readable entries, in path order, and diagnostics for refused paths. */
  filterEntries(raw: readonly TreeEntry[]): { entries: TreeEntry[]; rejected: SkipDiagnostic[] } {
    const entries: TreeEntry[] = [];
    const rejected: SkipDiagnostic[] = [];
    for (const entry of raw) {
      const problem = this.rejectPath(entry.path);
      if (problem) rejected.push(problem);
      else entries.push(entry);
    }
    entries.sort((a, b) => compareCodeUnits(a.path, b.path));
    rejected.sort((a, b) => compareCodeUnits(a.path, b.path));
    return { entries, rejected };
  }
}

/** Sorts by UTF-16 code unit, independent of locale. */
export function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The entry type for a Git tree mode. */
export function entryTypeOf(mode: string, kind: "blob" | "tree" | "commit" = "blob"): EntryType {
  if (kind === "tree") return "tree";
  if (kind === "commit" || mode === "160000") return "gitlink";
  if (mode === "120000") return "symlink";
  if (mode === "100755") return "executable";
  return "file";
}

/** The Git blob identifier of +bytes+: SHA-1 of `blob <size>\0<bytes>`. */
export function gitBlobId(bytes: Uint8Array): string {
  return crypto.createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

/** Classifies bytes without parsing them: binary content and invalid UTF-8 have no text. */
export function describeBlob(entry: TreeEntry, bytes: Buffer): BlobContent {
  const digest = crypto.createHash("sha256").update(bytes).digest("hex");
  const binary = bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0);
  let text: string | null = null;
  if (!binary) {
    try {
      text = utf8.decode(bytes);
    } catch {
      text = null;
    }
  }
  return { entry, bytes, text, binary: binary || text === null, digest };
}

/**
 * A reader that applies the shared read policy. Implementations supply the
 * already-filtered tree and fetch bytes; admission, budgets, caching, and
 * diagnostics happen here, identically for every implementation.
 */
export abstract class PolicyReader implements SourceReader {
  private readonly byPath: Map<string, TreeEntry>;
  private readonly cache = new Map<string, ReadResult>();
  private readonly skipped = new Map<string, SkipDiagnostic>();
  private filesRead = 0;
  private bytesRead = 0;

  protected constructor(
    readonly commit: string | null,
    readonly entries: readonly TreeEntry[],
    rejected: readonly SkipDiagnostic[],
    readonly budgets: Budgets,
    protected readonly policy: ReadPolicy,
  ) {
    this.byPath = new Map(entries.map((entry) => [entry.path, entry]));
    for (const diagnostic of rejected) this.skipped.set(diagnostic.path, diagnostic);
  }

  /** Fetches the bytes of admitted blob entries, keyed by object id. Missing objects are omitted. */
  protected abstract fetchBlobs(entries: readonly TreeEntry[]): Promise<Map<string, Buffer>>;

  /** Fetches a symbolic link's stored target bytes. */
  protected abstract fetchLink(entry: TreeEntry): Promise<Buffer | null>;

  files(): TreeEntry[] {
    return this.entries.filter((entry) => entry.type === "file" || entry.type === "executable");
  }

  entry(path: string): TreeEntry | undefined {
    return this.byPath.get(path);
  }

  async read(path: string): Promise<ReadResult> {
    return (await this.readMany([path])).get(path)!;
  }

  async readMany(paths: readonly string[]): Promise<Map<string, ReadResult>> {
    const results = new Map<string, ReadResult>();
    const toFetch: TreeEntry[] = [];

    for (const path of [...new Set(paths)].sort(compareCodeUnits)) {
      const cached = this.cache.get(path);
      if (cached) {
        results.set(path, cached);
        continue;
      }
      const decision = this.admit(path);
      if ("skip" in decision) {
        results.set(path, this.remember(path, { ok: false, skip: decision.skip }));
        continue;
      }
      toFetch.push(decision.entry);
    }

    if (toFetch.length) {
      const objects = await this.fetchBlobs(toFetch);
      for (const entry of toFetch) {
        const bytes = objects.get(entry.objectId);
        const result: ReadResult = bytes ? { ok: true, content: describeBlob(entry, bytes) } : { ok: false, skip: { path: entry.path, reason: "missing", detail: `Object ${entry.objectId} is not available` } };
        results.set(entry.path, this.remember(entry.path, result));
      }
    }
    return new Map([...results.entries()].sort(([a], [b]) => compareCodeUnits(a, b)));
  }

  async linkTarget(path: string): Promise<string | null> {
    const entry = this.byPath.get(path);
    if (entry?.type !== "symlink" || (entry.size ?? 0) > MAX_LINK_BYTES) return null;
    const bytes = await this.fetchLink(entry);
    return bytes ? bytes.toString("utf8") : null;
  }

  diagnostics(): SkipDiagnostic[] {
    return [...this.skipped.values()].sort((a, b) => compareCodeUnits(a.path, b.path));
  }

  usage(): { files: number; bytes: number } {
    return { files: this.filesRead, bytes: this.bytesRead };
  }

  private admit(path: string): { entry: TreeEntry } | { skip: SkipDiagnostic } {
    const pathProblem = this.policy.rejectPath(path);
    if (pathProblem) return { skip: pathProblem };

    const entry = this.byPath.get(path);
    if (!entry) return { skip: { path, reason: "missing", detail: "The path is not in the tree" } };
    if (isSensitivePath(path)) return { skip: { path, reason: "sensitive", detail: "Files that commonly hold credentials are recorded but never read" } };
    if (entry.type === "symlink") return { skip: { path, reason: "symlink", detail: "Symbolic links are recorded as metadata and never followed" } };
    if (entry.type === "gitlink") return { skip: { path, reason: "gitlink", detail: "Submodules are recorded as metadata and never fetched" } };
    if (entry.type === "tree") return { skip: { path, reason: "not_a_file", detail: "The path is a directory" } };

    const size = entry.size ?? 0;
    const { maxBlobBytes, maxFiles, maxTotalBytes } = this.budgets;
    if (size > maxBlobBytes) return { skip: { path, reason: "blob_too_large", detail: `${size} bytes exceeds the ${maxBlobBytes}-byte limit per file` } };
    if (this.filesRead >= maxFiles) return { skip: { path, reason: "file_budget_exhausted", detail: `The ${maxFiles}-file analysis budget was already used` } };
    if (this.bytesRead + size > maxTotalBytes) return { skip: { path, reason: "total_budget_exhausted", detail: `Reading ${size} more bytes would exceed the ${maxTotalBytes}-byte analysis budget` } };

    this.filesRead++;
    this.bytesRead += size;
    return { entry };
  }

  private remember(path: string, result: ReadResult): ReadResult {
    this.cache.set(path, result);
    if (!result.ok) this.skipped.set(path, result.skip);
    else if (result.content.binary) this.skipped.set(path, { path, reason: "binary", detail: "Binary content is inventoried but not parsed" });
    return result;
  }
}
