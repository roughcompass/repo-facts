import { compareCodeUnits, type Detector } from "@repo-facts/contract";
import { inventoryOf } from "./inventory.js";

/**
 * Inputs this release recognizes but doesn't analyze, such as another
 * ecosystem's build manifest or lockfile, or a Vue or Svelte component's
 * template, put on the surface of every category they would feed. The inventory records each as an `unsupported_input`, a
 * skipped input, so a category with no facts stays unknown instead of being
 * reported absent. A category that has facts from inputs this release does
 * analyze keeps them, and its search lists what it skipped.
 */

export const UNSUPPORTED_INPUTS_RULE = "inventory.unsupported-input";

/** Every category an unsupported input can feed. */
export const UNSUPPORTED_INPUT_CATEGORIES = [
  "package_identity",
  "dependencies",
  "resolved_dependencies",
  "package_managers",
  "build_tools",
  "frameworks",
  "test_frameworks",
  "runtime_requirements",
  "scripts",
  "workspaces",
  "packages_produced",
  "packages_consumed",
  "ui_elements",
  "style_values",
  "accessibility",
] as const;

export const unsupportedInputsDetector: Detector = {
  id: "unsupported-inputs",
  version: "1",
  stage: "convention",
  inputs: [],
  categories: UNSUPPORTED_INPUT_CATEGORIES,
  async run(context) {
    const inputs = inventoryOf(context).inputs.filter((input) => !input.supported && input.feeds?.length);
    for (const category of UNSUPPORTED_INPUT_CATEGORIES) {
      const surface = inputs.filter((input) => input.feeds!.includes(category)).map((input) => input.path).sort(compareCodeUnits);
      if (surface.length) context.search({ category, rule: UNSUPPORTED_INPUTS_RULE, surface, complete: true, skipped: surface });
    }
  },
};
