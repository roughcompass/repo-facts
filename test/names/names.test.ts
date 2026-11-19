import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The name check: old product names stay out of the repository. It scans
 * every file's name and content, identifiers, strings, and prose alike, for
 * Fabricate, FabLab, repo-facts as a code name (repoFacts, RepoFacts,
 * REPO_FACTS, repo_facts), and "detector release" in any spelling. The
 * product is the Frontend Registry, and this repository's is Surveyor.
 *
 * Exempt: the names in KEPT_NAMES, @repo-facts/ package specifiers (which
 * the patterns don't match), past changelog entries, and this file's own
 * lists. A merge that brings an old name back fails here.
 */

const ROOT = path.resolve(import.meta.dirname, "../..");

const OLD_NAMES: readonly { label: string; pattern: RegExp }[] = [
  { label: "Fabricate", pattern: /fabricate/gi },
  { label: "FabLab", pattern: /fab[ -]?lab/gi },
  { label: "repo-facts as a code name", pattern: /repoFacts|RepoFacts|REPO_FACTS|repo_facts/g },
  { label: "detector release", pattern: /detector[ _-]?release/gi },
];

/** Names that keep their old spelling, because stored data or deployments depend on them (design.md, decision 9). */
export const KEPT_NAMES: readonly string[] = [
  // Schema identifiers inside every stored fact document and configuration digest.
  "repo_facts.fact_document",
  "repo_facts.detector_configuration",
  // The fact document's stored release field.
  "detector_release",
  // The provenance field of each published package.json, which consumers read from installed packages.
  '"repoFacts"',
  // The deprecated registry variables, still read, with a warning, for one more release.
  "REPO_FACTS_NPM_REGISTRY",
  "REPO_FACTS_NPM_TOKEN",
];

/** Files the check doesn't read: release history, and this file's own lists. */
const EXEMPT_FILES = new Set(["CHANGELOG.md", "test/names/names.test.ts"]);

/** Each old name in +text+, outside the kept names, as `path:line: name`. */
export function oldNames(file: string, text: string): string[] {
  let scanned = text;
  for (const kept of KEPT_NAMES) scanned = scanned.split(kept).join(" ".repeat(kept.length));
  const found: string[] = [];
  for (const { pattern } of OLD_NAMES) {
    for (const match of scanned.matchAll(pattern)) found.push(`${file}:${scanned.slice(0, match.index).split("\n").length}: ${match[0]}`);
  }
  return found;
}

/** Every file the repository holds or would add, with symbolic links read as their targets. */
function repositoryFiles(): string[] {
  return execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: ROOT, encoding: "utf8" }).split("\0").filter(Boolean);
}

describe("the name check", () => {
  it("finds no old name in any file name or content", () => {
    const found: string[] = [];
    for (const file of repositoryFiles()) {
      found.push(...oldNames("(file name)", file));
      const absolute = path.join(ROOT, file);
      const stat = fs.lstatSync(absolute, { throwIfNoEntry: false });
      if (!stat || EXEMPT_FILES.has(file)) continue;
      if (stat.isSymbolicLink()) {
        found.push(...oldNames(file, fs.readlinkSync(absolute)));
        continue;
      }
      const bytes = fs.readFileSync(absolute);
      if (bytes.includes(0)) continue;
      found.push(...oldNames(file, bytes.toString("utf8")));
    }
    expect(found).toEqual([]);
  });

  it.each([
    ["a repoFacts identifier", "export const repoFacts = 1;\n", ["packages/core/src/example.ts:1: repoFacts"]],
    ["a RepoFacts type", "type RepoFactsConfig = {};\n", ["packages/core/src/example.ts:1: RepoFacts"]],
    ["a REPO_FACTS switch", "const update = process.env.REPO_FACTS_UPDATE_FIXTURES;\n", ["packages/core/src/example.ts:1: REPO_FACTS"]],
    ["a repo_facts name", 'const id = "repo_facts.finding";\n', ["packages/core/src/example.ts:1: repo_facts"]],
    ["a product name", "// Fabricate reads this.\n// So does DE FabLab.\n", ["packages/core/src/example.ts:1: Fabricate", "packages/core/src/example.ts:2: FabLab"]],
    ["a detector release", "export const DETECTOR_RELEASE = 1;\n// the detector release\n", ["packages/core/src/example.ts:1: DETECTOR_RELEASE", "packages/core/src/example.ts:2: detector release"]],
  ])("fails on %s", (_name, text, found) => {
    expect(oldNames("packages/core/src/example.ts", text)).toEqual(found);
  });

  it("fails on an old name in a file name", () => {
    expect(oldNames("(file name)", "scripts/fabricate-sync.mjs")).toEqual(["(file name):1: fabricate"]);
  });

  it("allows the kept names and @repo-facts/ specifiers", () => {
    const text = 'import "@repo-facts/contract";\nconst schema = "repo_facts.fact_document";\nconst doc = { detector_release: "0.7.0" };\nmanifest["repoFacts"] = {};\nconst old = process.env.REPO_FACTS_NPM_REGISTRY;\n';
    expect(oldNames("scripts/example.mjs", text)).toEqual([]);
  });
});
