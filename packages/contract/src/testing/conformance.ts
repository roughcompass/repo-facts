import assert from "node:assert/strict";
import type { Detector } from "../detectors/contract.js";
import { runDetectors } from "../detectors/run.js";
import { entryEvidence, lineEvidence, pointerEvidence, resolveEvidence } from "../evidence.js";
import { type MemoryFile, MemoryReader } from "../reader/memory-reader.js";
import type { Budgets, ReadResult, SourceReader } from "../reader/types.js";

/**
 * The reader conformance suite. A product that implements SourceReader over
 * its own storage runs every case with a factory that stores the given files
 * and opens its reader on them. Each case compares the candidate with the
 * reference MemoryReader built from the same files, so two conforming readers
 * given identical content produce identical detector output.
 *
 * Cases are plain functions that throw on failure; run them from any test
 * framework, for example:
 *
 *   for (const test of readerConformanceCases()) it(test.name, () => test.run(factory));
 */

export interface ReaderFactoryOptions {
  budgets?: Budgets;
  protectedDirectories?: readonly string[];
}

export type ReaderFactory = (files: Readonly<Record<string, MemoryFile>>, options: ReaderFactoryOptions) => Promise<SourceReader>;

export interface ConformanceCase {
  name: string;
  run(factory: ReaderFactory): Promise<void>;
}

const GENEROUS: Budgets = { maxBlobBytes: 1_000_000, maxFiles: 1_000, maxTotalBytes: 10_000_000 };

const TREE: Record<string, MemoryFile> = {
  "README.md": "# Orders\n",
  "package.json": '{\n  "name": "orders",\n  "dependencies": { "react": "^18.3.1" }\n}\n',
  "bin/run": { content: "#!/bin/sh\necho run\n", executable: true },
  "src/app.ts": "export const App = () => null;\n",
  "src/ünïcödé ✓.md": "Grüße, 世界 🌍\n",
  "src/empty.ts": "",
  "assets/logo.png": new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]),
  "assets/latin1.txt": new Uint8Array([0x63, 0x61, 0x66, 0xe9]),
  "docs/link": { symlink: "../../../etc/passwd" },
  "vendor/ui": { gitlink: "1".repeat(40) },
  ".npmrc": "//registry.example.test/:_authToken=conformance-secret\n",
  "config/.env.production": "TOKEN=conformance-secret\n",
  "keys/server.pem": "-----BEGIN PRIVATE KEY-----\n",
};

/** Opens the candidate and a reference reader with the candidate's commit over the same files. */
async function pair(factory: ReaderFactory, files: Readonly<Record<string, MemoryFile>> = TREE, options: ReaderFactoryOptions = {}) {
  const candidate = await factory(files, options);
  const reference = MemoryReader.fromFiles(files, { commit: candidate.commit, ...options });
  return { candidate, reference };
}

/** A read result without byte buffers, for comparison. */
const comparable = (result: ReadResult | undefined) =>
  result === undefined ? undefined : result.ok ? { ok: true, entry: result.content.entry, text: result.content.text, binary: result.content.binary, digest: result.content.digest, bytes: result.content.bytes.toString("base64") } : result;

const ALL_PATHS = [...Object.keys(TREE), "src", "missing.ts", "../escape", "/etc/passwd", ".git/config", "src/../README.md", "a\\b"];

