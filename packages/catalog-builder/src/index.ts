/**
 * The Catalog Builder: writes Reference Catalog entries from published
 * packages, a design system's own published data, and the team's rules. The
 * Frontend Registry runs it as a `catalog.build` job. It's the only part of
 * the system that downloads; Surveyor never imports it.
 */
export { type BuildOptions, type BuildSources, type RegistryBuildOptions, buildEntry, buildFromRegistry, companionVersion, newestVersion } from "./build.js";
export { type DeclaredComponent, type DeclaredProp, declaredComponents } from "./declarations.js";
export { BUILD_FAILURES, type BuildFailure, CatalogBuildError } from "./errors.js";
export { DEFAULT_REGISTRY, type Packument, type PublishedVersion, type RegistryOptions, fetchPackage, fetchPackument, verifyIntegrity } from "./registry.js";
export { type CatalogRules, type ParsedRules, RULES_FORMAT_VERSION, RULE_SECTIONS, parseRules, rulesSchema } from "./rules.js";
export { type SaltData, type SaltDataSections, componentName, readSaltData } from "./salt-data.js";
export { type PackageFiles, TARBALL_LIMITS, readPackage, readTarball, textOf } from "./tarball.js";
export { type CatalogThing, catalogThingSchema } from "./thing.js";
export { type DeclaredToken, declaredTokens } from "./tokens.js";
