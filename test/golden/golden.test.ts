import fs from "node:fs";
import { DETECTOR_RELEASE, analyze } from "@repo-facts/bundle";
import { factDocumentProblems } from "@repo-facts/contract";
import { describe, expect, it } from "vitest";
import { fixtureNames, loadFixture, readerFor, stored } from "./harness.js";

// Expected documents change only through `npm run fixtures:update`, which sets this flag.
const UPDATE = process.env.REPO_FACTS_UPDATE_FIXTURES === "1";

describe("golden fixtures", () => {
  it("has fixtures to check", () => {
    expect(fixtureNames().length).toBeGreaterThan(0);
  });

  for (const name of fixtureNames()) {
    it(`${name} produces its expected fact document`, async () => {
      const fixture = loadFixture(name);
      const document = await analyze(readerFor(fixture));
      expect(factDocumentProblems(document)).toEqual([]);
      expect(document.detector_release).toBe(DETECTOR_RELEASE);
      const text = stored(document);
      if (UPDATE) fs.writeFileSync(fixture.expectedFile, text);
      expect(fs.existsSync(fixture.expectedFile), `${name} has no expected.json; run npm run fixtures:update and review it`).toBe(true);
      expect(text).toBe(fs.readFileSync(fixture.expectedFile, "utf8"));
    });
  }
});
