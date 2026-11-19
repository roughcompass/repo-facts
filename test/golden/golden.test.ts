import fs from "node:fs";
import { SURVEYOR_RELEASE, analyze } from "@repo-facts/bundle";
import { factDocumentProblems } from "@repo-facts/contract";
import { describe, expect, it } from "vitest";
import { fixtureNames, goldenEntries, loadFixture, readerFor, stored } from "./harness.js";

// Expected documents change only through `npm run fixtures:update`, which sets this flag.
const UPDATE = process.env.SURVEYOR_UPDATE_FIXTURES === "1";

describe("golden fixtures", () => {
  it("has fixtures to check", () => {
    expect(fixtureNames().length).toBeGreaterThan(0);
  });

  it("never reports composition, runtime integrations, or references from comments or strings", async () => {
    for (const name of fixtureNames()) {
      const document = await analyze(readerFor(loadFixture(name)), { entries: goldenEntries() });
      const reported = JSON.stringify([document.categories.composition, document.categories.runtime_integrations, document.relationship_references]);
      expect(reported.includes("decoy"), name).toBe(false);
    }
  });

  // Fixture secrets contain "do-not-leak"; only their names may appear in a document.
  it("never records a credential or configuration value", async () => {
    for (const name of fixtureNames()) {
      const document = await analyze(readerFor(loadFixture(name)), { entries: goldenEntries() });
      expect(JSON.stringify(document).includes("do-not-leak"), name).toBe(false);
    }
  });

  for (const name of fixtureNames()) {
    it(`${name} produces its expected fact document`, async () => {
      const fixture = loadFixture(name);
      const document = await analyze(readerFor(fixture), { entries: goldenEntries() });
      expect(factDocumentProblems(document)).toEqual([]);
      expect(document.detector_release).toBe(SURVEYOR_RELEASE);
      const text = stored(document);
      if (UPDATE) fs.writeFileSync(fixture.expectedFile, text);
      expect(fs.existsSync(fixture.expectedFile), `${name} has no expected.json; run npm run fixtures:update and review it`).toBe(true);
      expect(text).toBe(fs.readFileSync(fixture.expectedFile, "utf8"));
    });
  }
});
