import { type Budgets, type Detector, MemoryReader, type MemoryFile, runDetectors } from "@repo-facts/contract";
import { CORE_DETECTORS } from "../src/index.js";

export type FileTree = Record<string, MemoryFile>;

export const COMMIT = "a".repeat(40);

/** A snapshot of +files+ at a fixed commit, under the shared read policy. */
export const snapshotOf = (files: FileTree, budgets?: Budgets) => MemoryReader.fromFiles(files, { commit: COMMIT, ...(budgets && { budgets }) });

/** Runs the core detectors (or +detectors+) over a snapshot of +files+. */
export async function profile(files: FileTree, options: { detectors?: readonly Detector[]; budgets?: Budgets } = {}) {
  const reader = snapshotOf(files, options.budgets);
  const document = await runDetectors({ reader, detectorRelease: "0.1.0", detectors: options.detectors ?? CORE_DETECTORS });
  return { document, reader };
}
