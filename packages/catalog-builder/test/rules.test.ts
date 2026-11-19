import fs from "node:fs";
import path from "node:path";
import { parseYaml } from "@repo-facts/contract";
import { describe, expect, it } from "vitest";
import { CatalogBuildError, buildEntry, parseRules } from "../src/index.js";
import { SALT, SALT_RULES, fixturePackage } from "./support.js";

// reference-catalog: the team's rules supply the curated sections, and salt.yaml's moved to catalog-rules/salt.yaml unchanged.

/** The catalog releases up to 0.6.0 compiled in, generated from @salt-ds/core 1.50.0 and @salt-ds/theme 1.33.0, now a test fixture. */
const OLD_CATALOG = parseYaml(fs.readFileSync(path.resolve(import.meta.dirname, "../../../test/catalog/salt-1.50.0.yaml"), "utf8")) as Record<string, unknown> & { packages: { name: string }[] };
const CURATED = ["name", "providers", "theme_stylesheets", "token_prefix", "class_prefix", "equivalents", "neutral_tags", "neutral_values", "property_families"] as const;

describe("the team's rules", () => {
  it("reproduce the curated sections of the old compiled catalog exactly, in an entry built for 1.50.0", () => {
    const packages = new Map([fixturePackage("@salt-ds/core", "1.50.0"), fixturePackage("@salt-ds/theme", "1.33.0")].map((pkg) => [pkg.name, pkg]));
    const entry = buildEntry({ kind: "design_system", id: "salt", package: "@salt-ds/core", tokens: "@salt-ds/theme" }, { packages, rules: SALT_RULES }, { builtAt: "2026-11-19T00:00:00.000Z" });
    expect(entry.version).toBe("1.50.0");
    for (const section of CURATED) expect(entry.content[section], section).toEqual(OLD_CATALOG[section]);
    expect(entry.packages.map((item) => item.name).sort()).toEqual(OLD_CATALOG.packages.map((item) => item.name).sort());
    expect(entry.packages.slice(0, 1)).toEqual([{ name: "@salt-ds/core", version: "1.50.0" }]);
    expect(entry.content.render_props).toEqual(["render"]);
    expect(entry.sources.find((source) => source.name === "catalog-rules/salt.yaml")!.sections).toEqual([...CURATED, "render_props"]);
    // The release's own sections come from its packages: the generated parts of the old catalog.
    expect(entry.content.tokens!.map((token) => token.name)).toEqual([...(OLD_CATALOG.tokens as string[])].sort());
  });

  it("are versioned by the digest of what they say, so a comment doesn't change an entry", () => {
    const { version } = parseRules(SALT_RULES);
    expect(version).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(parseRules(`# A new comment.\n${SALT_RULES}`).version).toBe(version);
    expect(parseRules(SALT_RULES.replace("render_props: [render]", "render_props: [render, as]")).version).not.toBe(version);
  });

  it.each([
    ["an unknown section", `${SALT_RULES}\nscript: run()\n`, "Unrecognized key"],
    ["a pattern for a tag", SALT_RULES.replace("neutral_tags: [ article,", 'neutral_tags: [ "div|span", article,'), "must be an HTML tag name"],
    ["a token prefix that's a pattern", SALT_RULES.replace("token_prefix: --salt-", 'token_prefix: "--salt-.*"'), "must be a custom property prefix"],
    ["malformed YAML", "format: [1", "Invalid YAML"],
  ])("reject %s", (_name, text, message) => {
    const error = (() => {
      try {
        parseRules(text);
      } catch (caught) {
        return caught as CatalogBuildError;
      }
      throw new Error("expected the rules to be rejected");
    })();
    expect(error).toBeInstanceOf(CatalogBuildError);
    expect(error.reason).toBe("invalid_rules");
    expect(error.problems.join("\n")).toContain(message);
  });

  it("must describe the thing being built, and list its packages", () => {
    const packages = new Map([fixturePackage("@salt-ds/core", "1.50.0")].map((pkg) => [pkg.name, pkg]));
    expect(() => buildEntry({ ...SALT, id: "pepper", tokens: undefined, icons: undefined, data: undefined } as never, { packages, rules: SALT_RULES }, { builtAt: "2026-11-19T00:00:00.000Z" })).toThrow("describes salt, not pepper");
    expect(() => buildEntry({ kind: "design_system", id: "salt", package: "@salt-ds/core", tokens: "@salt-ds/tokens" }, { packages, rules: SALT_RULES }, { builtAt: "2026-11-19T00:00:00.000Z" })).toThrow("doesn't list @salt-ds/tokens");
  });
});
