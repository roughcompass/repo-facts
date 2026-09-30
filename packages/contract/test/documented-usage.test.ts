import { MemoryReader } from "@repo-facts/contract";
import { type ReaderFactory, readerConformanceCases } from "@repo-facts/contract/testing";
import { describe, it } from "vitest";

// A product passes a factory that stores the files in its own storage and
// opens its reader on them. This example uses the reference reader itself.
const factory: ReaderFactory = async (files, options) => MemoryReader.fromFiles(files, options);

describe("the reader conforms", () => {
  for (const test of readerConformanceCases()) it(test.name, () => test.run(factory));
});
