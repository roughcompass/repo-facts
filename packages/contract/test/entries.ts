import { type DesignSystemEntry, type UnsealedEntry, sealEntry } from "../src/index.js";

/** A small, valid Salt entry; +change+ edits a copy before it's sealed. */
export function demoEntry(change: (entry: Record<string, unknown> & { content: Record<string, unknown> }) => void = () => {}): DesignSystemEntry {
  const entry = {
    schema: "reference_catalog.entry",
    format_version: 1,
    kind: "design_system",
    id: "salt",
    version: "1.75.0",
    packages: [{ name: "@salt-ds/core", version: "1.75.0" }, { name: "@salt-ds/theme", version: "1.48.0" }, { name: "@salt-ds/lab" }],
    built_at: "2026-11-19T00:00:00.000Z",
    sources: [
      { name: "@salt-ds/core", version: "1.75.0", sections: ["components"] },
      { name: "@salt-ds/theme", version: "1.48.0", sections: ["tokens"] },
      { name: "@salt-ds/mcp", version: "0.0.0-snapshot-20260331141637", snapshot_date: "2026-03-31", sections: ["patterns", "deprecations"] },
      { name: "catalog-rules/salt.yaml", version: `sha256:${"a".repeat(64)}`, sections: ["name", "token_prefix", "class_prefix", "theme_stylesheets", "providers", "equivalents", "neutral_tags", "neutral_values", "property_families", "render_props"] },
    ],
    content: {
      name: "Salt",
      token_prefix: "--salt-",
      class_prefix: "salt",
      theme_stylesheets: ["@salt-ds/theme/index.css"],
      providers: [{ package: "@salt-ds/core", component: "SaltProvider" }],
      components: [
        { name: "Button", package: "@salt-ds/core", props: [{ name: "appearance", values: ["bordered", "solid", "transparent"] }, { name: "variant", values: ["cta", "primary", "secondary"], deprecated: true }, { name: "loadingAnnouncement" }] },
        { name: "NavigationItem", package: "@salt-ds/core", props: [] },
        { name: "SaltProvider", package: "@salt-ds/core", props: [{ name: "mode", values: ["dark", "light"] }] },
      ],
      tokens: [{ name: "--salt-spacing-100" }, { name: "--salt-color-jpmBrown" }, { name: "--salt-delay-instant", deprecated: true }],
      patterns: [{ id: "pattern.app-header", name: "App header", summary: "An app header sits at the top of every application interface.", composed_of: ["NavigationItem", "Button"], regions: ["branding", "primary-navigation", "utility-actions"] }],
      deprecations: [{ id: "dep.salt-ds-core.button-button.variant.prop.73", package: "@salt-ds/core", kind: "prop", component: "Button", name: "variant", deprecated_in: "1.36.0", replacement: "appearance", notes: "Use appearance and sentiment instead." }],
      equivalents: [{ tag: "button", package: "@salt-ds/core", component: "Button" }],
      neutral_tags: ["div", "span"],
      neutral_values: ["0", "100%", "auto", "currentColor"],
      property_families: { layout: ["display", "gap"], spacing: ["margin", "padding"] },
      render_props: ["render"],
    },
  } as Record<string, unknown> & { content: Record<string, unknown> };
  change(entry);
  return sealEntry(entry as unknown as UnsealedEntry) as DesignSystemEntry;
}
