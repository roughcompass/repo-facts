import { type PackageFiles, textOf } from "./tarball.js";

/**
 * Tokens: every custom property a theme package's stylesheets define with
 * the design system's token prefix. A token defined only in a deprecated
 * part of a stylesheet, which bundlers mark with a comment naming the source
 * file, such as `/* css/deprecated/foundations.css *\/`, is deprecated.
 */

export interface DeclaredToken {
  name: string;
  deprecated?: true;
}

const SECTION = /\/\*\s*([A-Za-z0-9_./-]+\.css)\s*\*\//g;
const COMMENT = /\/\*[\s\S]*?\*\//g;
const DEFINITION = /(?:^|[{;\s])(--[A-Za-z0-9_-]+)\s*:/g;

/** The tokens with +prefix+ that +pkg+'s stylesheets define. */
export function declaredTokens(pkg: PackageFiles, prefix: string): DeclaredToken[] {
  const current = new Set<string>();
  const deprecated = new Set<string>();
  const stylesheets = [...pkg.files.keys()].filter((file) => file.endsWith(".css") && !file.split("/").includes("node_modules")).sort();
  for (const file of stylesheets) {
    const text = textOf(pkg, file)!;
    // Split the stylesheet at the comments that name the file each part came from.
    const marks = [...text.matchAll(SECTION)].map((match) => ({ at: match.index, source: match[1]! }));
    const parts = [{ at: 0, source: file }, ...marks].map((mark, index, all) => ({ source: mark.source, text: text.slice(mark.at, all[index + 1]?.at ?? text.length) }));
    for (const part of parts) {
      const into = part.source.split("/").includes("deprecated") ? deprecated : current;
      for (const match of part.text.replace(COMMENT, " ").matchAll(DEFINITION)) if (match[1]!.startsWith(prefix)) into.add(match[1]!);
    }
  }
  return [...new Set([...current, ...deprecated])].sort().map((name) => (current.has(name) ? { name } : { name, deprecated: true as const }));
}
