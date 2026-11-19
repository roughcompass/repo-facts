import { readEntry } from "@repo-facts/contract";
import { describe, expect, it } from "vitest";
import { fixtureEntry } from "../../../test/catalog/entries.js";
import { ADAPTERS, ADAPTERS_DIGEST, adapterCatalogSchema, adaptersDigest, catalogFromEntry } from "../src/index.js";

// What the design-system detectors read from an entry, and the adapter catalog compiled into the release.

const exportsOf = (module: string) => ADAPTERS.adapters.find((adapter) => adapter.module === module)?.exports.map((entry) => `${entry.name}:${entry.role}`);

describe("a Salt entry, as the detectors read it", () => {
  const entry = fixtureEntry("salt-1.50.0");
  const salt = catalogFromEntry(entry);

  it("is a valid entry for Salt 1.50.0, built from @salt-ds/theme 1.33.0", () => {
    expect(readEntry(entry).ok).toBe(true);
    expect(entry.packages.slice(0, 2)).toEqual([{ name: "@salt-ds/core", version: "1.50.0" }, { name: "@salt-ds/theme", version: "1.33.0" }]);
    expect(salt.entry).toEqual({ version: "1.50.0", format_version: 1, digest: entry.digest });
  });

  it("lists the packages whose exports are Salt components", () => {
    expect(salt.packages).toEqual(["@salt-ds/core", "@salt-ds/theme", "@salt-ds/data-grid", "@salt-ds/icons", "@salt-ds/lab"]);
  });

  it("holds the theme's tokens, every one with the prefix --salt-", () => {
    expect(salt.token_prefix).toBe("--salt-");
    expect(salt.tokens.length).toBeGreaterThan(1_800);
    expect(salt.tokens.length).toBeLessThan(1_900);
    expect(salt.tokens.every((token) => token.startsWith("--salt-"))).toBe(true);
    expect(salt.tokens).toEqual(expect.arrayContaining(["--salt-spacing-100", "--salt-spacing-300", "--salt-palette-accent", "--salt-text-fontFamily"]));
  });

  it("reads the provider, theme entry points, equivalents, neutral tags, and render prop", () => {
    expect(salt.providers.map((provider) => provider.component)).toEqual(["SaltProvider", "SaltProviderNext"]);
    expect(salt.theme_stylesheets).toContain("@salt-ds/theme/index.css");
    expect(Object.fromEntries(salt.equivalents.map((equivalent) => [equivalent.tag, equivalent.component]))).toMatchObject({ button: "Button", a: "Link", input: "Input", textarea: "MultilineInput", select: "Dropdown", p: "Text", h1: "H1" });
    expect(salt.neutral_tags).toEqual(["article", "aside", "div", "footer", "header", "main", "nav", "section", "span"]);
    expect(salt.property_families.layout).toEqual(expect.arrayContaining(["display", "gap", "flex-direction"]));
    expect(salt.property_families.spacing).toContain("padding");
    expect(salt.render_props).toEqual(["render"]);
  });

  it("indexes the finite values of each component's props", () => {
    expect(salt.finite_props.get("@salt-ds/core Button")?.get("appearance")).toEqual(["bordered", "solid", "transparent"]);
    expect(salt.finite_props.get("@salt-ds/core Button")?.has("loadingAnnouncement")).toBe(false);
    expect(salt.finite_props.has("@salt-ds/core StackLayout")).toBe(false);
  });
});

describe("the adapter catalog", () => {
  it("is valid adapter data, and its digest matches", () => {
    expect(adapterCatalogSchema.safeParse(ADAPTERS).success).toBe(true);
    expect(adaptersDigest(ADAPTERS)).toBe(ADAPTERS_DIGEST);
  });

  it("lists the class composers", () => {
    expect(exportsOf("clsx")).toEqual(["clsx:class_composer", "default:class_composer"]);
    expect(exportsOf("classnames")).toEqual(["default:class_composer"]);
    expect(exportsOf("tailwind-merge")).toEqual(["twJoin:class_composer", "twMerge:class_composer"]);
    expect(exportsOf("class-variance-authority")).toEqual(["cva:class_composer", "cx:class_composer"]);
    expect(exportsOf("@emotion/css")).toContain("cx:class_composer");
  });

  it("lists the styled-wrapper factories and the style factories", () => {
    expect(exportsOf("styled-components")).toEqual(["css:style_factory", "default:styled_factory", "styled:styled_factory"]);
    expect(exportsOf("@emotion/styled")).toEqual(["default:styled_factory"]);
    expect(exportsOf("@emotion/react")).toEqual(["css:style_factory"]);
  });
});
