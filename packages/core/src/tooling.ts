import { type Detector, type DetectorContext, type Evidence, pointerOf, redactCredentials } from "@repo-facts/contract";
import { inventoryOf } from "./inventory.js";
import { BUILD_TOOLS, DEPENDENCY_FIELDS, FRAMEWORKS, LOCKFILE_MANAGERS, TEST_FRAMEWORKS, type Tool } from "./knowledge.js";
import { directoryOf, isObject, manifestsOf } from "./manifests.js";
import { parsePackageManager } from "./versions.js";

/**
 * Package managers, build tools, test frameworks, and frameworks declared by
 * manifests, lockfiles, and committed configuration files. Declarations are
 * reported; no tool is run to confirm them.
 */

const RULES = {
  packageManagerField: "manifest.package-manager",
  lockfile: "lockfile.package-manager",
  toolDependency: "manifest.tool-dependency",
  toolConfig: "config.tool-file",
  framework: "manifest.framework",
} as const;

export const toolingDetector: Detector = {
  id: "tooling",
  version: "1",
  stage: "convention",
  inputs: ["**/package.json", "**/package-lock.json", "**/pnpm-lock.yaml", "**/yarn.lock", "**/*.config.*"],
  categories: ["package_managers", "build_tools", "test_frameworks", "frameworks"],
  async run(context) {
    const { manifests, unanalyzed } = manifestsOf(context);
    const surface = manifests.map((manifest) => manifest.path);

    reportPackageManagers(context);
    reportTools(context, "build_tools", BUILD_TOOLS);
    reportTools(context, "test_frameworks", TEST_FRAMEWORKS);
    reportFrameworks(context);

    context.search({ category: "package_managers", rule: RULES.packageManagerField, surface, complete: true, skipped: unanalyzed });
    context.search({ category: "package_managers", rule: RULES.lockfile, surface: [], complete: true, skipped: [] });
    for (const category of ["build_tools", "test_frameworks"]) {
      context.search({ category, rule: RULES.toolDependency, surface, complete: true, skipped: unanalyzed });
      context.search({ category, rule: RULES.toolConfig, surface: [], complete: true, skipped: [] });
    }
    context.search({ category: "frameworks", rule: RULES.framework, surface, complete: true, skipped: unanalyzed });
  },
};

/**
 * One package manager per project directory. A `packageManager` field is an
 * observed declaration; a lockfile implies the manager that writes it. Two
 * different answers for one directory are a conflict.
 */
function reportPackageManagers(context: DetectorContext) {
  for (const manifest of manifestsOf(context).manifests) {
    const field = manifest.value.packageManager;
    if (typeof field !== "string") continue;
    const parsed = parsePackageManager(field);
    if (!parsed) {
      context.diagnostic(manifest.path, "unsupported_value", "packageManager is not in the name@version form");
      continue;
    }
    context.fact({
      category: "package_managers",
      key: manifest.directory,
      value: parsed.name,
      basis: "observed",
      evidence: [context.pointer(manifest.content, RULES.packageManagerField, "json", "/packageManager")],
      rule: RULES.packageManagerField,
    });
  }

  for (const input of inventoryOf(context).inputs) {
    const manager = LOCKFILE_MANAGERS[input.format];
    const entry = context.reader.entry(input.path);
    if (!manager || !entry) continue;
    context.fact({
      category: "package_managers",
      key: directoryOf(input.path),
      value: manager,
      basis: "inferred",
      evidence: [context.entry(entry, RULES.lockfile)],
      rule: RULES.lockfile,
      reasoning: `${input.path} is the lockfile ${manager} writes, so ${manager} manages this directory.`,
    });
  }
}

function reportTools(context: DetectorContext, category: string, tools: readonly Tool[]) {
  const { manifests } = manifestsOf(context);
  const { inputs } = inventoryOf(context);
  for (const tool of tools) {
    const evidence: Evidence[] = [];
    for (const manifest of manifests) {
      for (const field of DEPENDENCY_FIELDS) {
        const declared = manifest.value[field];
        if (!isObject(declared)) continue;
        for (const name of tool.packages) {
          if (typeof declared[name] === "string") evidence.push(context.pointer(manifest.content, RULES.toolDependency, "json", pointerOf([field, name])));
        }
      }
    }
    for (const input of inputs) {
      const entry = context.reader.entry(input.path);
      if (tool.configs.includes(input.format) && entry) evidence.push(context.entry(entry, RULES.toolConfig));
    }
    if (evidence.length === 0) continue;
    const byDependency = evidence.some((item) => item.rule === RULES.toolDependency);
    context.fact({ category, key: tool.id, value: { id: tool.id, label: tool.label }, basis: "observed", evidence, rule: byDependency ? RULES.toolDependency : RULES.toolConfig });
  }
}

/** Frameworks declared by each manifest, with every specifier that manifest gives them. */
function reportFrameworks(context: DetectorContext) {
  for (const manifest of manifestsOf(context).manifests) {
    for (const framework of FRAMEWORKS) {
      const specifiers: Record<string, string> = {};
      const evidence: Evidence[] = [];
      for (const field of DEPENDENCY_FIELDS) {
        const declared = manifest.value[field];
        const specifier = isObject(declared) ? declared[framework.package] : undefined;
        if (typeof specifier !== "string") continue;
        specifiers[field] = redactCredentials(specifier);
        evidence.push(context.pointer(manifest.content, RULES.framework, "json", pointerOf([field, framework.package])));
      }
      if (evidence.length === 0) continue;
      context.fact({
        category: "frameworks",
        key: `${manifest.path}#${framework.id}`,
        value: { manifest: manifest.path, id: framework.id, label: framework.label, package: framework.package, specifiers },
        basis: "observed",
        evidence,
        rule: RULES.framework,
      });
    }
  }
}
