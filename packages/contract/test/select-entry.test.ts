import { describe, expect, it } from "vitest";
import { type DesignSystemEntry, selectEntry } from "../src/index.js";
import { demoEntry } from "./entries.js";

// reference-catalog: a repository is compared against the entry for its version, or the nearest earlier one.

/** A Salt entry at +version+, built from @salt-ds/theme at +theme+. */
const salt = (version: string, theme = "1.48.0", change: (entry: Record<string, unknown>) => void = () => {}) =>
  demoEntry((entry) => {
    Object.assign(entry, { version, packages: [{ name: "@salt-ds/core", version }, { name: "@salt-ds/theme", version: theme }, { name: "@salt-ds/lab" }] });
    change(entry);
  });

const versions = (entry: DesignSystemEntry | null) => entry && `${entry.id} ${entry.version}`;
const wanted = (version: string | null, extra: { package?: string; id?: string } = {}) => ({ kind: "design_system" as const, id: "salt", version, ...extra });

describe("selectEntry", () => {
  const entries = [salt("1.74.0", "1.47.0"), salt("1.50.0", "1.33.0"), salt("1.75.0", "1.48.0")];

  it("picks the entry at exactly the wanted version", () => {
    expect(versions(selectEntry(entries, wanted("1.75.0")))).toBe("salt 1.75.0");
    expect(versions(selectEntry(entries, wanted("1.50.0")))).toBe("salt 1.50.0");
  });

  it("picks the nearest earlier version when there's no exact entry", () => {
    expect(versions(selectEntry(entries, wanted("1.76.0")))).toBe("salt 1.75.0");
    expect(versions(selectEntry(entries, wanted("1.74.9")))).toBe("salt 1.74.0");
    expect(versions(selectEntry(entries, wanted("1.60.0")))).toBe("salt 1.50.0");
    expect(versions(selectEntry(entries, wanted("2.0.0")))).toBe("salt 1.75.0");
  });

  it("picks none when every entry is later than the wanted version", () => {
    expect(selectEntry(entries, wanted("1.49.9"))).toBeNull();
    expect(selectEntry([], wanted("1.75.0"))).toBeNull();
  });

  it("orders prereleases before their release", () => {
    expect(versions(selectEntry(entries, wanted("1.75.0-rc.1")))).toBe("salt 1.74.0");
    const withPrerelease = [...entries, salt("1.76.0-rc.1")];
    expect(versions(selectEntry(withPrerelease, wanted("1.76.0-rc.1")))).toBe("salt 1.76.0-rc.1");
    expect(versions(selectEntry(withPrerelease, wanted("1.76.0-rc.2")))).toBe("salt 1.76.0-rc.1");
    expect(versions(selectEntry(withPrerelease, wanted("1.76.0-beta.3")))).toBe("salt 1.75.0");
  });

  it("matches a wanted version of any of the entry's packages", () => {
    expect(versions(selectEntry(entries, wanted("1.48.0", { package: "@salt-ds/theme" })))).toBe("salt 1.75.0");
    expect(versions(selectEntry(entries, wanted("1.47.5", { package: "@salt-ds/theme" })))).toBe("salt 1.74.0");
    expect(versions(selectEntry(entries, wanted("1.75.0", { package: "@salt-ds/core" })))).toBe("salt 1.75.0");
    // An entry that records no version for the package can't be matched by it.
    expect(selectEntry(entries, wanted("1.0.0", { package: "@salt-ds/lab" }))).toBeNull();
    // Two entries built from the same theme: the later Salt version wins.
    const sameTheme = [salt("1.74.0", "1.48.0"), salt("1.75.0", "1.48.0")];
    expect(versions(selectEntry(sameTheme, wanted("1.48.0", { package: "@salt-ds/theme" })))).toBe("salt 1.75.0");
  });

  it("considers only entries for the wanted thing", () => {
    const mui = demoEntry((entry) => Object.assign(entry, { id: "mui", version: "1.75.0", packages: [{ name: "@mui/material", version: "1.75.0" }], content: { name: "MUI" }, sources: [{ name: "@mui/material", version: "1.75.0", sections: ["name"] }] }));
    expect(versions(selectEntry([mui, ...entries], wanted("1.75.0")))).toBe("salt 1.75.0");
    expect(versions(selectEntry([mui, ...entries], wanted("1.75.0", { id: "mui" })))).toBe("mui 1.75.0");
    expect(selectEntry([mui, ...entries], { kind: "runtime_api", id: "salt", version: "1.75.0" })).toBeNull();
  });

  it("picks the newest entry when no version is wanted, and none for a version it can't read", () => {
    expect(versions(selectEntry(entries, wanted(null)))).toBe("salt 1.75.0");
    expect(selectEntry(entries, wanted("latest"))).toBeNull();
  });

  it("chooses the same entry whatever the input order, preferring the later build of one version", () => {
    const first = salt("1.75.0", "1.48.0", (entry) => (entry.built_at = "2026-11-01T00:00:00.000Z"));
    const rebuilt = salt("1.75.0", "1.48.0", (entry) => Object.assign(entry, { built_at: "2026-11-18T00:00:00.000Z", content: { ...(entry.content as object), render_props: ["as"] } }));
    expect(rebuilt.digest).not.toBe(first.digest);
    expect(selectEntry([first, rebuilt], wanted("1.75.0"))!.digest).toBe(rebuilt.digest);
    expect(selectEntry([rebuilt, first], wanted("1.75.0"))!.digest).toBe(rebuilt.digest);
  });
});
