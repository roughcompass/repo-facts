import fs from "node:fs";
import path from "node:path";
import { type Budgets, type FactDocument, MemoryReader, type MemoryFile, dump, parseCanonical } from "@repo-facts/contract";

/**
 * Golden fixtures: small repositories under fixtures/<name>/tree with the
 * complete fact document the bundle must produce in fixtures/<name>/expected.json.
 * fixture.json may set a commit, budgets, and gitlinks (which cannot exist on disk).
 */

export const FIXTURES = path.resolve(import.meta.dirname, "../../fixtures");

export interface FixtureOptions {
  description: string;
  commit?: string | null;
  budgets?: Budgets;
  gitlinks?: Record<string, string>;
}

export interface Fixture {
  name: string;
  options: FixtureOptions;
  files: Record<string, MemoryFile>;
  expectedFile: string;
}

export function fixtureNames(): string[] {
  return fs.readdirSync(FIXTURES).filter((name) => fs.existsSync(path.join(FIXTURES, name, "tree"))).sort();
}

export function loadFixture(name: string): Fixture {
  const directory = path.join(FIXTURES, name);
  const optionsFile = path.join(directory, "fixture.json");
  const options = (fs.existsSync(optionsFile) ? JSON.parse(fs.readFileSync(optionsFile, "utf8")) : { description: name }) as FixtureOptions;
  const tree = path.join(directory, "tree");
  const files: Record<string, MemoryFile> = {};
  for (const relative of fs.readdirSync(tree, { recursive: true, encoding: "utf8" }).sort()) {
    const file = path.join(tree, relative);
    const stat = fs.lstatSync(file);
    const key = relative.split(path.sep).join("/");
    if (stat.isSymbolicLink()) files[key] = { symlink: fs.readlinkSync(file) };
    else if (stat.isFile()) files[key] = stat.mode & 0o111 ? { content: fs.readFileSync(file), executable: true } : fs.readFileSync(file);
  }
  for (const [key, commit] of Object.entries(options.gitlinks ?? {})) files[key] = { gitlink: commit };
  return { name, options, files, expectedFile: path.join(directory, "expected.json") };
}

export function readerFor(fixture: Fixture): MemoryReader {
  return MemoryReader.fromFiles(fixture.files, { commit: fixture.options.commit ?? null, ...(fixture.options.budgets && { budgets: fixture.options.budgets }) });
}

/** Stands in for the release in stored documents, so a version bump doesn't rewrite every fixture. */
export const STORED_RELEASE = "golden";

/** The stored form of a document: canonical key order, indented for review, with the release replaced. */
export function stored(document: FactDocument): string {
  return `${JSON.stringify(parseCanonical(dump({ ...document, detector_release: STORED_RELEASE })), null, 2)}\n`;
}
