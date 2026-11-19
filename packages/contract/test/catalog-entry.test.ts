import { describe, expect, it } from "vitest";
import { type DesignSystemEntry, ENTRY_FORMAT_VERSION, canonicalEntry, entryDigest, entryProblems, readEntry, sealEntry } from "../src/index.js";
import { demoEntry } from "./entries.js";

// reference-catalog: an entry describes one thing at one version, as inert data with a digest.

const problems = (change: Parameters<typeof demoEntry>[0]) => entryProblems(demoEntry(change));

describe("the reference_catalog.entry format", () => {
  it("accepts a design-system entry with identity, provenance, and content", () => {
    const entry = demoEntry();
    expect(entryProblems(entry)).toEqual([]);
    expect(entry).toMatchObject({ schema: "reference_catalog.entry", format_version: ENTRY_FORMAT_VERSION, kind: "design_system", id: "salt", version: "1.75.0" });
    expect(readEntry(entry)).toEqual({ ok: true, entry });
  });

  it.each([
    ["an unknown top-level key", (entry: Record<string, unknown>) => (entry.script = "run()"), "Unrecognized key"],
    ["an unknown content key", (entry: { content: Record<string, unknown> }) => (entry.content.evaluate = true), "Unrecognized key"],
    ["an unknown nested key", (entry: { content: Record<string, unknown> }) => ((entry.content.equivalents as Record<string, unknown>[])[0]!.when = "always"), "Unrecognized key"],
    ["an unknown prop key", (entry: { content: Record<string, unknown> }) => ((entry.content.components as { props: Record<string, unknown>[] }[])[0]!.props[0]!.pattern = "^s"), "Unrecognized key"],
    ["an unknown source key", (entry: Record<string, unknown>) => ((entry.sources as Record<string, unknown>[])[0]!.url = "https://example.invalid"), "Unrecognized key"],
  ])("rejects %s", (_name, change, message) => {
    expect(problems(change as never).join("\n")).toContain(message);
  });

  it.each([["theme"], ["design-system"], ["DesignSystem"], [""]])("rejects the unknown kind %j", (kind) => {
    expect(problems((entry) => (entry.kind = kind)).join("\n")).toMatch(/kind|discriminator|Invalid input/i);
  });

  it("reserves runtime APIs and composition contracts as kinds without content", () => {
    for (const kind of ["runtime_api", "composition_contract"]) {
      const reserved = (content: Record<string, unknown>, sections: string[] = []) =>
        entryProblems(sealEntry({ ...demoEntry(), kind, id: "orders-api", packages: [{ name: "@acme/orders-api", version: "1.75.0" }], sources: [{ name: "@acme/orders-api", version: "1.75.0", sections }], content } as never));
      expect(reserved({}), kind).toEqual([]);
      expect(reserved({ endpoints: [] }, ["endpoints"]).join("\n"), kind).toContain("Unrecognized key");
      expect(reserved({}, ["endpoints"]), kind).toEqual(["sources: endpoints is claimed but the content has no such section"]);
    }
  });

  it.each([
    ["a token that is a pattern", (entry: { content: Record<string, unknown> }) => (entry.content.tokens = [{ name: "--salt-.*" }])],
    ["a token alternation", (entry: { content: Record<string, unknown> }) => (entry.content.tokens = [{ name: "--salt-(a|b)" }])],
    ["a tag alternation", (entry: { content: Record<string, unknown> }) => (entry.content.neutral_tags = ["div|span"])],
    ["a wildcard tag", (entry: { content: Record<string, unknown> }) => (entry.content.neutral_tags = ["*"])],
    ["a component pattern", (entry: { content: Record<string, unknown> }) => (entry.content.equivalents = [{ tag: "button", package: "@salt-ds/core", component: "Button.*" }])],
    ["a package glob", (entry: Record<string, unknown>) => (entry.packages = [{ name: "@salt-ds/core", version: "1.75.0" }, { name: "@salt-ds/*" }])],
    ["a prop value pattern", (entry: { content: Record<string, unknown> }) => (entry.content.components = [{ name: "Button", package: "@salt-ds/core", props: [{ name: "appearance", values: ["solid|bordered"] }] }])],
    ["a prop value with code", (entry: { content: Record<string, unknown> }) => (entry.content.components = [{ name: "Button", package: "@salt-ds/core", props: [{ name: "onClick", values: ["() => run()"] }] }])],
    ["a prop name pattern", (entry: { content: Record<string, unknown> }) => (entry.content.render_props = ["render.*"])],
    ["a neutral value expression", (entry: { content: Record<string, unknown> }) => (entry.content.neutral_values = ["calc(1px + 2px)"])],
    ["a property regular expression", (entry: { content: Record<string, unknown> }) => (entry.content.property_families = { layout: ["^grid-.*$"] })],
    ["a range as a version", (entry: Record<string, unknown>) => (entry.version = "^1.75.0")],
    ["prose over several lines", (entry: { content: Record<string, unknown> }) => (entry.content.patterns = [{ id: "pattern.app-header", name: "App header", summary: "line one\nline two", composed_of: [], regions: [] }])],
  ])("rejects %s, which isn't inert data", (_name, change) => {
    expect(problems(change as never)).not.toEqual([]);
  });

  it("requires the first package to carry the entry's version, and every section to name exactly one source", () => {
    expect(problems((entry) => (entry.version = "1.74.0"))).toContain("packages: the first package, @salt-ds/core, must carry the entry's version 1.74.0");
    expect(problems((entry) => ((entry.sources as { sections: string[] }[])[0]!.sections = ["components", "tokens"]))).toContain("sources: more than one source supplies tokens");
    expect(problems((entry) => ((entry.sources as { sections: string[] }[])[1]!.sections = ["icons"]))).toEqual(["sources: no source supplies tokens", "sources: icons is claimed but the content has no such section"]);
  });

  it("checks references between sections", () => {
    expect(problems((entry) => (entry.content.equivalents = [{ tag: "button", package: "@salt-ds/core", component: "Fab" }]))).toContain("the equivalent for button names Fab, which @salt-ds/core does not list");
    expect(problems((entry) => (entry.content.providers = [{ package: "@acme/core", component: "AcmeProvider" }]))).toContain("a provider names @acme/core, which is not one of the entry's packages");
    expect(problems((entry) => (entry.content.tokens = [{ name: "--acme-spacing-100" }]))).toContain("tokens: --acme-spacing-100 does not carry the prefix --salt-");
    expect(problems((entry) => (entry.content.neutral_tags = ["div", "button"]))).toContain("neutral_tags: button is both neutral and replaced by a component");
  });

  it("rejects a digest that doesn't match the content", () => {
    const entry = demoEntry();
    expect(entryProblems({ ...entry, content: { ...entry.content, name: "Pepper" } })).toEqual(["digest: does not match the entry's content"]);
  });

  it("reads an unsupported format version as unsupported, naming the entry and its format, without interpreting it", () => {
    const result = readEntry({ ...demoEntry(), format_version: 2, content: { anything: "new" } });
    expect(result).toMatchObject({ ok: false, reason: "unsupported_entry_format", label: { id: "salt", version: "1.75.0", format_version: 2 } });
    expect(result.ok ? "" : result.detail).toBe("Reference Catalog entry salt 1.75.0 has format version 2; this release reads reference_catalog.entry format version 1");
    expect(readEntry({ schema: "other.thing", format_version: 1 })).toMatchObject({ ok: false, reason: "unsupported_entry_format" });
    expect(readEntry({ ...demoEntry(), digest: "0".repeat(64) })).toMatchObject({ ok: false, reason: "invalid_entry" });
  });
});

