import { type Budgets, type CategoryDefinition, type Detector, type DetectorRunOptions, FACT_DOCUMENT_SCHEMA, FACT_DOCUMENT_VERSION, type FactDocument, type JsonObject, type SourceReader, digestOf, runDetectors } from "@repo-facts/contract";
import { ARCHITECTURE_DETECTORS, RULES_DIGEST as ARCHITECTURE_RULES_DIGEST } from "@repo-facts/architecture";
import { CORE_DETECTORS } from "@repo-facts/core";
import { SERVICE_DETECTORS, RULES_DIGEST as SERVICE_RULES_DIGEST } from "@repo-facts/services";
import { SYNTAX_DEPTH_LIMIT, SYNTAX_NODE_LIMIT, SYNTAX_PARSER } from "@repo-facts/syntax";
import { DETECTOR_RELEASE } from "./release.js";

/**
 * One tested set of detectors: a detector release. Consumers pin this
 * package's exact version, record DETECTOR_RELEASE and the configuration
 * digest with every fact document, and can reproduce a document exactly from
 * the same content, release, and configuration.
 */

export { DETECTOR_RELEASE };

/** Every detector in the release, in the order they run within each stage. */
export const DETECTORS: readonly Detector[] = [...CORE_DETECTORS, ...ARCHITECTURE_DETECTORS, ...SERVICE_DETECTORS];

export const DETECTOR_CONFIGURATION_SCHEMA = "repo_facts.detector_configuration";

export interface ConfigurationParts {
  release: string;
  detectors: readonly Pick<Detector, "id" | "version" | "stage">[];
  parser: { name: string; version: string; maxNodes: number; maxDepth: number };
  limits: Budgets;
  /** Digest of the compiled syntax rules shipped with the release. */
  rulesDigest: string;
}

/** The canonical detector configuration for +parts+. */
export function configurationFor(parts: ConfigurationParts): JsonObject {
  return {
    schema: DETECTOR_CONFIGURATION_SCHEMA,
    schema_version: 1,
    release: parts.release,
    fact_document: { schema: FACT_DOCUMENT_SCHEMA, schema_version: FACT_DOCUMENT_VERSION },
    detectors: parts.detectors.map((detector) => ({ id: detector.id, version: detector.version, stage: detector.stage })),
    syntax: { parser: parts.parser.name, parser_version: parts.parser.version, max_nodes: parts.parser.maxNodes, max_depth: parts.parser.maxDepth },
    limits: { max_blob_bytes: parts.limits.maxBlobBytes, max_files: parts.limits.maxFiles, max_total_bytes: parts.limits.maxTotalBytes },
    rules: { digest: parts.rulesDigest },
  };
}

/** The digest of every compiled syntax rule this release ships, by package. */
const RULES_DIGEST = digestOf({ architecture: ARCHITECTURE_RULES_DIGEST, services: SERVICE_RULES_DIGEST }).digest;

/** This release's configuration under the reader limits +limits+, and its SHA-256 digest. */
export function detectorConfiguration(limits: Budgets): { configuration: JsonObject; digest: string } {
  const configuration = configurationFor({
    release: DETECTOR_RELEASE,
    detectors: DETECTORS,
    parser: { name: SYNTAX_PARSER.name, version: SYNTAX_PARSER.version, maxNodes: SYNTAX_NODE_LIMIT, maxDepth: SYNTAX_DEPTH_LIMIT },
    limits,
    rulesDigest: RULES_DIGEST,
  });
  return { configuration, digest: digestOf(configuration).digest };
}

export interface AnalyzeOptions {
  extensions?: readonly CategoryDefinition[];
  signal?: AbortSignal;
  checkpoint?: DetectorRunOptions["checkpoint"];
}

/** Runs this release's detectors over +reader+. */
export function analyze(reader: SourceReader, options: AnalyzeOptions = {}): Promise<FactDocument> {
  return runDetectors({
    reader,
    detectorRelease: DETECTOR_RELEASE,
    detectors: DETECTORS,
    ...(options.extensions && { extensions: options.extensions }),
    ...(options.signal && { signal: options.signal }),
    ...(options.checkpoint && { checkpoint: options.checkpoint }),
  });
}
