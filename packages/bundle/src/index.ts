import { type Budgets, type CategoryDefinition, type Detector, type DetectorRunOptions, FACT_DOCUMENT_SCHEMA, FACT_DOCUMENT_VERSION, type FactDocument, type JsonObject, type SourceReader, digestOf, runDetectors } from "@repo-facts/contract";
import { ARCHITECTURE_DETECTORS, RULES_DIGEST as ARCHITECTURE_RULES_DIGEST } from "@repo-facts/architecture";
import { CORE_DETECTORS } from "@repo-facts/core";
import { ADAPTERS_DIGEST, designSystemDetectors } from "@repo-facts/design-system";
import { SERVICE_DETECTORS, RULES_DIGEST as SERVICE_RULES_DIGEST } from "@repo-facts/services";
import { STYLESHEET_DEPTH_LIMIT, STYLESHEET_NODE_LIMIT, STYLESHEET_PARSER, SYNTAX_DEPTH_LIMIT, SYNTAX_NODE_LIMIT, SYNTAX_PARSER } from "@repo-facts/syntax";
import { SURVEYOR_RELEASE } from "./release.js";

/**
 * One tested set of detectors: a Surveyor release. Consumers pin this
 * package's exact version, record SURVEYOR_RELEASE and the configuration
 * digest with every fact document, and can reproduce a document exactly from
 * the same content, release, configuration, and Reference Catalog entries.
 * Entries aren't part of a release: they're supplied for each survey, and
 * the fact document names each one it used with its digest.
 */

export { SURVEYOR_RELEASE };

/** Every detector in the release, comparing against +entries+, in the order they run within each stage. */
export function detectorsFor(entries: readonly unknown[] = []): readonly Detector[] {
  return [...CORE_DETECTORS, ...ARCHITECTURE_DETECTORS, ...designSystemDetectors(entries), ...SERVICE_DETECTORS];
}

/** Every detector in the release, in the order they run within each stage. */
export const DETECTORS: readonly Detector[] = detectorsFor();

export const DETECTOR_CONFIGURATION_SCHEMA = "repo_facts.detector_configuration";

export interface ConfigurationParts {
  release: string;
  detectors: readonly Pick<Detector, "id" | "version" | "stage">[];
  parser: { name: string; version: string; maxNodes: number; maxDepth: number };
  stylesheetParser: { name: string; version: string; maxNodes: number; maxDepth: number };
  limits: Budgets;
  /** Digest of the compiled syntax rules shipped with the release. */
  rulesDigest: string;
  /** Digest of the compiled styling-adapter catalog shipped with the release. */
  adaptersDigest: string;
}

/** The canonical detector configuration for +parts+. */
export function configurationFor(parts: ConfigurationParts): JsonObject {
  return {
    schema: DETECTOR_CONFIGURATION_SCHEMA,
    schema_version: 4,
    release: parts.release,
    fact_document: { schema: FACT_DOCUMENT_SCHEMA, schema_version: FACT_DOCUMENT_VERSION },
    detectors: parts.detectors.map((detector) => ({ id: detector.id, version: detector.version, stage: detector.stage })),
    syntax: { parser: parts.parser.name, parser_version: parts.parser.version, max_nodes: parts.parser.maxNodes, max_depth: parts.parser.maxDepth },
    stylesheets: { parser: parts.stylesheetParser.name, parser_version: parts.stylesheetParser.version, max_nodes: parts.stylesheetParser.maxNodes, max_depth: parts.stylesheetParser.maxDepth },
    limits: { max_blob_bytes: parts.limits.maxBlobBytes, max_lockfile_bytes: parts.limits.maxLockfileBytes, max_files: parts.limits.maxFiles, max_total_bytes: parts.limits.maxTotalBytes },
    rules: { digest: parts.rulesDigest },
    adapters: { digest: parts.adaptersDigest },
  };
}

/** The digest of every compiled syntax rule this release ships, by package. */
const RULES_DIGEST = digestOf({ architecture: ARCHITECTURE_RULES_DIGEST, services: SERVICE_RULES_DIGEST }).digest;

/** This release's configuration under the reader limits +limits+, and its SHA-256 digest. */
export function detectorConfiguration(limits: Budgets): { configuration: JsonObject; digest: string } {
  const configuration = configurationFor({
    release: SURVEYOR_RELEASE,
    detectors: DETECTORS,
    parser: { name: SYNTAX_PARSER.name, version: SYNTAX_PARSER.version, maxNodes: SYNTAX_NODE_LIMIT, maxDepth: SYNTAX_DEPTH_LIMIT },
    stylesheetParser: { name: STYLESHEET_PARSER.name, version: STYLESHEET_PARSER.version, maxNodes: STYLESHEET_NODE_LIMIT, maxDepth: STYLESHEET_DEPTH_LIMIT },
    limits,
    rulesDigest: RULES_DIGEST,
    adaptersDigest: ADAPTERS_DIGEST,
  });
  return { configuration, digest: digestOf(configuration).digest };
}

export interface AnalyzeOptions {
  /**
   * The Reference Catalog entries to compare against, as stored: every
   * current entry of each described thing. For each thing the repository
   * uses, Surveyor picks the entry for its version. An entry in a format this
   * release doesn't read is left out, with a diagnostic. Defaults to none,
   * which recognizes no design system.
   */
  entries?: readonly unknown[];
  extensions?: readonly CategoryDefinition[];
  signal?: AbortSignal;
  checkpoint?: DetectorRunOptions["checkpoint"];
}

/** Runs this release's detectors over +reader+, comparing against +options.entries+. */
export function analyze(reader: SourceReader, options: AnalyzeOptions = {}): Promise<FactDocument> {
  return runDetectors({
    reader,
    surveyorRelease: SURVEYOR_RELEASE,
    detectors: detectorsFor(options.entries ?? []),
    ...(options.extensions && { extensions: options.extensions }),
    ...(options.signal && { signal: options.signal }),
    ...(options.checkpoint && { checkpoint: options.checkpoint }),
  });
}