export function readerConformanceCases(): ConformanceCase[] {
  return [
    {
      name: "lists the same entries, in code-unit order, with the same modes, types, sizes, and object ids",
      async run(factory) {
        const { candidate, reference } = await pair(factory);
        assert.deepEqual(candidate.entries, reference.entries);
        assert.deepEqual(candidate.files(), reference.files());
        for (const entry of reference.entries) assert.deepEqual(candidate.entry(entry.path), entry, entry.path);
      },
    },
    {
      name: "reads the same bytes, text, and digests, and skips the same inputs for the same reasons",
      async run(factory) {
        const { candidate, reference } = await pair(factory);
        const [actual, expected] = await Promise.all([candidate.readMany(ALL_PATHS), reference.readMany(ALL_PATHS)]);
        assert.deepEqual([...actual.keys()], [...expected.keys()]);
        for (const path of expected.keys()) assert.deepEqual(comparable(actual.get(path)), comparable(expected.get(path)), path);
        assert.deepEqual(candidate.diagnostics(), reference.diagnostics());
        assert.deepEqual(candidate.usage(), reference.usage());
      },
    },
    {
      name: "never reads files that commonly hold credentials",
      async run(factory) {
        const { candidate } = await pair(factory);
        for (const path of [".npmrc", "config/.env.production", "keys/server.pem"]) {
          const result = await candidate.read(path);
          assert.equal(result.ok, false, path);
          assert.equal(!result.ok && result.skip.reason, "sensitive", path);
          assert.ok(candidate.entry(path), `${path} stays visible in the tree listing`);
        }
        assert.deepEqual(candidate.usage(), { files: 0, bytes: 0 });
      },
    },
    {
      name: "never lists or reads protected directories, compared case-insensitively",
      async run(factory) {
        const files = { "README.md": "hi\n", "fleet-kit/answers.json": "{}\n", "nested/Fleet-Kit/more.json": "{}\n" };
        const { candidate, reference } = await pair(factory, files, { protectedDirectories: ["fleet-kit"] });
        assert.deepEqual(candidate.entries, reference.entries);
        const result = await candidate.read("fleet-kit/answers.json");
        assert.equal(!result.ok && result.skip.reason, "protected_path");
        assert.deepEqual(candidate.diagnostics(), reference.diagnostics());
        assert.deepEqual(candidate.usage(), { files: 0, bytes: 0 });
      },
    },
    {
      name: "enforces the per-file limit exactly at its boundary",
      async run(factory) {
        const files = { "at.txt": "x".repeat(100), "over.txt": "x".repeat(101) };
        const { candidate } = await pair(factory, files, { budgets: { ...GENEROUS, maxBlobBytes: 100 } });
        assert.equal((await candidate.read("at.txt")).ok, true);
        const over = await candidate.read("over.txt");
        assert.equal(!over.ok && over.skip.reason, "blob_too_large");
      },
    },
    {
      name: "spends file-count and total-byte budgets in path order and never twice for one path",
      async run(factory) {
        const files = { "a.txt": "aaaa", "b.txt": "bbbb", "c.txt": "cccc", "d.txt": "dddd" };
        for (const budgets of [{ ...GENEROUS, maxFiles: 2 }, { ...GENEROUS, maxTotalBytes: 10 }]) {
          const { candidate, reference } = await pair(factory, files, { budgets });
          await candidate.readMany(["d.txt", "b.txt"]);
          await candidate.readMany(["c.txt", "a.txt", "b.txt"]);
          await reference.readMany(["d.txt", "b.txt"]);
          await reference.readMany(["c.txt", "a.txt", "b.txt"]);
          assert.deepEqual(candidate.diagnostics(), reference.diagnostics());
          assert.deepEqual(candidate.usage(), reference.usage());
        }
      },
    },
    {
      name: "returns link targets as data without following them",
      async run(factory) {
        const { candidate } = await pair(factory);
        assert.equal(await candidate.linkTarget("docs/link"), "../../../etc/passwd");
        assert.equal(await candidate.linkTarget("README.md"), null);
        const read = await candidate.read("docs/link");
        assert.equal(!read.ok && read.skip.reason, "symlink");
      },
    },
    {
      name: "produces evidence that resolves identically against the reference reader",
      async run(factory) {
        const { candidate, reference } = await pair(factory);
        const source = { commit: candidate.commit, detector: "conformance", rule: "conformance" };
        const manifest = await candidate.read("package.json");
        assert.ok(manifest.ok);
        const records = [
          lineEvidence(manifest.content, source, 2),
          pointerEvidence(manifest.content, source, "json", "/dependencies/react"),
          entryEvidence(candidate.entry("bin/run")!, source),
        ];
        for (const record of records) {
          const expected = await resolveEvidence(reference, record);
          assert.equal(expected.ok, true, record.location.kind);
          assert.deepEqual(await resolveEvidence(candidate, record), expected, record.location.kind);
        }
      },
    },
    {
      name: "yields a detector output identical to the reference reader's",
      async run(factory) {
        const { candidate, reference } = await pair(factory);
        const probe: Detector = {
          id: "conformance",
          version: "1",
          stage: "inventory",
          inputs: ["**/*"],
          categories: ["languages"],
          async run(context) {
            const results = await context.reader.readMany(context.reader.files().map((entry) => entry.path));
            for (const [path, result] of results) {
              if (!result.ok || result.content.text === null || result.content.text === "") continue;
              context.fact({ category: "languages", key: path, value: { bytes: result.content.bytes.length }, basis: "observed", evidence: [context.lines(result.content, "conformance.read", 1)], rule: "conformance.read" });
            }
            context.search({ category: "languages", rule: "conformance.read", surface: context.reader.files().map((entry) => entry.path), complete: true, skipped: [] });
          },
        };
        const run = (reader: SourceReader) => runDetectors({ reader, detectorRelease: "0.0.0-conformance", detectors: [probe] });
        assert.deepEqual(await run(candidate), await run(reference));
      },
    },
  ];
}
