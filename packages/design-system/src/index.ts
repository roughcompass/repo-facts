import type { Detector } from "@repo-facts/contract";
import { recognizeDetector } from "./recognize.js";
import { usageDetector } from "./usage.js";

export { ADAPTERS, ADAPTERS_DIGEST } from "./adapters.generated.js";
export * from "./catalog.js";
export * from "./catalog-schema.js";
export * from "./compile.js";
export * from "./elements.js";
export { RECOGNIZE, type Recognized, importsOf, recognizeDetector, wantedVersion } from "./recognize.js";
export * from "./scope.js";
export * from "./styles.js";
export * from "./templates.js";
export { SAMPLES, USAGE, usageDetector } from "./usage.js";
export * from "./values.js";

/**
 * The design-system detectors, in the order they run, comparing against
 * +entries+: the Reference Catalog entries supplied for a survey, as stored.
 * With none, no design system is recognized.
 */
export function designSystemDetectors(entries: readonly unknown[] = []): readonly Detector[] {
  return [recognizeDetector(entries), usageDetector()];
}

/** The design-system detectors with no entries, for describing the release. */
export const DESIGN_SYSTEM_DETECTORS: readonly Detector[] = designSystemDetectors();
