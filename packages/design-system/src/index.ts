import type { Detector } from "@repo-facts/contract";
import { recognizeDetector } from "./recognize.js";
import { usageDetector } from "./usage.js";

export * from "./catalog.js";
export * from "./catalog-schema.js";
export { ADAPTERS, CATALOGS, CATALOGS_DIGEST } from "./catalogs.generated.js";
export * from "./compile.js";
export * from "./elements.js";
export { RECOGNIZE, type Recognized, importsOf, recognizeDetector } from "./recognize.js";
export * from "./scope.js";
export * from "./styles.js";
export * from "./templates.js";
export { SAMPLES, USAGE, usageDetector } from "./usage.js";
export * from "./values.js";

/** The design-system detectors, in the order they run, over the shipped catalogs. */
export const DESIGN_SYSTEM_DETECTORS: readonly Detector[] = [recognizeDetector(), usageDetector()];
