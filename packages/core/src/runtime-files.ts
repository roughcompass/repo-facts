import type { BlobContent, Detector, DetectorContext } from "@repo-facts/contract";
import { readableInputs, unanalyzedInputs } from "./inventory.js";
import type { Runtime } from "./knowledge.js";
import { type RuntimeDeclaration, shareRuntimeInputs } from "./runtime.js";

/**
 * Node.js and package-manager versions declared by runtime files: `.nvmrc`,
 * `.node-version`, `.tool-versions`, and Dockerfile `FROM node` lines. Each is
 * handed to the runtime detector, which compares every declaration of a
 * runtime. A declaration that names no fixed version, such as `lts/*` or the
 * `latest` image tag, is passed on as written and becomes a skipped input.
 */

/** Node.js LTS codenames and their major versions, for this detector release. */
export const NODE_LTS_CODENAMES: Readonly<Record<string, number>> = {
  argon: 4,
  boron: 6,
  carbon: 8,
  dubnium: 10,
  erbium: 12,
  fermium: 14,
  gallium: 16,
  hydrogen: 18,
  iron: 20,
  jod: 22,
  krypton: 24,
};

const RULES = {
  nvmrc: "runtime.nvmrc",
  nodeVersion: "runtime.node-version-file",
  toolVersions: "runtime.tool-versions",
  dockerfile: "runtime.dockerfile",
} as const;

/** asdf plugin names for the runtimes the runtime detector compares. */
const TOOL_VERSION_RUNTIMES: Readonly<Record<string, Runtime>> = { nodejs: "node", node: "node", pnpm: "pnpm", yarn: "yarn", bun: "bun", deno: "deno" };

export const runtimeFilesDetector: Detector = {
  id: "runtime-files",
  version: "1",
  stage: "parse",
  inputs: ["**/.nvmrc", "**/.node-version", "**/.tool-versions", "**/Dockerfile", "**/*.Dockerfile"],
  categories: ["runtime_requirements"],
  async run(context) {
    const declarations: RuntimeDeclaration[] = [];
    const surface: string[] = [];
    for (const input of readableInputs(context, "nvmrc", "node-version", "tool-versions", "dockerfile")) {
      const content = await context.text(input.path);
      if (!content) continue;
      surface.push(input.path);
      if (input.format === "nvmrc" || input.format === "node-version") declarations.push(...versionFile(context, content, input.format === "nvmrc" ? RULES.nvmrc : RULES.nodeVersion));
      else if (input.format === "tool-versions") declarations.push(...toolVersions(context, content));
      else declarations.push(...dockerfile(context, content));
    }
    const skipped = unanalyzedInputs(context, "nvmrc", "node-version", "tool-versions", "dockerfile").map((input) => input.path);
    shareRuntimeInputs(context, { declarations, surface, skipped });
  },
};

/** `.nvmrc` and `.node-version`: the first non-comment line names a Node.js version. */
function versionFile(context: DetectorContext, content: BlobContent, rule: string): RuntimeDeclaration[] {
  const lines = content.text!.split("\n");
  const index = lines.findIndex((line) => line.trim() !== "" && !line.trim().startsWith("#"));
  if (index === -1) return [];
  const declared = lines[index]!.trim();
  return [{ runtime: "node", declared, ...rangeFields(nodeVersionRange(declared)), path: content.entry.path, evidence: context.lines(content, rule, index + 1), rule }];
}

/** `.tool-versions` (asdf): `<plugin> <version> [fallback...]`; the first version is the one in force. */
function toolVersions(context: DetectorContext, content: BlobContent): RuntimeDeclaration[] {
  const declarations: RuntimeDeclaration[] = [];
  content.text!.split("\n").forEach((line, index) => {
    const [plugin, version] = line.split("#")[0]!.trim().split(/\s+/);
    const runtime = plugin ? TOOL_VERSION_RUNTIMES[plugin] : undefined;
    if (!runtime || !version) return;
    declarations.push({ runtime, declared: version, ...rangeFields(runtime === "node" ? nodeVersionRange(version) : null), path: content.entry.path, evidence: context.lines(content, RULES.toolVersions, index + 1), rule: RULES.toolVersions });
  });
  return declarations;
}

/** Dockerfile `FROM node:<tag>` lines, one declaration per stage built from a Node.js image. */
function dockerfile(context: DetectorContext, content: BlobContent): RuntimeDeclaration[] {
  const declarations: RuntimeDeclaration[] = [];
  content.text!.split("\n").forEach((line, index) => {
    const match = /^\s*FROM\s+(?:--\S+\s+)*(\S+)/i.exec(line);
    const tag = match ? nodeImageTag(match[1]!) : null;
    if (tag === null) return;
    declarations.push({ runtime: "node", declared: tag, ...rangeFields(nodeTagRange(tag)), path: content.entry.path, evidence: context.lines(content, RULES.dockerfile, index + 1), rule: RULES.dockerfile });
  });
  return declarations;
}

const rangeFields = (range: string | null) => (range === null ? {} : { range });

/**
 * The range a Node.js version file declares. Semver ranges pass through
 * unchanged; `lts/<codename>` maps to its major version. `lts/*`, `node`, and
 * `stable` depend on when they are installed and have no fixed range.
 */
export function nodeVersionRange(declared: string): string | null {
  const codename = /^lts\/([a-z]+)$/i.exec(declared.trim());
  if (codename) {
    const major = NODE_LTS_CODENAMES[codename[1]!.toLowerCase()];
    return major === undefined ? null : String(major);
  }
  return null;
}

/**
 * The tag of an image reference whose repository is the official Node.js image,
 * such as `node:20-alpine` or `docker.io/library/node:20.11.1`; null for other images.
 */
export function nodeImageTag(image: string): string | null {
  const withoutDigest = image.split("@")[0]!;
  const slash = withoutDigest.lastIndexOf("/");
  const colon = withoutDigest.indexOf(":", slash + 1);
  const repository = (colon === -1 ? withoutDigest : withoutDigest.slice(0, colon)).toLowerCase();
  const name = repository.slice(repository.lastIndexOf("/") + 1);
  const namespace = repository.includes("/") ? repository.slice(0, repository.lastIndexOf("/")) : "";
  if (name !== "node" || !(namespace === "" || namespace.endsWith("library") || namespace === "docker.io")) return null;
  return colon === -1 ? "latest" : withoutDigest.slice(colon + 1);
}

/** The version range a Node.js image tag pins: its leading version number, as in `20-alpine` -> `20`. */
export function nodeTagRange(tag: string): string | null {
  const match = /^v?(\d+(?:\.\d+){0,2})(?:$|-)/.exec(tag);
  if (match) return match[1]!;
  const codename = NODE_LTS_CODENAMES[tag.split("-")[0]!.toLowerCase()];
  return codename === undefined ? null : String(codename);
}
