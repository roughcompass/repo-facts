import semver from "semver";

/**
 * Version-range helpers for declared runtime and tool requirements. Ranges
 * are interpreted with npm's semver rules; nothing is looked up remotely.
 */

/** The normalized form of a declared range, or null when it is not a semver range. */
export function normalizeRange(declared: string): string | null {
  const trimmed = declared.trim();
  if (!trimmed || trimmed.length > 256) return null;
  const range = semver.validRange(trimmed, { loose: true });
  return range === null ? null : range || "*";
}

/**
 * The conjunction of several ranges: the versions that satisfy all of them,
 * normalized. Returns null when no version satisfies them all, which is how
 * incompatible declarations are recognized.
 */
export function conjoinRanges(declared: readonly string[]): string | null {
  let sets: semver.Comparator[][] = [[]];
  for (const text of declared) {
    const range = new semver.Range(text, { loose: true });
    const next: semver.Comparator[][] = [];
    for (const left of sets) {
      for (const right of range.set) {
        const merged = [...left, ...right];
        // Comparators bound intervals, so pairwise overlap implies a common version.
        if (merged.every((a, index) => merged.slice(index + 1).every((b) => a.intersects(b, { loose: true })))) next.push(merged);
      }
    }
    if (next.length === 0) return null;
    sets = next;
  }
  const text = [...new Set(sets.map(simplify))].join(" || ");
  return new semver.Range(text, { loose: true }).range || "*";
}

/** Reduces a satisfiable comparator set to its tightest bounds. */
function simplify(set: readonly semver.Comparator[]): string {
  const exact = set.find((comparator) => comparator.operator === "" && comparator.value !== "");
  if (exact) return exact.value;
  let lower: semver.Comparator | undefined;
  let upper: semver.Comparator | undefined;
  for (const comparator of set) {
    if (comparator.operator === ">" || comparator.operator === ">=") {
      const order = lower ? semver.compare(comparator.semver, lower.semver) : 1;
      if (order > 0 || (order === 0 && comparator.operator === ">")) lower = comparator;
    } else if (comparator.operator === "<" || comparator.operator === "<=") {
      const order = upper ? semver.compare(comparator.semver, upper.semver) : -1;
      if (order < 0 || (order === 0 && comparator.operator === "<")) upper = comparator;
    }
  }
  return [lower?.value, upper?.value].filter(Boolean).join(" ") || "*";
}

/** Splits a `packageManager` field such as `pnpm@9.1.0+sha512.abc` into its name and version. */
export function parsePackageManager(field: string): { name: string; version: string } | null {
  const at = field.lastIndexOf("@");
  if (at <= 0) return null;
  const name = field.slice(0, at);
  const version = field.slice(at + 1).split("+")[0]!;
  return /^[a-z][a-z0-9-]*$/.test(name) && semver.valid(version) ? { name, version } : null;
}

