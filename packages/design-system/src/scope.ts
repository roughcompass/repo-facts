/**
 * Scopes, from paths alone: stories, tests, and everything else as app code.
 */

export const SCOPES = ["app", "stories", "tests"] as const;
export type Scope = (typeof SCOPES)[number];

const TEST_DIRECTORIES = new Set(["__tests__", "test", "tests", "e2e", "cypress", "playwright"]);

/** The scope of +path+: `*.stories.*` and `*.story.*` files are stories; `*.test.*`, `*.spec.*`, and test directories are tests. */
export function scopeOf(path: string): Scope {
  const segments = path.split("/");
  const name = segments[segments.length - 1]!;
  const parts = name.split(".");
  // The marker sits between the stem and the extension, as in Button.stories.tsx.
  const markers = parts.slice(1, -1);
  if (markers.includes("stories") || markers.includes("story")) return "stories";
  if (markers.includes("test") || markers.includes("spec")) return "tests";
  if (segments.slice(0, -1).some((segment) => TEST_DIRECTORIES.has(segment))) return "tests";
  return "app";
}

/** A count for each scope, starting at zero. */
export function perScope<T>(make: () => T): Record<Scope, T> {
  return { app: make(), stories: make(), tests: make() };
}
