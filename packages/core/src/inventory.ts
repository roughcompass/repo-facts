import { compareCodeUnits, type Detector, type DetectorContext, type ReadResult } from "@repo-facts/contract";
import { type InputKind, classifyPath, goVendorDirectories, isVendored, languageOf } from "./inputs.js";

/**
 * The inventory stage: classifies every committed path, reads the supported
 * inputs later stages parse (so budget use and skips are decided once), and
 * reports language distribution and submodules.
 *
 * Inputs are read most decisive first, so a file budget that runs out on a
 * large repository is spent where it matters: package manifests, workspace
 * files, and lockfiles; then CI, runtime files, and Makefiles; then the tool
 * configuration detectors parse (JavaScript and TypeScript configuration
 * files and import maps) and API contracts. Configuration that only its name
 * reveals, such as tsconfig.json or .eslintrc.json, isn't read, because no
 * detector parses it. The shell scripts CI commands run are read
 * next, by the CI detector, and then sources and stylesheets, by the
 * source-reads detector at the end of the convention stage: application code
 * before tests, stories, fixtures, and examples. Within each tier, shallower
 * paths come first, and each group is read in path order, so the same tree
 * and budgets always skip the same inputs.
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
  /** The ecosystem of an unsupported build input of another ecosystem. */
  ecosystem?: string;
  /** Categories an unsupported input would feed. */
  feeds?: readonly string[];
  /** Whether the content was read as text; null when the inventory did not read it. */
  readable: boolean | null;
}

export interface Inventory {
  inputs: readonly InventoryInput[];
  /** JavaScript and TypeScript sources, excluding vendored and minified code. */
  sources: readonly string[];
  /** Vendor directories found from the tree, such as Go's, whose contents are excluded like node_modules. */
  vendorDirectories: readonly string[];
  executables: readonly string[];
  symlinks: readonly string[];
  gitlinks: readonly string[];
}

/** The reading tier of each kind read during inventory. Shell scripts are read only when a CI command runs one. */
const TIERS: ReadonlyMap<InputKind, number> = new Map([
  ["manifest", 0],
  ["workspace", 0],
  ["lockfile", 0],
  ["ci", 1],
  ["runtime", 1],
  ["config", 2],
  ["contract", 2],
]);
const MAKEFILE_TIER = 1;
const SOURCE_EXTENSIONS = /\.(?:[cm]?[jt]s|[jt]sx)$/;
/** Directories whose sources support the application rather than being it. */
const SUPPORTING_DIRECTORIES = new Set(["__tests__", "test", "tests", "spec", "specs", "e2e", "cypress", "playwright", "__mocks__", "mocks", "__fixtures__", "fixtures", "fixture", "stories", "storybook", ".storybook", "examples", "example", "docs", "benchmarks", "bench", "coverage", "dist"]);
const SUPPORTING_MARKERS = new Set(["test", "spec", "stories", "story", "d"]);
const ENTRY_STEMS = new Set(["index", "main", "app", "server", "entry", "bootstrap", "root"]);
const LANGUAGE_SAMPLES = 3;

