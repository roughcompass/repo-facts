import crypto from "node:crypto";
import { DEFAULT_BUDGETS, PolicyReader, ReadPolicy, type ReadPolicyOptions, compareCodeUnits, gitBlobId } from "./policy.js";
import type { Budgets, TreeEntry } from "./types.js";

/**
 * The reference reader: a tree held in memory, with Git's modes and object
 * identifiers, under the shared read policy. Tests and fixtures use it, and
 * the conformance suite compares other readers against it.
 */

export type MemoryFile = string | Uint8Array | { content: string | Uint8Array; executable: true } | { symlink: string } | { gitlink: string };

export interface MemoryReaderOptions extends ReadPolicyOptions {
  /** The commit this tree represents, or null for a working tree (the default). */
  commit?: string | null;
  budgets?: Budgets;
}

interface Node {
  entry: TreeEntry;
  bytes?: Buffer;
}

export class MemoryReader extends PolicyReader {
  private constructor(
    commit: string | null,
    entries: TreeEntry[],
    rejected: ReturnType<ReadPolicy["filterEntries"]>["rejected"],
    budgets: Budgets,
    policy: ReadPolicy,
    private readonly blobs: ReadonlyMap<string, Buffer>,
  ) {
    super(commit, entries, rejected, budgets, policy);
  }

  static fromFiles(files: Readonly<Record<string, MemoryFile>>, options: MemoryReaderOptions = {}): MemoryReader {
    const nodes = new Map<string, Node>();
    for (const [path, file] of Object.entries(files)) {
      const node = leaf(path, file);
      nodes.set(path, node);
      // Parent directories become tree entries, like a Git tree listing.
      const segments = path.split("/");
      for (let depth = 1; depth < segments.length; depth++) {
        const directory = segments.slice(0, depth).join("/");
        if (!nodes.has(directory)) nodes.set(directory, { entry: { path: directory, mode: "040000", type: "tree", objectId: "", size: null } });
      }
    }
    assignTreeIds(nodes);

    const policy = new ReadPolicy(options);
    const { entries, rejected } = policy.filterEntries([...nodes.values()].map((node) => node.entry));
    const blobs = new Map<string, Buffer>();
    for (const node of nodes.values()) if (node.bytes) blobs.set(node.entry.objectId, node.bytes);
    return new MemoryReader(options.commit ?? null, entries, rejected, options.budgets ?? DEFAULT_BUDGETS, policy, blobs);
  }

  protected async fetchBlobs(entries: readonly TreeEntry[]): Promise<Map<string, Buffer>> {
    const objects = new Map<string, Buffer>();
    for (const entry of entries) {
      const bytes = this.blobs.get(entry.objectId);
      if (bytes) objects.set(entry.objectId, bytes);
    }
    return objects;
  }

  protected async fetchLink(entry: TreeEntry): Promise<Buffer | null> {
    return this.blobs.get(entry.objectId) ?? null;
  }
}

function leaf(path: string, file: MemoryFile): Node {
  if (typeof file === "object" && !(file instanceof Uint8Array) && "gitlink" in file) {
    return { entry: { path, mode: "160000", type: "gitlink", objectId: file.gitlink, size: null } };
  }
  const [bytes, mode] =
    typeof file === "string" || file instanceof Uint8Array
      ? [Buffer.from(file), "100644"]
      : "symlink" in file
        ? [Buffer.from(file.symlink), "120000"]
        : [Buffer.from(file.content), "100755"];
  const type = mode === "120000" ? "symlink" : mode === "100755" ? "executable" : "file";
  return { entry: { path, mode, type, objectId: gitBlobId(bytes), size: bytes.length }, bytes };
}

/** Computes Git tree object ids bottom-up: SHA-1 of `tree <size>\0` and the sorted entries. */
function assignTreeIds(nodes: Map<string, Node>) {
  const trees = [...nodes.values()].filter((node) => node.entry.type === "tree").sort((a, b) => b.entry.path.split("/").length - a.entry.path.split("/").length);
  const childrenOf = (directory: string) => [...nodes.values()].filter((node) => parentOf(node.entry.path) === directory);
  for (const tree of trees) tree.entry.objectId = treeId(childrenOf(tree.entry.path));
}

function parentOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

function treeId(children: readonly Node[]): string {
  const name = (node: Node) => node.entry.path.slice(node.entry.path.lastIndexOf("/") + 1);
  // Git orders tree entries by name, comparing a subtree as if its name ended in "/".
  const sortKey = (node: Node) => (node.entry.type === "tree" ? `${name(node)}/` : name(node));
  const body = Buffer.concat(
    [...children]
      .sort((a, b) => compareCodeUnits(sortKey(a), sortKey(b)))
      .map((node) => Buffer.concat([Buffer.from(`${node.entry.type === "tree" ? "40000" : node.entry.mode} ${name(node)}\0`), Buffer.from(node.entry.objectId, "hex")])),
  );
  return crypto.createHash("sha1").update(`tree ${body.length}\0`).update(body).digest("hex");
}
