import { describe, expect, it } from "vitest";
import { type Budgets, MemoryReader, type ReadResult, type SourceReader, describeBlob, isSensitivePath } from "../src/index.js";
import { type ReaderFactory, readerConformanceCases } from "../src/testing/index.js";

const reference: ReaderFactory = async (files, options) => MemoryReader.fromFiles(files, { commit: "c".repeat(40), ...options });

/** Delegates to a reference reader, overriding one behavior to break conformance. */
class BrokenReader implements SourceReader {
  constructor(
    protected readonly inner: MemoryReader,
    private readonly overrides: Partial<Pick<SourceReader, "entries" | "read" | "readMany">> = {},
  ) {}
  get commit() {
    return this.inner.commit;
  }
  get entries() {
    return this.overrides.entries ?? this.inner.entries;
  }
  get budgets() {
    return this.inner.budgets;
  }
  files() {
    return this.entries.filter((entry) => entry.type === "file" || entry.type === "executable");
  }
  entry(path: string) {
    return this.inner.entry(path);
  }
  read(path: string) {
    return this.overrides.read ? this.overrides.read(path) : this.inner.read(path);
  }
  readMany(paths: readonly string[]) {
    return this.overrides.readMany ? this.overrides.readMany(paths) : this.inner.readMany(paths);
  }
  linkTarget(path: string) {
    return this.inner.linkTarget(path);
  }
  diagnostics() {
    return this.inner.diagnostics();
  }
  usage() {
    return this.inner.usage();
  }
}

const broken: Record<string, ReaderFactory> = {
  "lists entries out of order": async (files, options) => {
    const inner = MemoryReader.fromFiles(files, { commit: "c".repeat(40), ...options });
    return new BrokenReader(inner, { entries: [...inner.entries].reverse() });
  },
  "reads credential files": async (files, options) => {
    const inner = MemoryReader.fromFiles(files, { commit: "c".repeat(40), ...options });
    const leak = async (path: string): Promise<ReadResult> => {
      const file = files[path];
      const entry = inner.entry(path);
      if (isSensitivePath(path) && entry && typeof file === "string") return { ok: true, content: describeBlob(entry, Buffer.from(file)) };
      return inner.read(path);
    };
    return new BrokenReader(inner, { read: leak });
  },
  "ignores budgets": async (files, options) => {
    const unlimited: Budgets = { maxBlobBytes: Number.MAX_SAFE_INTEGER, maxFiles: Number.MAX_SAFE_INTEGER, maxTotalBytes: Number.MAX_SAFE_INTEGER };
    return MemoryReader.fromFiles(files, { commit: "c".repeat(40), ...options, budgets: unlimited });
  },
};

/** Names of the cases +factory+ fails. */
async function failures(factory: ReaderFactory): Promise<string[]> {
  const failed: string[] = [];
  for (const test of readerConformanceCases()) {
    try {
      await test.run(factory);
    } catch {
      failed.push(test.name);
    }
  }
  return failed;
}

describe("reader conformance suite", () => {
  for (const test of readerConformanceCases()) {
    it(`the reference reader ${test.name}`, () => test.run(reference));
  }

  it("fails a reader that lists entries out of order", async () => {
    expect(await failures(broken["lists entries out of order"]!)).toEqual([
      "lists the same entries, in code-unit order, with the same modes, types, sizes, and object ids",
      "never lists or reads protected directories, compared case-insensitively",
    ]);
  });

  it("fails a reader that reads credential files", async () => {
    expect(await failures(broken["reads credential files"]!)).toContain("never reads files that commonly hold credentials");
  });

  it("fails a reader that ignores budgets", async () => {
    expect(await failures(broken["ignores budgets"]!)).toEqual([
      "enforces the per-file limit exactly at its boundary",
      "spends file-count and total-byte budgets in path order and never twice for one path",
    ]);
  });
});
