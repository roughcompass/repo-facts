import { type FactDocument, MemoryReader, type MemoryFile, factDocumentProblems, runDetectors } from "@repo-facts/contract";
import { CORE_DETECTORS } from "@repo-facts/core";
import { expect } from "vitest";
import { DESIGN_SYSTEM_DETECTORS } from "../src/index.js";

export const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

/** Runs the core and design-system detectors over +files+, and checks the document is valid. */
export async function profile(files: Record<string, MemoryFile>) {
  const reader = MemoryReader.fromFiles(files, { commit: "a".repeat(40) });
  const document = await runDetectors({ reader, detectorRelease: "0.1.0", detectors: [...CORE_DETECTORS, ...DESIGN_SYSTEM_DETECTORS] });
  expect(factDocumentProblems(document)).toEqual([]);
  return document;
}

export const facts = (document: FactDocument, category: string) => document.categories[category]!.facts;
export const fact = (document: FactDocument, category: string, key: string) => facts(document, category).find((item) => item.key === key);

/** A fact's evidence as `path:line` or `path#pointer`, sorted. */
export const cited = (document: FactDocument, category: string, key: string) =>
  fact(document, category, key)!.evidence.map((id) => {
    const { path, location } = document.evidence[id]!;
    return `${path}${location.kind === "lines" ? `:${location.start}` : location.kind === "pointer" ? `#${location.pointer}` : ""}`;
  }).sort();
