import type { Detector } from "@repo-facts/contract";
import { compositionDetector } from "./composition.js";
import { packageRelationsDetector } from "./packages.js";

export { compositionDetector, htmlImportMaps } from "./composition.js";
export { packageRelationsDetector } from "./packages.js";
export { RULES, RULES_DIGEST } from "./rules.generated.js";

/** The architecture detectors, in the order they run. */
export const ARCHITECTURE_DETECTORS: readonly Detector[] = [packageRelationsDetector, compositionDetector];
