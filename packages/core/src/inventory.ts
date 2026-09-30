import { compareCodeUnits, type Detector, type DetectorContext } from "@repo-facts/contract";
import { type InputKind, classifyPath, isVendored, languageOf } from "./inputs.js";

/**
 * The inventory stage: classifies every committed path, reads the supported
 * inputs later stages parse (so budget use and skips are decided once, in
 * path order), and reports language distribution and submodules.
 *
 * Nothing in the inventory is executed or followed. Symbolic links and
 * submodules are recorded as metadata; sensitive inputs are never read.
 */

export const INVENTORY = "inventory";

export interface InventoryInput {
  path: string;
  kind: InputKind;
  format: string;
  label: string;
  supported: boolean;
  /** Whether the content was read as text; null when the inventory did not read it. */
  readable: boolean | null;
}

export interface Inventory {
  inputs: readonly InventoryInput[];
  /** JavaScript and TypeScript sources, excluding vendored directories. */
  sources: readonly string[];
  executables: readonly string[];
  symlinks: readonly string[];
  gitlinks: readonly string[];
}

/** Kinds read during inventory; scripts are read only when a later detector needs them. */
const PRE_READ: ReadonlySet<InputKind> = new Set(["manifest", "lockfile", "workspace", "ci", "runtime", "config", "contract"]);
const SOURCE_EXTENSIONS = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const LANGUAGE_SAMPLES = 3;

export const inventoryDetector: Detector = {
  id: INVENTORY,
  version: "1",
  stage: "inventory",
  inputs: ["**/*"],
  categories: ["languages", "submodules"],
  async run(context) {
    const entries = context.reader.entries;
    const classified = entries.flatMap((entry) => {
      if (entry.type !== "file" && entry.type !== "executable" && entry.type !== "symlink") return [];
      const rule = classifyPath(entry.path);
      return rule ? [{ entry, rule }] : [];
    });

    const toRead = classified.filter(({ entry, rule }) => rule.supported && PRE_READ.has(rule.kind) && entry.type !== "symlink").map(({ entry }) => entry.path);
    const results = await context.reader.readMany(toRead);

    const inputs: InventoryInput[] = classified.map(({ entry, rule }) => {
      const result = results.get(entry.path);
      const readable = entry.type === "symlink" ? false : result ? result.ok && result.content.text !== null : null;
      return { path: entry.path, kind: rule.kind, format: rule.format, label: rule.label, supported: rule.supported, readable };
    });

    for (const input of inputs) {
      if (input.kind === "sensitive") continue;
      if (!input.supported) context.diagnostic(input.path, "unsupported_input", `${input.label} is recognized but not analyzed by this detector release`);
      else if (context.reader.entry(input.path)?.type === "symlink") context.diagnostic(input.path, "symlink", `${input.label} is a symbolic link, which is recorded but never followed`);
    }

    const own = entries.filter((entry) => !isVendored(entry.path));
    const inventory: Inventory = {
      inputs,
      sources: own.filter((entry) => (entry.type === "file" || entry.type === "executable") && SOURCE_EXTENSIONS.test(entry.path)).map((entry) => entry.path),
      executables: entries.filter((entry) => entry.type === "executable").map((entry) => entry.path),
      symlinks: entries.filter((entry) => entry.type === "symlink").map((entry) => entry.path),
      gitlinks: entries.filter((entry) => entry.type === "gitlink").map((entry) => entry.path),
    };
    context.shared.set(INVENTORY, inventory);

    reportLanguages(context, own);
    reportSubmodules(context);
  },
};

export function inventoryOf(context: DetectorContext): Inventory {
  const inventory = context.shared.get(INVENTORY) as Inventory | undefined;
  if (!inventory) throw new Error("The inventory stage has not run");
  return inventory;
}

/** Supported inputs of +format+ whose content was read as text. */
export function readableInputs(context: DetectorContext, ...formats: string[]): InventoryInput[] {
  return inventoryOf(context).inputs.filter((input) => formats.includes(input.format) && input.supported && input.readable);
}

/** Inputs of +formats+ that could not be analyzed: unreadable, over budget, symbolic links, or unsupported. */
export function unanalyzedInputs(context: DetectorContext, ...formats: string[]): InventoryInput[] {
  return inventoryOf(context).inputs.filter((input) => formats.includes(input.format) && (!input.supported || input.readable === false));
}

function reportLanguages(context: DetectorContext, entries: DetectorContext["reader"]["entries"]) {
  const byLanguage = new Map<string, { files: number; bytes: number; samples: typeof entries }>();
  for (const entry of entries) {
    if (entry.type !== "file" && entry.type !== "executable") continue;
    const language = languageOf(entry.path);
    if (!language) continue;
    const tally = byLanguage.get(language) ?? { files: 0, bytes: 0, samples: [] };
    tally.files++;
    tally.bytes += entry.size ?? 0;
    if (tally.samples.length < LANGUAGE_SAMPLES) tally.samples = [...tally.samples, entry];
    byLanguage.set(language, tally);
  }

  for (const [language, tally] of [...byLanguage.entries()].sort(([a], [b]) => compareCodeUnits(a, b))) {
    context.fact({
      category: "languages",
      key: language,
      value: { files: tally.files, bytes: tally.bytes },
      basis: "observed",
      evidence: tally.samples.map((entry) => context.entry(entry, "inventory.language-by-extension")),
      rule: "inventory.language-by-extension",
    });
  }
  // Language distribution needs only the tree listing, which is always complete.
  context.search({ category: "languages", rule: "inventory.language-by-extension", surface: [], complete: true, skipped: [] });
}

function reportSubmodules(context: DetectorContext) {
  for (const entry of context.reader.entries) {
    if (entry.type !== "gitlink") continue;
    context.fact({
      category: "submodules",
      key: entry.path,
      value: { path: entry.path, commit: entry.objectId },
      basis: "observed",
      evidence: [context.entry(entry, "inventory.gitlink")],
      rule: "inventory.gitlink",
    });
  }
  context.search({ category: "submodules", rule: "inventory.gitlink", surface: [], complete: true, skipped: [] });
}
