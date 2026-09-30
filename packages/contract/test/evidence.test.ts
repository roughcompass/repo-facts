import { describe, expect, it, beforeEach } from "vitest";
import { type BlobContent, type Evidence, EvidenceError, MemoryReader, entryEvidence, evidenceId, gitBlobId, lineEvidence, pointerEvidence, pointerOf, resolveEvidence } from "../src/index.js";

const PACKAGE_JSON = `{
  "name": "orders-ui",
  "dependencies": {
    "react": "^18.3.1",
    "@acme/ui": "2.0.0"
  },
  "scripts": { "test": "vitest run" }
}
`;

const WORKFLOW = `name: CI
on: [push]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm test
`;

const FILES = { "package.json": PACKAGE_JSON, ".github/workflows/ci.yml": WORKFLOW, "src/app.ts": "import React from 'react';\nexport const App = () => null;\n" };

/** A snapshot of the fixture files (with +changes+) at +commit+. */
const snapshot = (changes: Record<string, string> = {}, commit: string | null = "a".repeat(40)) => MemoryReader.fromFiles({ ...FILES, ...changes }, { commit });

const contentOf = async (reader: MemoryReader, path: string): Promise<BlobContent> => {
  const result = await reader.read(path);
  if (!result.ok) throw new Error(result.skip.detail);
  return result.content;
};

