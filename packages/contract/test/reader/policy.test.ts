import { describe, expect, it } from "vitest";
import { type Budgets, MemoryReader, type SkipReason } from "../../src/index.js";

const GENEROUS: Budgets = { maxBlobBytes: 1_000_000, maxFiles: 1_000, maxTotalBytes: 10_000_000 };
const reasons = (reader: MemoryReader) => reader.diagnostics().map(({ path, reason }) => [path, reason]);

describe("the shared read policy", () => {
  it("admits ordinary, executable, empty, and Unicode files and lists entries in code-unit order", async () => {
    const reader = MemoryReader.fromFiles({ "b.txt": "b\n", "Z.txt": "Z\n", "a.txt": "a\n", "bin/run": { content: "#!/bin/sh\n", executable: true }, empty: "", "docs/ünïcödé ✓.md": "Grüße 🌍\n" });
    expect(reader.entries.map((entry) => [entry.path, entry.type])).toEqual([
      ["Z.txt", "file"],
      ["a.txt", "file"],
      ["b.txt", "file"],
      ["bin", "tree"],
      ["bin/run", "executable"],
      ["docs", "tree"],
      ["docs/ünïcödé ✓.md", "file"],
      ["empty", "file"],
    ]);
    const results = await reader.readMany(["docs/ünïcödé ✓.md", "empty", "bin/run"]);
    expect([...results.keys()]).toEqual(["bin/run", "docs/ünïcödé ✓.md", "empty"]);
    expect([...results.values()].map((result) => result.ok && result.content.text)).toEqual(["#!/bin/sh\n", "Grüße 🌍\n", ""]);
    expect(reader.usage()).toEqual({ files: 3, bytes: 10 + Buffer.byteLength("Grüße 🌍\n") });
    expect(reader.diagnostics()).toEqual([]);
  });

  it.each<[string, Record<string, Parameters<typeof MemoryReader.fromFiles>[0][string]>, string, SkipReason]>([
    ["a symbolic link", { link: { symlink: "../../etc/passwd" } }, "link", "symlink"],
    ["a submodule", { "vendor/ui": { gitlink: "1".repeat(40) } }, "vendor/ui", "gitlink"],
    ["a directory", { "src/a.ts": "x" }, "src", "not_a_file"],
    ["a path not in the tree", { "a.txt": "a" }, "b.txt", "missing"],
    ["a traversal-shaped request", { "a.txt": "a" }, "../a.txt", "path_rejected"],
    ["an absolute request", { "a.txt": "a" }, "/a.txt", "path_rejected"],
    ["a request with a control character", { "a.txt": "a" }, "a\u0007.txt", "path_rejected"],
    ["a request inside .git", { "a.txt": "a" }, ".git/config", "path_rejected"],
    ["an npm configuration file", { ".npmrc": "//registry.example.test/:_authToken=secret" }, ".npmrc", "sensitive"],
    ["an environment file", { "apps/web/.env.local": "TOKEN=secret" }, "apps/web/.env.local", "sensitive"],
    ["a private key", { "deploy/id_ed25519": "key" }, "deploy/id_ed25519", "sensitive"],
  ])("skips %s and records why", async (_name, files, path, reason) => {
    const reader = MemoryReader.fromFiles(files);
    expect(await reader.read(path)).toMatchObject({ ok: false, skip: { path, reason } });
    expect(reasons(reader)).toContainEqual([path, reason]);
    expect(reader.usage()).toEqual({ files: 0, bytes: 0 });
  });

  it("drops traversal-shaped, .git, and protected paths from the tree listing, case-insensitively", async () => {
    const reader = MemoryReader.fromFiles(
      { "README.md": "hi\n", "fleet-kit/answers.json": "{}", "nested/Fleet-Kit/more.json": "{}", ".git/config": "[core]", "a/../b": "x" },
      { protectedDirectories: ["fleet-kit"] },
    );
    expect(reader.entries.map((entry) => entry.path)).toEqual(["README.md", "a", "nested"]);
    expect(reasons(reader)).toEqual([
      [".git", "path_rejected"],
      [".git/config", "path_rejected"],
      ["a/..", "path_rejected"],
      ["a/../b", "path_rejected"],
      ["fleet-kit", "protected_path"],
      ["fleet-kit/answers.json", "protected_path"],
      ["nested/Fleet-Kit", "protected_path"],
      ["nested/Fleet-Kit/more.json", "protected_path"],
    ]);
    expect(await reader.read("fleet-kit/answers.json")).toMatchObject({ ok: false, skip: { reason: "protected_path" } });
    expect(reader.usage()).toEqual({ files: 0, bytes: 0 });
  });

  it("classifies binary and invalid UTF-8 content without parsing it", async () => {
    const reader = MemoryReader.fromFiles({ "logo.png": Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00]), "latin1.txt": Buffer.from([0x63, 0x61, 0x66, 0xe9]) });
    const results = await reader.readMany(["logo.png", "latin1.txt"]);
    for (const result of results.values()) expect(result).toMatchObject({ ok: true, content: { binary: true, text: null } });
    expect(reasons(reader)).toEqual([
      ["latin1.txt", "binary"],
      ["logo.png", "binary"],
    ]);
  });

  it("enforces the per-file limit exactly at its boundary", async () => {
    const reader = MemoryReader.fromFiles({ "at.txt": "x".repeat(100), "over.txt": "x".repeat(101) }, { budgets: { ...GENEROUS, maxBlobBytes: 100 } });
    expect(await reader.read("at.txt")).toMatchObject({ ok: true });
    expect(await reader.read("over.txt")).toMatchObject({ ok: false, skip: { reason: "blob_too_large", detail: "101 bytes exceeds the 100-byte limit per file" } });
  });

  it("spends file-count and total-byte budgets in path order, whatever order reads are requested in", async () => {
    const files = { "a.txt": "aaaa", "b.txt": "bbbb", "c.txt": "cccc", "d.txt": "dddd" };
    const byCount = MemoryReader.fromFiles(files, { budgets: { ...GENEROUS, maxFiles: 2 } });
    await byCount.readMany(["d.txt", "c.txt", "b.txt", "a.txt"]);
    expect(reasons(byCount)).toEqual([
      ["c.txt", "file_budget_exhausted"],
      ["d.txt", "file_budget_exhausted"],
    ]);
    const byBytes = MemoryReader.fromFiles(files, { budgets: { ...GENEROUS, maxTotalBytes: 10 } });
    await byBytes.readMany(["c.txt", "a.txt", "d.txt", "b.txt"]);
    expect(reasons(byBytes)).toEqual([
      ["c.txt", "total_budget_exhausted"],
      ["d.txt", "total_budget_exhausted"],
    ]);
    expect(byBytes.usage()).toEqual({ files: 2, bytes: 8 });
  });

  it("returns a cached result for a repeated read without spending budget again", async () => {
    const reader = MemoryReader.fromFiles({ "a.txt": "a\n" });
    await reader.read("a.txt");
    await reader.read("a.txt");
    expect(reader.usage()).toEqual({ files: 1, bytes: 2 });
  });

  it("returns a symbolic link's target as data without following it", async () => {
    const reader = MemoryReader.fromFiles({ escape: { symlink: "../../../../etc/passwd" }, "README.md": "hi" });
    expect(await reader.linkTarget("escape")).toBe("../../../../etc/passwd");
    expect(await reader.linkTarget("README.md")).toBeNull();
    expect(reader.entry("escape")).toMatchObject({ type: "symlink", mode: "120000" });
  });

  it("exposes a working tree's commit as null and a snapshot's commit as given", () => {
    expect(MemoryReader.fromFiles({ a: "a" }).commit).toBeNull();
    expect(MemoryReader.fromFiles({ a: "a" }, { commit: "f".repeat(40) }).commit).toBe("f".repeat(40));
  });
});
