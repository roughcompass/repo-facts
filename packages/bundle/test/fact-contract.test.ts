import fs from "node:fs";
import path from "node:path";
import { MemoryReader, factDocumentProblems } from "@repo-facts/contract";
import { describe, expect, it } from "vitest";
import { CATALOG_FIXTURES, entryFromCatalog, fixtureEntry } from "../../../test/catalog/entries.js";
import { loadFixture, readerFor } from "../../../test/golden/harness.js";
import { analyze } from "../src/index.js";

// fact-contract: a fact document names the Reference Catalog entries it used.

const SALT_175 = fixtureEntry("salt-1.75.0");
/** A Salt 1.74.0 entry: the 1.75.0 fixture, labeled as the release before it. */
const SALT_174 = entryFromCatalog(fs.readFileSync(path.join(CATALOG_FIXTURES, "salt-1.75.0.yaml"), "utf8"), (entry) => {
  entry.version = "1.74.0";
  entry.packages = [{ name: "@salt-ds/core", version: "1.74.0" }, ...entry.packages.slice(1)];
  entry.sources = [{ ...entry.sources[0]!, version: "1.74.0" }, ...entry.sources.slice(1)];
});

/** A Salt application whose lockfile resolves @salt-ds/core at +version+. */
function saltApplication(version: string) {
  return MemoryReader.fromFiles(
    {
      "package.json": JSON.stringify({ name: "orders", dependencies: { "@salt-ds/core": `^${version}`, "@salt-ds/theme": "^1.48.0" } }),
      "package-lock.json": JSON.stringify({ name: "orders", lockfileVersion: 3, packages: { "": { name: "orders" }, "node_modules/@salt-ds/core": { version }, "node_modules/@salt-ds/theme": { version: "1.48.0" } } }),
      "src/main.tsx": 'import "@salt-ds/theme/index.css";\nimport { SaltProvider, Button } from "@salt-ds/core";\nexport const Root = () => <SaltProvider><Button /></SaltProvider>;\n',
    },
    { commit: "a".repeat(40) },
  );
}

describe("a fact document's Reference Catalog entries", () => {
  it("lists only the entry it was compared against, with its digest and the wanted version (Salt application)", async () => {
    const document = await analyze(saltApplication("1.75.0"), { entries: [SALT_174, SALT_175] });
    expect(factDocumentProblems(document)).toEqual([]);
    expect(document.schema_version).toBe(3);
    expect(document.catalog_entries).toEqual([{ kind: "design_system", id: "salt", version: "1.75.0", format_version: 1, digest: SALT_175.digest, wanted: { package: "@salt-ds/core", version: "1.75.0" } }]);
    expect(document.categories.design_systems!.facts[0]!.value).toMatchObject({ catalog: "salt", entry: { version: "1.75.0", digest: SALT_175.digest }, theme_stylesheet: true, provider: true });
  });

  it("lists the nearest earlier entry with the version the repository wanted (Nearest earlier entry)", async () => {
    const document = await analyze(saltApplication("1.76.0"), { entries: [SALT_174, SALT_175] });
    expect(factDocumentProblems(document)).toEqual([]);
    expect(document.catalog_entries).toEqual([{ kind: "design_system", id: "salt", version: "1.75.0", format_version: 1, digest: SALT_175.digest, wanted: { package: "@salt-ds/core", version: "1.76.0" } }]);
  });

  it("lists none for a document compared against no entry", async () => {
    const document = await analyze(MemoryReader.fromFiles({ "package.json": '{ "name": "plain" }\n' }, { commit: "a".repeat(40) }), { entries: [SALT_174, SALT_175] });
    expect(document.catalog_entries).toEqual([]);
    expect(document.categories.design_systems!.state).toBe("absent");
  });

  it("rejects a document whose design-system fact names another entry than it lists", async () => {
    const document = structuredClone(await analyze(saltApplication("1.75.0"), { entries: [SALT_174, SALT_175] }));
    document.catalog_entries[0]!.digest = SALT_174.digest;
    expect(factDocumentProblems(document)).toContain("design_systems/salt names another entry than catalog_entries lists");
    document.catalog_entries = [];
    expect(factDocumentProblems(document)).toContain("design_systems/salt names an entry that catalog_entries doesn't list");
  });
});

// design-system-usage: each design system is compared against the version in use.
describe("tokens compared against the version-matched entry", () => {
  const unknownTokens = async (entries: readonly unknown[]) => {
    const document = await analyze(readerFor(loadFixture("salt-theme-tokens")), { entries });
    return document.categories.style_values!.facts.filter((fact) => fact.key.startsWith("unknown-token:")).map((fact) => fact.key.slice("unknown-token:".length));
  };

  it("reports 36 unknown tokens against the catalog 0.6.0 compiled in, and only 2 against the 1.75.0 entry", async () => {
    // Salt 1.50.0, built from @salt-ds/theme 1.33.0, is what 0.6.0 compared every repository against.
    const before = await unknownTokens([fixtureEntry("salt-1.50.0")]);
    expect(before).toHaveLength(36);
    expect(before).toContain("--salt-color-jpmBrown");
    const after = await unknownTokens([fixtureEntry("salt-1.50.0"), SALT_175]);
    expect(after).toEqual(["--salt-color-jpmBronze", "--salt-palette-brand-accent"]);
    expect(before.filter((token) => !after.includes(token))).toHaveLength(34);
  });
});
