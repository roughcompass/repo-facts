import fs from "node:fs";
import path from "node:path";
import { type DesignSystemEntry, entryProblems, parseYaml } from "@repo-facts/contract";
import semver from "semver";
import { beforeAll, describe, expect, it } from "vitest";
import { buildEntry, readPackage } from "../src/index.js";
import { MCP_VERSION, SALT, fixtureTarball, salt175, tarball } from "./support.js";

// reference-catalog: the Catalog Builder builds Salt 1.75.0 from @salt-ds/core 1.75.0, @salt-ds/theme 1.48.0,
// @salt-ds/icons 1.19.0, and Salt's published registry in @salt-ds/mcp (see support.ts for the trimmed fixtures).

const BUILT_AT = "2026-11-19T00:00:00.000Z";

describe("a Salt 1.75.0 entry", () => {
  let entry: DesignSystemEntry;
  beforeAll(() => {
    entry = buildEntry(SALT, salt175(), { builtAt: BUILT_AT });
  });

  it("is a valid entry for Salt 1.75.0, naming the versions of the packages it was built from", () => {
    expect(entryProblems(entry)).toEqual([]);
    expect(entry).toMatchObject({ schema: "reference_catalog.entry", format_version: 1, kind: "design_system", id: "salt", version: "1.75.0", built_at: BUILT_AT });
    expect(entry.packages).toEqual([
      { name: "@salt-ds/core", version: "1.75.0" },
      { name: "@salt-ds/data-grid" },
      { name: "@salt-ds/icons", version: "1.19.0" },
      { name: "@salt-ds/lab" },
      { name: "@salt-ds/theme", version: "1.48.0" },
    ]);
  });

  it("reads the components @salt-ds/core declares, with their props", () => {
    const components = entry.content.components!;
    expect(components).toHaveLength(189);
    expect(components.every((component) => component.package === "@salt-ds/core")).toBe(true);
    expect(components.map((component) => component.name)).toEqual(expect.arrayContaining(["Button", "SaltProvider", "SaltProviderNext", "StackLayout", "Text", "VerticalNavigationItemTrigger"]));
    const button = components.find((component) => component.name === "Button")!;
    expect(button.props).toEqual([
      { name: "appearance", values: ["bordered", "solid", "transparent"] },
      { name: "disabled", values: ["false", "true"] },
      { name: "focusableWhenDisabled", values: ["false", "true"] },
      { name: "loading", values: ["false", "true"] },
      { name: "loadingAnnouncement" },
      { name: "sentiment", values: ["accented", "caution", "negative", "neutral", "positive"] },
      { name: "variant", values: ["cta", "primary", "secondary"], deprecated: true },
    ]);
    // A polymorphic component's own props are read through the types it builds on.
    expect(components.find((component) => component.name === "Text")!.props).toContainEqual({ name: "styleAs", values: expect.arrayContaining(["h1", "label", "notation"]) });
  });

  it("reads every token @salt-ds/theme 1.48.0 defines, marking the ones only its deprecated stylesheets define", () => {
    const tokens = entry.content.tokens!;
    expect(tokens).toHaveLength(2587);
    expect(tokens.map((token) => token.name)).toEqual(expect.arrayContaining(["--salt-color-jpmBrown", "--salt-spacing-250", "--salt-palette-accent"]));
    expect(tokens.find((token) => token.name === "--salt-delay-instant")).toEqual({ name: "--salt-delay-instant", deprecated: true });
    expect(tokens.find((token) => token.name === "--salt-spacing-100")).toEqual({ name: "--salt-spacing-100" });
    // The same tokens the catalog generator read from that theme for test/catalog/salt-1.75.0.yaml.
    const generated = (parseYaml(fs.readFileSync(path.resolve(import.meta.dirname, "../../../test/catalog/salt-1.75.0.yaml"), "utf8")) as { tokens: string[] }).tokens;
    expect(tokens.map((token) => token.name)).toEqual([...generated].sort());
  });

  it("reads the icons @salt-ds/icons exports", () => {
    const icons = entry.content.icons!;
    expect(icons).toHaveLength(551);
    expect(icons.every((icon) => icon.package === "@salt-ds/icons" && icon.name.endsWith("Icon"))).toBe(true);
    expect(icons.map((icon) => icon.name)).toEqual(expect.arrayContaining(["AddIcon", "ChartBarIcon", "CheckmarkIcon"]));
  });

  it("takes patterns, deprecations, and guidance from Salt's published registry, recording its snapshot date", () => {
    expect(entry.sources).toContainEqual({ name: "@salt-ds/mcp", version: MCP_VERSION, snapshot_date: "2026-03-31", sections: ["patterns", "deprecations", "guidance"] });
    const header = entry.content.patterns!.find((pattern) => pattern.id === "pattern.app-header")!;
    expect(header).toMatchObject({ name: "App header", composed_of: ["NavigationItem", "Button"], regions: ["branding", "primary-navigation", "utility-actions"] });
    expect(entry.content.patterns).toHaveLength(25);
    expect(entry.content.deprecations).toContainEqual({ id: "dep.salt-ds-core.button-button.variant.prop.73", package: "@salt-ds/core", kind: "prop", component: "Button", name: "variant", deprecated_in: "1.36.0", replacement: "appearance", notes: "Use appearance and sentiment instead." });
    expect(entry.content.guidance!.components.find((item) => item.component === "Button")).toMatchObject({ summary: expect.stringContaining("Button is an interactive component") });
    expect(entry.content.guidance!.guides.map((guide) => guide.id)).toContain("guide.choosing-the-right-primitive");
  });

  it("names the source of every section", () => {
    expect(entry.sources.map((source) => [source.name, source.sections])).toEqual([
      ["@salt-ds/core", ["components"]],
      ["@salt-ds/theme", ["tokens"]],
      ["@salt-ds/icons", ["icons"]],
      ["@salt-ds/mcp", ["patterns", "deprecations", "guidance"]],
      ["catalog-rules/salt.yaml", ["name", "providers", "theme_stylesheets", "token_prefix", "class_prefix", "equivalents", "neutral_tags", "neutral_values", "property_families", "render_props"]],
    ]);
  });

  it("takes no version-specific section from the published registry, which is built from a snapshot of main", () => {
    const registrySections = entry.sources.find((source) => source.name === "@salt-ds/mcp")!.sections;
    for (const section of ["components", "tokens", "icons"]) expect(registrySections).not.toContain(section);
    // A registry that describes other components, props, tokens, and icons changes none of them.
    const sources = salt175();
    const files = new Map(sources.data.files);
    const components = JSON.parse(new TextDecoder().decode(files.get("generated/components.json"))) as { components: unknown[] };
    components.components.push({ name: "Invented widget", package: { name: "@salt-ds/core" }, props: [{ name: "appearance", type: '"loud"' }], summary: "Not in any release." });
    const entries = [...files].map(([file, bytes]) => ({ path: `package/${file}`, content: file === "generated/components.json" ? JSON.stringify(components) : Buffer.from(bytes) }));
    entries.push({ path: "package/generated/tokens.json", content: JSON.stringify({ tokens: [{ name: "--salt-invented-token" }] }) }, { path: "package/generated/icons.json", content: JSON.stringify({ icons: [{ name: "InventedIcon" }] }) });
    const tampered = buildEntry(SALT, { ...sources, data: readPackage("@salt-ds/mcp", MCP_VERSION, tarball(entries)) }, { builtAt: BUILT_AT });
    for (const section of ["components", "tokens", "icons"] as const) expect(tampered.content[section], section).toEqual(entry.content[section]);
    // Only the release's packages decide which deprecations apply: a 1.75.0 entry can't list one from 1.76.0.
    const release = new Map(entry.packages.flatMap((item) => (item.version ? [[item.name, item.version] as const] : [])));
    expect(entry.content.deprecations!.every((item) => release.has(item.package) && semver.lte(item.deprecated_in, release.get(item.package)!))).toBe(true);
    expect(entry.content.deprecations!.map((item) => item.package)).not.toContain("@salt-ds/lab");
    expect(fixtureTarball("@salt-ds/mcp", MCP_VERSION).length).toBeLessThan(64 * 1024);
  });
});
