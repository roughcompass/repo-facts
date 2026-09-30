import type { Detector } from "@repo-facts/contract";
import { inventoryDetector } from "./inventory.js";
import { npmLockDetector } from "./lockfiles/npm.js";
import { pnpmLockDetector } from "./lockfiles/pnpm.js";
import { yarnLockDetector } from "./lockfiles/yarn.js";
import { manifestsDetector } from "./manifests.js";
import { packageMetadataDetector } from "./packages.js";
import { runtimeDetector } from "./runtime.js";
import { toolingDetector } from "./tooling.js";

export * from "./inputs.js";
export * from "./inventory.js";
export * from "./knowledge.js";
export * from "./lockfiles/npm.js";
export * from "./lockfiles/pnpm.js";
export * from "./lockfiles/resolved.js";
export * from "./lockfiles/yarn.js";
export * from "./manifests.js";
export * from "./packages.js";
export * from "./runtime.js";
export * from "./tooling.js";
export * from "./versions.js";

/** The core detectors, in the order they run within each stage. */
export const CORE_DETECTORS: readonly Detector[] = [inventoryDetector, manifestsDetector, packageMetadataDetector, toolingDetector, runtimeDetector, npmLockDetector, pnpmLockDetector, yarnLockDetector];
