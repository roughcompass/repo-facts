import type { Detector } from "@repo-facts/contract";
import { serviceDependencyDetector } from "./services.js";

export { RULES, RULES_DIGEST } from "./rules.generated.js";
export { deriveEndpoint, identityOf, serviceDependencyDetector } from "./services.js";

/** The services detectors, in the order they run. */
export const SERVICE_DETECTORS: readonly Detector[] = [serviceDependencyDetector];
