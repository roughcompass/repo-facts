import { describe, expect, it } from "vitest";
import { ADAPTERS, CATALOGS, CATALOGS_DIGEST, adapterCatalogSchema, catalogSchema, catalogsDigest } from "../src/index.js";

// The shipped catalogs (design-system-usage tasks 4.2 and 4.3).

const salt = CATALOGS.find((catalog) => catalog.id === "salt")!;
const exportsOf = (module: string) => ADAPTERS.adapters.find((adapter) => adapter.module === module)?.exports.map((entry) => `${entry.name}:${entry.role}`);

describe("the Salt catalog", () => {
  it("is valid catalog data, and its digest matches", () => {
    expect(catalogSchema.safeParse(salt).success).toBe(true);
    expect(catalogsDigest(CATALOGS, ADAPTERS)).toBe(CATALOGS_DIGEST);
  });

  it("records the package versions it was generated from", () => {
    expect(salt.generated_from).toEqual({ "@salt-ds/core": "1.50.0", "@salt-ds/theme": "1.33.0" });
  });

  it("lists the core components, including the layouts", () => {
    const core = salt.packages.find((entry) => entry.name === "@salt-ds/core")!;
    expect(core.components).toEqual(expect.arrayContaining(["Button", "StackLayout", "FlexLayout", "GridLayout", "SaltProvider", "Text"]));
    expect(salt.packages.map((entry) => entry.name)).toEqual(["@salt-ds/core", "@salt-ds/data-grid", "@salt-ds/icons", "@salt-ds/lab", "@salt-ds/theme"]);
  });

  it("holds the theme's tokens, every one with the prefix --salt-", () => {
    expect(salt.token_prefix).toBe("--salt-");
    expect(salt.tokens.length).toBeGreaterThan(1_800);
    expect(salt.tokens.length).toBeLessThan(1_900);
    expect(salt.tokens.every((token) => token.startsWith("--salt-"))).toBe(true);
    expect(salt.tokens).toEqual(expect.arrayContaining(["--salt-spacing-100", "--salt-spacing-300", "--salt-palette-accent", "--salt-text-fontFamily"]));
  });

  it("curates the provider, theme entry points, equivalents, and neutral tags", () => {
    expect(salt.providers.map((provider) => provider.component)).toEqual(["SaltProvider", "SaltProviderNext"]);
    expect(salt.theme_stylesheets).toContain("@salt-ds/theme/index.css");
    expect(Object.fromEntries(salt.equivalents.map((equivalent) => [equivalent.tag, equivalent.component]))).toMatchObject({ button: "Button", a: "Link", input: "Input", textarea: "MultilineInput", select: "Dropdown", p: "Text", h1: "H1" });
    expect(salt.neutral_tags).toEqual(["article", "aside", "div", "footer", "header", "main", "nav", "section", "span"]);
    expect(salt.property_families.layout).toEqual(expect.arrayContaining(["display", "gap", "flex-direction"]));
    expect(salt.property_families.spacing).toContain("padding");
  });
});

describe("the adapter catalog", () => {
  it("is valid adapter data", () => {
    expect(adapterCatalogSchema.safeParse(ADAPTERS).success).toBe(true);
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
