import { type FactDocument, dump, resolveEvidence } from "@repo-facts/contract";
import { describe, expect, it } from "vitest";
import { type FileTree, profile } from "./support.js";

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

const resolved = (document: FactDocument) => Object.fromEntries(document.categories.resolved_dependencies!.facts.map((fact) => [fact.key, fact.state === "conflicting" ? fact.candidates!.map((candidate) => (candidate.value as { version: string }).version) : (fact.value as { version: string }).version]));
const pointers = (document: FactDocument, key: string) =>
  document.categories.resolved_dependencies!.facts.find((fact) => fact.key === key)!.evidence.map((id) => {
    const { path, location } = document.evidence[id]!;
    return `${path}#${location.kind === "pointer" ? location.pointer : location.kind}`;
  }).sort();

const FORMAT_9: FileTree = {
  "package.json": json({ name: "catalog", devDependencies: { typescript: "5.9.3" } }),
  "pnpm-workspace.yaml": "packages:\n  - apps/*\n  - libs/*\n",
  "apps/web/package.json": json({ name: "@catalog/web", dependencies: { react: "^18.3.1", "react-dom": "^18.3.1", "@catalog/ui": "workspace:*", lodash: "^4.17.21" } }),
  "libs/ui/package.json": json({ name: "@catalog/ui", version: "0.7.0" }),
  "pnpm-lock.yaml": [
    "lockfileVersion: '9.0'",
    "",
    "importers:",
    "",
    "  .:",
    "    devDependencies:",
    "      typescript:",
    "        specifier: 5.9.3",
    "        version: 5.9.3",
    "",
    "  apps/web:",
    "    dependencies:",
    "      '@catalog/ui':",
    "        specifier: workspace:*",
    "        version: link:../../libs/ui",
    "      react:",
    "        specifier: ^18.3.1",
    "        version: 18.3.1",
    "      react-dom:",
    "        specifier: ^18.3.1",
    "        version: 18.3.1(react@18.3.1)",
    "",
    "  libs/ui: {}",
    "",
  ].join("\n"),
};

describe("pnpm lockfiles", () => {
  it("reads format 9 importers, strips peer suffixes, and resolves workspace links", async () => {
    const { document, reader } = await profile(FORMAT_9);
    expect(resolved(document)).toEqual({
      "apps/web/package.json#@catalog/ui": "0.7.0",
      "apps/web/package.json#react": "18.3.1",
      "apps/web/package.json#react-dom": "18.3.1",
      "package.json#typescript": "5.9.3",
    });
    expect(pointers(document, "apps/web/package.json#react-dom")).toEqual(["pnpm-lock.yaml#/importers/apps~1web/dependencies/react-dom/version"]);
    expect(pointers(document, "apps/web/package.json#@catalog/ui")).toEqual(["libs/ui/package.json#/version", "pnpm-lock.yaml#/importers/apps~1web/dependencies/@catalog~1ui/version"]);
    const [id] = document.categories.resolved_dependencies!.facts.find((fact) => fact.key === "package.json#typescript")!.evidence;
    expect(await resolveEvidence(reader, document.evidence[id!]!)).toMatchObject({ ok: true, excerpt: '"5.9.3"', lines: { start: 9, end: 9 } });
  });

  it("notes dependencies the lockfile does not lock", async () => {
    const { document } = await profile(FORMAT_9);
    expect(document.diagnostics).toContainEqual({ path: "pnpm-lock.yaml", reason: "unlocked_dependency", detail: "apps/web/package.json declares 1 dependency this lockfile does not lock: lodash", detector: "pnpm-lock" });
  });

  it("reads a format 6 single-project lockfile with top-level dependencies", async () => {
    const { document } = await profile({
      "package.json": json({ name: "storefront", dependencies: { next: "15.5.0", "styled-jsx": "^5.1.0" } }),
      "pnpm-lock.yaml": "lockfileVersion: '6.0'\n\ndependencies:\n  next:\n    specifier: 15.5.0\n    version: 15.5.0(react-dom@19.1.0)(react@19.1.0)\n  styled-jsx:\n    specifier: ^5.1.0\n    version: 5.1.6(react@19.1.0)\n",
    });
    expect(resolved(document)).toEqual({ "package.json#next": "15.5.0", "package.json#styled-jsx": "5.1.6" });
  });

  it("reads format 5, where versions are strings with underscore peer suffixes", async () => {
    const { document } = await profile({
      "package.json": json({ name: "legacy", dependencies: { "react-redux": "^8.0.5", "private-sdk": "github:acme/sdk#v1" } }),
      "pnpm-lock.yaml": "lockfileVersion: 5.4\n\nspecifiers:\n  react-redux: ^8.0.5\n  private-sdk: github:acme/sdk#v1\n\ndependencies:\n  react-redux: 8.0.5_react-dom@18.2.0+react@18.2.0\n  private-sdk: github.com/acme/sdk/abc123_def\n",
    });
    expect(resolved(document)).toEqual({ "package.json#private-sdk": "github.com/acme/sdk/abc123_def", "package.json#react-redux": "8.0.5" });
    expect(pointers(document, "package.json#react-redux")).toEqual(["pnpm-lock.yaml#/dependencies/react-redux"]);
  });

  it.each([
    ["invalid YAML", "lockfileVersion: '9.0'\nimporters: [\n", "parse_failed"],
    ["an unsupported format", "lockfileVersion: '3.0'\n", "unsupported_version"],
    ["a non-mapping document", "- one\n- two\n", "unsupported_shape"],
    ["an importer that is not a mapping", "lockfileVersion: '9.0'\nimporters:\n  .: [1, 2]\n", "unsupported_shape"],
    ["dependencies that are not a mapping", "lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies: [react]\n", "unsupported_shape"],
  ])("reports %s as a skipped input and resolves nothing", async (_name, lockfile, reason) => {
    const { document } = await profile({ "package.json": json({ name: "app", dependencies: { react: "^18.3.1" } }), "pnpm-lock.yaml": lockfile });
    expect(document.categories.resolved_dependencies).toMatchObject({ state: "unknown", facts: [], search: { skipped: ["pnpm-lock.yaml"] } });
    expect(document.diagnostics).toContainEqual(expect.objectContaining({ path: "pnpm-lock.yaml", reason }));
  });

  it("never follows a link out of the repository", async () => {
    const { document } = await profile({
      "package.json": json({ name: "app", dependencies: { outside: "link:../outside" } }),
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      outside:\n        specifier: link:../outside\n        version: link:../outside\n",
    });
    expect(resolved(document)).toEqual({});
    expect(document.diagnostics).toContainEqual(expect.objectContaining({ reason: "unlocked_dependency", detail: expect.stringContaining("outside") }));
  });

  it("produces the same document on every run", async () => {
    const first = await profile(FORMAT_9);
    const second = await profile(FORMAT_9);
    expect(dump(second.document)).toBe(dump(first.document));
  });
});
