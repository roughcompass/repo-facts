import type { Detector } from "@repo-facts/contract";
import { serviceDependencyDetector } from "./services.js";
import { serviceSignalsDetector } from "./signals.js";

export { RULES, RULES_DIGEST } from "./rules.generated.js";
export { type ServiceSummary, SERVICE_MATCHES, SERVICE_SUMMARY, deriveEndpoint, identityOf, serviceDependencyDetector } from "./services.js";
export { classify, networkZone, pathsMatch, serviceSignalsDetector } from "./signals.js";

/** The services detectors, in the order they run: signals read what service detection shares. */
export const SERVICE_DETECTORS: readonly Detector[] = [serviceDependencyDetector, serviceSignalsDetector];
