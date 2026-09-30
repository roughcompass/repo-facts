import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MemoryReader, gitBlobId } from "../../src/index.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@repo-facts.invalid", ...args], { cwd, encoding: "utf8" });

describe("reference reader object identity", () => {
  it.each([
    ["text", Buffer.from("export const answer = 42;\n")],
    ["binary", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x10])],
    ["empty", Buffer.alloc(0)],
    ["Unicode", Buffer.from("Grüße, 世界 🌍\n")],
  ])("computes the same blob id as git hash-object for %s bytes", (_name, bytes) => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "repo-facts-blob-")), "blob");
    fs.writeFileSync(file, bytes);
    expect(gitBlobId(bytes)).toBe(execFileSync("git", ["hash-object", file], { encoding: "utf8" }).trim());
  });

  it("lists the same modes and blob and tree ids as a real Git tree", () => {
    const files = {
      "README.md": "# Orders\n",
      "package.json": '{ "name": "orders" }\n',
      "bin/run": { content: "#!/bin/sh\necho hi\n", executable: true as const },
      "src/app.ts": "export {};\n",
      "src/app-utils/index.ts": "export const x = 1;\n",
      "src/app.test.ts": "import './app';\n",
      "docs/link": { symlink: "../README.md" },
    };
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "repo-facts-tree-"));
    for (const [file, content] of Object.entries(files)) {
      const target = path.join(root, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      if (typeof content === "string") fs.writeFileSync(target, content);
      else if ("symlink" in content) fs.symlinkSync(content.symlink, target);
      else fs.writeFileSync(target, content.content, { mode: 0o755 });
    }
    git(root, "init", "--quiet");
    git(root, "add", "--all");
    git(root, "commit", "--quiet", "-m", "fixture");
    const listing = git(root, "ls-tree", "-r", "-t", "--full-tree", "HEAD")
      .trim()
      .split("\n")
      .map((line) => {
        const [meta, file] = line.split("\t");
        const [mode, , objectId] = meta!.split(" ");
        return [file, mode, objectId];
      })
      .sort(([a], [b]) => (a! < b! ? -1 : a! > b! ? 1 : 0));

    const reader = MemoryReader.fromFiles(files);
    expect(reader.entries.map((entry) => [entry.path, entry.mode, entry.objectId])).toEqual(listing);
    expect(reader.entry("bin/run")?.type).toBe("executable");
    expect(reader.entry("docs/link")?.type).toBe("symlink");
    expect(reader.entry("src")?.type).toBe("tree");
  });
});
