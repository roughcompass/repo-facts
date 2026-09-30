# Source Reader

Detectors see repository content only through a `SourceReader` ([`packages/contract/src/reader/types.ts`](../packages/contract/src/reader/types.ts)). A reader lists a tree and returns the bytes of readable files. It gives no filesystem path, clone URL, or other way to reach content outside it. The same interface covers a pinned Git snapshot, where `commit` is the commit SHA, and a working tree, where `commit` is null.

## The interface

| Member | Returns |
| --- | --- |
| `commit` | The commit being read, or null for a working tree |
| `entries` | Every readable entry, including directories, in code-unit path order |
| `budgets` | The per-file, file-count, and total-byte budgets in force |
| `files()` | Regular and executable files, in path order |
| `entry(path)` | One entry's path, mode, type, size, and Git object id |
| `read(path)`, `readMany(paths)` | Bytes, UTF-8 text, binary classification, and SHA-256 digest, or a skip with its reason |
| `linkTarget(path)` | A symbolic link's target, read as data and never followed |
| `diagnostics()` | Every skipped input so far, in path order |
| `usage()` | Files and bytes read so far |

An entry's object id is its Git object id. For a file, that's the blob id computed from its bytes, so identical bytes have the same id in every reader.

## The read policy

Every reader applies one policy, `ReadPolicy` in [`packages/contract/src/reader/policy.ts`](../packages/contract/src/reader/policy.ts). Each refusal is recorded as a diagnostic with its reason.

| Reason | When |
| --- | --- |
| `path_rejected` | The path is absolute, contains `..`, `.`, empty segments, backslashes, or control characters, or lies inside `.git` |
| `protected_path` | The path lies under a directory the consumer declared protected, matched case-insensitively at any depth |
| `sensitive` | The file commonly holds credentials: npm and Yarn configuration, environment files, netrc files, credential files, and private keys |
| `symlink`, `gitlink` | The entry is a symbolic link or a submodule, recorded as metadata only |
| `not_a_file`, `missing` | The path is a directory or isn't in the tree |
| `blob_too_large` | The file exceeds the per-file budget |
| `file_budget_exhausted`, `total_budget_exhausted` | Reading it would exceed the file-count or total-byte budget |
| `binary` | The content is binary or not valid UTF-8; it's classified without being parsed |

Rejected and protected paths never appear in `entries`. Sensitive files do appear, so detectors can tell that one exists, but their bytes are never read. Budgets are spent in path order within each batch, and a repeated read returns the cached result without spending budget again. The same tree and the same sequence of reads therefore always skip the same inputs.

## Evidence identity

Evidence records ([`packages/contract/src/evidence.ts`](../packages/contract/src/evidence.ts)) carry the reader's `commit`, or null for a working tree. They also carry the path and the object id computed from the bytes. They also carry the content digest, the detector and rule, a location (lines, a JSON or YAML pointer, or a tree entry), and a digest of the cited excerpt. `resolveEvidence(reader, evidence)` re-reads the content and refuses a record whose commit, content, or excerpt no longer matches.

## Implementing a reader

Extend `PolicyReader` and supply only storage. Pass the tree listing through `ReadPolicy.filterEntries`, then implement two methods:

- `fetchBlobs(entries)` returns the bytes of admitted files, keyed by object id.
- `fetchLink(entry)` returns a symbolic link's stored target.

`PolicyReader` applies admission, budgets, caching, and diagnostics identically for every implementation. `MemoryReader` ([`packages/contract/src/reader/memory-reader.ts`](../packages/contract/src/reader/memory-reader.ts)) is the reference implementation. It builds a tree with Git's modes and real blob and tree ids from a map of paths to contents.

## Running the conformance suite

`@repo-facts/contract/testing` exports `readerConformanceCases()`. Each case opens the candidate reader and the reference reader on the same files and requires identical results:

- entries, bytes, and digests
- skips and their reasons, and budgets
- the sensitive-file and protected-directory rules
- link handling and evidence resolution
- detector output, which must match exactly

The cases are plain functions that throw on failure, so any test framework can run them. A product supplies a factory that stores the given files in its own storage and opens its reader on them:

<!-- usage: packages/contract/test/documented-usage.test.ts -->
```ts
import { MemoryReader } from "@repo-facts/contract";
import { type ReaderFactory, readerConformanceCases } from "@repo-facts/contract/testing";
import { describe, it } from "vitest";

// A product passes a factory that stores the files in its own storage and
// opens its reader on them. This example uses the reference reader itself.
const factory: ReaderFactory = async (files, options) => MemoryReader.fromFiles(files, options);

describe("the reader conforms", () => {
  for (const test of readerConformanceCases()) it(test.name, () => test.run(factory));
});
```

This block is the test file it names, which runs with the unit tests, and `test/docs/docs.test.ts` fails if the two differ.