describe("evidence locators", () => {
  it("records and resolves a line range to the committed lines", async () => {
    const reader = snapshot();
    const source = { commit: reader.commit, detector: "architecture", rule: "react-import" };
    const evidence = lineEvidence(await contentOf(reader, "src/app.ts"), source, 1);

    expect(evidence).toMatchObject({ commit: reader.commit, path: "src/app.ts", detector: "architecture", rule: "react-import", location: { kind: "lines", start: 1, end: 1 } });
    expect(evidence.content_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(await resolveEvidence(reader, evidence)).toMatchObject({ ok: true, excerpt: "import React from 'react';", lines: { start: 1, end: 1 } });
  });

  it("records and resolves a JSON pointer, with the line range it occupies", async () => {
    const reader = snapshot();
    const evidence = pointerEvidence(await contentOf(reader, "package.json"), { commit: reader.commit, detector: "manifest", rule: "dependency" }, "json", pointerOf(["dependencies", "@acme/ui"]));

    expect(evidence.location).toEqual({ kind: "pointer", format: "json", pointer: "/dependencies/@acme~1ui" });
    expect(await resolveEvidence(reader, evidence)).toMatchObject({ ok: true, excerpt: '"2.0.0"', lines: { start: 5, end: 5 } });
  });

  it("records and resolves a YAML pointer into a CI workflow", async () => {
    const reader = snapshot();
    const evidence = pointerEvidence(await contentOf(reader, ".github/workflows/ci.yml"), { commit: reader.commit, detector: "ci", rule: "run-step" }, "yaml", "/jobs/test/steps/1/run");

    expect(await resolveEvidence(reader, evidence)).toMatchObject({ ok: true, excerpt: '"npm test"', lines: { start: 8, end: 8 } });
  });

  it("records an entry's presence and mode without its bytes", async () => {
    const reader = snapshot();
    const evidence = entryEvidence(reader.entry("package.json")!, { commit: reader.commit, detector: "inventory", rule: "manifest" });

    expect(evidence.location).toEqual({ kind: "entry" });
    expect(await resolveEvidence(reader, evidence)).toMatchObject({ ok: true, lines: null });
  });

  it("derives a stable id from everything the record asserts", async () => {
    const reader = snapshot();
    const content = await contentOf(reader, "src/app.ts");
    const source = { commit: reader.commit, detector: "architecture", rule: "react-import" };

    expect(lineEvidence(content, source, 1).id).toBe(lineEvidence(content, source, 1).id);
    expect(lineEvidence(content, { ...source, rule: "other" }, 1).id).not.toBe(lineEvidence(content, source, 1).id);
    expect(lineEvidence(content, source, 1).id).toMatch(/^ev_[0-9a-f]{24}$/);
  });

  it("refuses to create evidence for lines or pointers that do not exist", async () => {
    const reader = snapshot();
    const source = { commit: reader.commit, detector: "d", rule: "r" };

    const app = await contentOf(reader, "src/app.ts");
    const manifest = await contentOf(reader, "package.json");
    expect(() => lineEvidence(app, source, 3)).toThrow(EvidenceError);
    expect(() => lineEvidence(app, source, 2, 1)).toThrow(EvidenceError);
    expect(() => pointerEvidence(manifest, source, "json", "/dependencies/vue")).toThrow(EvidenceError);
  });

  describe("stale and mismatched evidence", () => {
    let original: MemoryReader;
    let evidence: Evidence;

    beforeEach(async () => {
      original = snapshot();
      evidence = lineEvidence(await contentOf(original, "src/app.ts"), { commit: original.commit, detector: "architecture", rule: "react-import" }, 1);
    });

    const reissue = (changes: Partial<Evidence>): Evidence => {
      const fields = { ...evidence, ...changes };
      return { ...fields, id: evidenceId(fields) };
    };

    it("refuses evidence from another commit", async () => {
      const later = snapshot({ "src/app.ts": "import { h } from 'preact';\nexport const App = () => null;\n" }, "b".repeat(40));

      expect(await resolveEvidence(later, evidence)).toMatchObject({ ok: false, reason: "commit_mismatch" });
      expect(await resolveEvidence(later, reissue({ commit: later.commit }))).toMatchObject({ ok: false, reason: "content_changed" });
    });

    it("refuses a record whose fields were altered", async () => {
      expect(await resolveEvidence(original, { ...evidence, rule: "forged" })).toMatchObject({ ok: false, reason: "id_mismatch" });
    });

    it("refuses a record whose excerpt no longer matches the cited lines", async () => {
      expect(await resolveEvidence(original, reissue({ location: { kind: "lines", start: 2, end: 2 } }))).toMatchObject({ ok: false, reason: "excerpt_changed" });
      expect(await resolveEvidence(original, reissue({ location: { kind: "lines", start: 1, end: 9 } }))).toMatchObject({ ok: false, reason: "location_invalid" });
    });

    it("refuses a record for a path or content digest that is not in the snapshot", async () => {
      expect(await resolveEvidence(original, reissue({ path: "src/missing.ts" }))).toMatchObject({ ok: false, reason: "path_missing" });
      expect(await resolveEvidence(original, reissue({ content_digest: "0".repeat(64) }))).toMatchObject({ ok: false, reason: "content_changed" });
    });
  });

  describe("working trees", () => {
    it("records evidence without a commit, identified by the blob id of its bytes", async () => {
      const reader = snapshot({}, null);
      const evidence = lineEvidence(await contentOf(reader, "src/app.ts"), { commit: reader.commit, detector: "architecture", rule: "react-import" }, 1);
      expect(evidence.commit).toBeNull();
      expect(evidence.object_id).toBe(gitBlobId(Buffer.from(FILES["src/app.ts"])));
      expect(await resolveEvidence(reader, evidence)).toMatchObject({ ok: true, excerpt: "import React from 'react';" });
    });

    it("refuses to resolve working-tree evidence against a snapshot, or the reverse", async () => {
      const tree = snapshot({}, null);
      const pinned = snapshot();
      const fromTree = lineEvidence(await contentOf(tree, "src/app.ts"), { commit: null, detector: "d", rule: "r" }, 1);
      const fromSnapshot = lineEvidence(await contentOf(pinned, "src/app.ts"), { commit: pinned.commit, detector: "d", rule: "r" }, 1);
      expect(await resolveEvidence(pinned, fromTree)).toMatchObject({ ok: false, reason: "commit_mismatch" });
      expect(await resolveEvidence(tree, fromSnapshot)).toMatchObject({ ok: false, reason: "commit_mismatch" });
    });

    it("refuses working-tree evidence after the file changed", async () => {
      const before = snapshot({}, null);
      const evidence = lineEvidence(await contentOf(before, "src/app.ts"), { commit: null, detector: "d", rule: "r" }, 1);
      const after = snapshot({ "src/app.ts": "import { h } from 'preact';\n" }, null);
      expect(await resolveEvidence(after, evidence)).toMatchObject({ ok: false, reason: "content_changed" });
    });
  });
});