describe("entry digests", () => {
  /** Rebuilds +value+ with every object's keys in reverse order. */
  const reversed = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(reversed);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reversed(item)]));
    return value;
  };

  it("is the SHA-256 of canonical JSON: key order and whitespace don't change it", () => {
    const entry = demoEntry();
    expect(entry.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(entryDigest(reversed(entry) as DesignSystemEntry)).toBe(entry.digest);
    expect(entryDigest(JSON.parse(JSON.stringify(entry, null, 4)) as DesignSystemEntry)).toBe(entry.digest);
    expect(canonicalEntry(reversed(entry) as DesignSystemEntry)).toBe(canonicalEntry(entry));
    expect(canonicalEntry(entry)).not.toMatch(/\s"|":\s/);
  });

  it("changes with any content, identity, or provenance change", () => {
    const base = demoEntry().digest;
    const changes: Parameters<typeof demoEntry>[0][] = [
      (entry) => (entry.content.tokens = [{ name: "--salt-spacing-100" }]),
      (entry) => ((entry.content.components as { props: { name: string }[] }[])[0]!.props[2]!.name = "loadingText"),
      (entry) => (entry.content.render_props = ["as"]),
      (entry) => Object.assign(entry, { version: "1.75.1", packages: [{ name: "@salt-ds/core", version: "1.75.1" }, { name: "@salt-ds/theme", version: "1.48.0" }, { name: "@salt-ds/lab" }] }),
      (entry) => ((entry.sources as { version: string }[])[3]!.version = `sha256:${"b".repeat(64)}`),
    ];
    const digests = changes.map((change) => demoEntry(change).digest);
    for (const digest of digests) expect(digest).not.toBe(base);
    expect(new Set(digests).size).toBe(digests.length);
  });

  it("leaves out when the entry was built, so rebuilding the same inputs gives the same digest", () => {
    expect(demoEntry((entry) => (entry.built_at = "2027-01-01T00:00:00.000Z")).digest).toBe(demoEntry().digest);
  });
});