export const inventoryDetector: Detector = {
  id: INVENTORY,
  version: "3",
  stage: "inventory",
  inputs: ["**/*"],
  categories: ["languages", "submodules"],
  async run(context) {
    const entries = context.reader.entries;
    const vendorDirectories = goVendorDirectories(entries.map((entry) => entry.path));
    const classified = entries.flatMap((entry) => {
      if (entry.type !== "file" && entry.type !== "executable" && entry.type !== "symlink") return [];
      const rule = classifyPath(entry.path, vendorDirectories);
      return rule ? [{ entry, rule }] : [];
    });

    const own = entries.filter((entry) => !isVendored(entry.path, vendorDirectories));
    const sources = own.filter((entry) => (entry.type === "file" || entry.type === "executable") && SOURCE_EXTENSIONS.test(entry.path)).map((entry) => entry.path);
    const order = new Map<string, number[]>();
    for (const { entry, rule } of classified) {
      const tier = rule.format === "makefile" ? MAKEFILE_TIER : TIERS.get(rule.kind);
      if (!rule.supported || tier === undefined || entry.type === "symlink") continue;
      if (rule.kind === "config" && rule.format !== "import-map" && !SOURCE_EXTENSIONS.test(entry.path)) continue;
      order.set(entry.path, [tier, depthOf(entry.path)]);
    }
    const results = await readInOrder(context, order);

    const inputs: InventoryInput[] = classified.map(({ entry, rule }) => {
      const result = results.get(entry.path);
      const readable = entry.type === "symlink" ? false : result ? result.ok && result.content.text !== null : null;
      return { path: entry.path, kind: rule.kind, format: rule.format, label: rule.label, supported: rule.supported, ...(rule.ecosystem && { ecosystem: rule.ecosystem }), ...(rule.feeds && { feeds: rule.feeds }), readable };
    });

    for (const input of inputs) {
      // A template is skipped only for the UI categories, through their searches: other detectors read some, such as HTML for import maps.
      if (input.kind === "sensitive" || input.kind === "template") continue;
      if (input.ecosystem) context.diagnostic(input.path, "unsupported_input", `${input.label} is recognized but not analyzed: this Surveyor release doesn't support the ${input.ecosystem} ecosystem`);
      else if (!input.supported) context.diagnostic(input.path, "unsupported_input", `${input.label} is recognized but not analyzed by this Surveyor release`);
      else if (context.reader.entry(input.path)?.type === "symlink") context.diagnostic(input.path, "symlink", `${input.label} is a symbolic link, which is recorded but never followed`);
    }

    const inventory: Inventory = {
      inputs,
      sources,
      vendorDirectories,
      executables: entries.filter((entry) => entry.type === "executable").map((entry) => entry.path),
      symlinks: entries.filter((entry) => entry.type === "symlink").map((entry) => entry.path),
      gitlinks: entries.filter((entry) => entry.type === "gitlink").map((entry) => entry.path),
    };
    context.shared.set(INVENTORY, inventory);

    reportLanguages(context, own);
    reportSubmodules(context);
  },
};

/**
 * Reads +order+'s paths in batches, by their keys compared element by element.
 * The reader spends budgets in path order within a batch, so each batch holds
 * the paths that share one key.
 */
async function readInOrder(context: DetectorContext, order: ReadonlyMap<string, readonly number[]>): Promise<Map<string, ReadResult>> {
  const batches = new Map<string, { key: readonly number[]; paths: string[] }>();
  for (const [path, key] of order) {
    const batch = batches.get(key.join()) ?? { key, paths: [] };
    batch.paths.push(path);
    batches.set(key.join(), batch);
  }
  const results = new Map<string, ReadResult>();
  for (const { paths } of [...batches.values()].sort((a, b) => compareKeys(a.key, b.key))) {
    for (const [path, result] of await context.reader.readMany(paths)) results.set(path, result);
  }
  return results;
}

function compareKeys(a: readonly number[], b: readonly number[]): number {
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const difference = (a[index] ?? -1) - (b[index] ?? -1);
    if (difference !== 0) return difference;
  }
  return 0;
}

function depthOf(path: string): number {
  return path.split("/").length - 1;
}

/** A source's reading rank: application code before supporting code, then shallower paths, then entry points such as index or main. */
function sourceRank(path: string): number[] {
  const segments = path.split("/");
  const name = segments[segments.length - 1]!;
  const parts = name.split(".");
  const supporting = segments.slice(0, -1).some((segment) => SUPPORTING_DIRECTORIES.has(segment)) || parts.slice(1, -1).some((marker) => SUPPORTING_MARKERS.has(marker));
  return [supporting ? 1 : 0, segments.length - 1, ENTRY_STEMS.has(parts[0]!.toLowerCase()) ? 0 : 1];
}

/**
 * Reads sources and supported stylesheets in priority order, after the
 * inventory and the CI detector have read theirs. It reports nothing: the
 * detectors that parse these files later find them already admitted or
 * skipped.
 */
export const sourceReadsDetector: Detector = {
  id: "source-reads",
  version: "1",
  stage: "convention",
  inputs: ["**/*.js", "**/*.jsx", "**/*.mjs", "**/*.cjs", "**/*.ts", "**/*.tsx", "**/*.mts", "**/*.cts", "**/*.css", "**/*.scss", "**/*.less"],
  categories: [],
  async run(context) {
    const inventory = inventoryOf(context);
    const order = new Map<string, number[]>();
    for (const input of inventory.inputs) if (input.kind === "stylesheet" && input.supported && context.reader.entry(input.path)?.type !== "symlink") order.set(input.path, sourceRank(input.path));
    for (const path of inventory.sources) order.set(path, sourceRank(path));
    await readInOrder(context, order);
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
