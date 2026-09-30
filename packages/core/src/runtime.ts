import { compareCodeUnits, type Detector, type DetectorContext, type Evidence, pointerOf } from "@repo-facts/contract";
import { RUNTIMES, type Runtime } from "./knowledge.js";
import { isObject, manifestsOf } from "./manifests.js";
import { conjoinRanges, normalizeRange, parsePackageManager } from "./versions.js";

/**
 * Declared runtime requirements (Node.js and package-manager versions).
 *
 * Every declaration of one runtime is compared with the others. When some
 * version satisfies them all, each declaration supports one fact whose range
 * is their conjunction. When none does, the declarations conflict and each
 * keeps its own range and evidence. A declaration that is not a semver range
 * is reported as a skipped input, so the requirement stays unknown rather than
 * being guessed.
 */

export const RUNTIME_DECLARATIONS = "runtime-declarations";

export interface RuntimeDeclaration {
  runtime: Runtime;
  /** The declaration as written, such as `>=20` or `lts/iron`. */
  declared: string;
  /** The semver range it denotes, when `declared` is not itself a range (such as an LTS codename). */
  range?: string;
  path: string;
  evidence: Evidence;
  rule: string;
}

interface SharedRuntimeInputs {
  declarations: RuntimeDeclaration[];
  surface: string[];
  skipped: string[];
}

/**
 * Adds declarations found by an earlier stage (runtime files, CI setup, container
 * images), with the paths searched and any that could not be analyzed.
 */
export function shareRuntimeInputs(context: DetectorContext, inputs: Partial<SharedRuntimeInputs>) {
  const shared = (context.shared.get(RUNTIME_DECLARATIONS) as SharedRuntimeInputs | undefined) ?? { declarations: [], surface: [], skipped: [] };
  shared.declarations.push(...(inputs.declarations ?? []));
  shared.surface.push(...(inputs.surface ?? []));
  shared.skipped.push(...(inputs.skipped ?? []));
  context.shared.set(RUNTIME_DECLARATIONS, shared);
}

const rangeOf = (declaration: RuntimeDeclaration) => declaration.range ?? normalizeRange(declaration.declared);

const RULES = {
  engines: "manifest.engines",
  volta: "manifest.volta",
  packageManager: "manifest.package-manager-version",
} as const;

export const runtimeDetector: Detector = {
  id: "runtime",
  version: "1",
  stage: "convention",
  inputs: ["**/package.json"],
  categories: ["runtime_requirements"],
  async run(context) {
    const { manifests, unanalyzed } = manifestsOf(context);
    const shared = (context.shared.get(RUNTIME_DECLARATIONS) as SharedRuntimeInputs | undefined) ?? { declarations: [], surface: [], skipped: [] };
    const declarations = [...manifestDeclarations(context), ...shared.declarations];
    const unsupported: string[] = [];

    for (const runtime of RUNTIMES) {
      const all = declarations.filter((item) => item.runtime === runtime);
      const valid = all.filter((item) => {
        if (rangeOf(item) !== null) return true;
        context.diagnostic(item.path, "unsupported_runtime_declaration", `${JSON.stringify(item.declared.slice(0, 100))} is not a version range for ${runtime}`);
        unsupported.push(item.path);
        return false;
      });
      if (valid.length === 0) continue;

      const declared = [...new Set(valid.map((item) => item.declared.trim()))].sort(compareCodeUnits);
      const range = conjoinRanges([...new Set(valid.map((item) => rangeOf(item)!))].sort(compareCodeUnits));
      for (const item of valid) {
        context.fact({
          category: "runtime_requirements",
          key: runtime,
          value: range === null ? { range: normalizeRange(rangeOf(item)!)!, declared: [item.declared.trim()] } : { range, declared },
          basis: "observed",
          evidence: [item.evidence],
          rule: item.rule,
        });
      }
    }

    const sources = [...new Set([...manifests.map((manifest) => manifest.path), ...shared.surface, ...declarations.map((item) => item.path)])].sort(compareCodeUnits);
    context.search({ category: "runtime_requirements", rule: "runtime.declarations", surface: sources, complete: true, skipped: [...new Set([...unanalyzed, ...shared.skipped, ...unsupported])].sort(compareCodeUnits) });
  },
};

function manifestDeclarations(context: DetectorContext): RuntimeDeclaration[] {
  const declarations: RuntimeDeclaration[] = [];
  for (const manifest of manifestsOf(context).manifests) {
    for (const [field, rule] of [
      ["engines", RULES.engines],
      ["volta", RULES.volta],
    ] as const) {
      const block = manifest.value[field];
      if (!isObject(block)) continue;
      for (const runtime of RUNTIMES) {
        const declared = block[runtime];
        if (typeof declared !== "string") continue;
        declarations.push({ runtime, declared, path: manifest.path, evidence: context.pointer(manifest.content, rule, "json", pointerOf([field, runtime])), rule });
      }
    }
    const field = manifest.value.packageManager;
    const parsed = typeof field === "string" ? parsePackageManager(field) : null;
    if (parsed && (RUNTIMES as readonly string[]).includes(parsed.name)) {
      declarations.push({
        runtime: parsed.name as Runtime,
        declared: parsed.version,
        path: manifest.path,
        evidence: context.pointer(manifest.content, RULES.packageManager, "json", "/packageManager"),
        rule: RULES.packageManager,
      });
    }
  }
  return declarations;
}
