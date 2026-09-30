/**
 * What detectors can see of a repository: an ordered tree listing and the
 * bytes of readable files. Nothing else about the repository, such as a
 * filesystem path, clone URL, or configuration, is reachable through it.
 */

export type EntryType = "file" | "executable" | "symlink" | "gitlink" | "tree";

export interface TreeEntry {
  path: string;
  mode: string;
  type: EntryType;
  /** The Git object identifier: the blob id computed from the bytes, the tree id, or a submodule's commit. */
  objectId: string;
  /** Blob size in bytes; null for trees and Git links. */
  size: number | null;
}

export type SkipReason =
  | "blob_too_large"
  | "file_budget_exhausted"
  | "total_budget_exhausted"
  | "binary"
  | "symlink"
  | "gitlink"
  | "not_a_file"
  | "path_rejected"
  | "protected_path"
  | "sensitive"
  | "missing";

export interface SkipDiagnostic {
  path: string;
  reason: SkipReason;
  detail: string;
}

export interface BlobContent {
  entry: TreeEntry;
  bytes: Buffer;
  /** UTF-8 text, or null when the content is binary or not valid UTF-8. */
  text: string | null;
  binary: boolean;
  /** SHA-256 of the blob bytes, hex. */
  digest: string;
}

export type ReadResult = { ok: true; content: BlobContent } | { ok: false; skip: SkipDiagnostic };

export interface Budgets {
  maxBlobBytes: number;
  maxFiles: number;
  maxTotalBytes: number;
}

export interface SourceReader {
  /** The commit being read, or null for a working tree. */
  readonly commit: string | null;
  /** Every readable entry, including trees, in code-unit path order. */
  readonly entries: readonly TreeEntry[];
  readonly budgets: Budgets;
  /** Blob entries (regular and executable files), in path order. */
  files(): TreeEntry[];
  entry(path: string): TreeEntry | undefined;
  read(path: string): Promise<ReadResult>;
  /** Reads several paths; results come back in path order and budgets are spent in path order. */
  readMany(paths: readonly string[]): Promise<Map<string, ReadResult>>;
  /** A symbolic link's target, read as data and never followed. */
  linkTarget(path: string): Promise<string | null>;
  /** Every skipped input so far, in path order. */
  diagnostics(): SkipDiagnostic[];
  usage(): { files: number; bytes: number };
}
