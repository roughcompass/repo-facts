import { type Detector, type Evidence, compareCodeUnits, pointerOf } from "@repo-facts/contract";
import { DEPENDENCY_FIELDS, isObject, manifestsOf } from "@repo-facts/core";

/**
 * Packages this repository produces and consumes, from its manifests.
 *
 * Every named manifest produces a package, published unless it is private. A
 * consumed package is one any manifest depends on; it is internal when this
 * repository also produces it, as workspace packages are. Producer references,
 * and consumer references to external packages, let a Relationship Map
 * connect repositories.
 */

const RULES = { produced: "packages.produced", consumed: "packages.consumed" } as const;

export const packageRelationsDetector: Detector = {
  id: "package-relations",
  version: "1",
  stage: "architecture",
  inputs: ["**/package.json"],
  categories: ["packages_produced", "packages_consumed"],
  async run(context) {
    const { manifests, unanalyzed } = manifestsOf(context);
    const produced = new Map<string, Evidence>();

    for (const manifest of manifests) {
      const { name, version } = manifest.value;
      if (typeof name !== "string") continue;
      const evidence = context.pointer(manifest.content, RULES.produced, "json", "/name");
      produced.set(name, evidence);
      context.fact({
        category: "packages_produced",
        key: name,
        value: { name, manifest: manifest.path, version: typeof version === "string" ? version : null, published: manifest.value.private !== true },
        basis: "observed",
        evidence: [evidence, ...(typeof version === "string" ? [context.pointer(manifest.content, RULES.produced, "json", "/version")] : [])],
        rule: RULES.produced,
      });
      context.reference({ type: "package", role: "producer", identifier: { name }, basis: "observed", evidence: [evidence], rule: RULES.produced });
    }

    const consumed = new Map<string, Evidence[]>();
    for (const manifest of manifests) {
      for (const field of DEPENDENCY_FIELDS) {
        const declared = manifest.value[field];
        if (!isObject(declared)) continue;
        for (const name of Object.keys(declared).sort(compareCodeUnits)) {
          if (typeof declared[name] !== "string") continue;
          consumed.set(name, [...(consumed.get(name) ?? []), context.pointer(manifest.content, RULES.consumed, "json", pointerOf([field, name]))]);
        }
      }
    }
    for (const [name, evidence] of [...consumed.entries()].sort(([a], [b]) => compareCodeUnits(a, b))) {
      const internal = produced.has(name);
      context.fact({ category: "packages_consumed", key: name, value: { name, internal }, basis: "observed", evidence, rule: RULES.consumed });
      if (!internal) context.reference({ type: "package", role: "consumer", identifier: { name }, basis: "observed", evidence, rule: RULES.consumed });
    }

    const surface = manifests.map((manifest) => manifest.path);
    for (const category of ["packages_produced", "packages_consumed"]) context.search({ category, rule: category === "packages_produced" ? RULES.produced : RULES.consumed, surface, complete: true, skipped: unanalyzed });
  },
};

