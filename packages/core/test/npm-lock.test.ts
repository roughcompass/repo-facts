import { type FactDocument, resolveEvidence } from "@repo-facts/contract";
import { describe, expect, it } from "vitest";
import { type FileTree, profile } from "./support.js";

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

const MANIFEST = json({ name: "orders-ui", dependencies: { react: "^18.3.1", "@acme/ui": "^2.0.0" }, devDependencies: { vitest: "3.2.4" } });

const V1: FileTree = {
  "package.json": MANIFEST,
  "package-lock.json": json({
    name: "orders-ui",
    lockfileVersion: 1,
    requires: true,
    dependencies: {
      react: { version: "18.3.1", resolved: "https://registry.npmjs.org/react/-/react-18.3.1.tgz" },
      "@acme/ui": { version: "2.1.0" },
      vitest: { version: "3.2.4", dev: true },
    },
  }),
};

const V2: FileTree = {
  "package.json": MANIFEST,
  "package-lock.json": json({
    name: "orders-ui",
    lockfileVersion: 2,
    packages: {
      "": { name: "orders-ui" },
      "node_modules/react": { version: "18.3.1" },
      "node_modules/@acme/ui": { version: "2.1.0" },
      "node_modules/vitest": { version: "3.2.4", dev: true },
    },
    dependencies: { react: { version: "0.0.1-legacy-section-is-ignored" } },
  }),
};

const V3_WORKSPACES: FileTree = {
  "package.json": json({ name: "fleet", workspaces: ["packages/*"], devDependencies: { typescript: "5.9.3" } }),
  "packages/web/package.json": json({ name: "@fleet/web", dependencies: { react: "^19.0.0", "@fleet/ui": "*", lodash: "^4.17.21" } }),
  "packages/ui/package.json": json({ name: "@fleet/ui", version: "0.4.0", dependencies: { react: "^18.3.1" } }),
  "package-lock.json": json({
    name: "fleet",
    lockfileVersion: 3,
    packages: {
      "": { name: "fleet", workspaces: ["packages/*"] },
      "node_modules/typescript": { version: "5.9.3", dev: true },
      "node_modules/react": { version: "18.3.1" },
      "node_modules/@fleet/ui": { resolved: "packages/ui", link: true },
      "packages/web": { name: "@fleet/web" },
      "packages/web/node_modules/react": { version: "19.1.0" },
      "packages/ui": { name: "@fleet/ui", version: "0.4.0" },
    },
  }),
};

describe("npm lockfiles", () => {
  const resolved = (document: FactDocument) => Object.fromEntries(document.categories.resolved_dependencies!.facts.map((fact) => [fact.key, (fact.value as { version: string }).version]));
  const pointers = (document: FactDocument, key: string) =>
    document.categories.resolved_dependencies!.facts.find((fact) => fact.key === key)!.evidence.map((id) => {
      const { path, location } = document.evidence[id]!;
      return `${path}#${location.kind === "pointer" ? location.pointer : location.kind}`;
    });

  it("reads lockfile version 1 from its dependencies tree", async () => {
    const { document } = await profile(V1);
    expect(resolved(document)).toEqual({ "package.json#@acme/ui": "2.1.0", "package.json#react": "18.3.1", "package.json#vitest": "3.2.4" });
    expect(pointers(document, "package.json#@acme/ui")).toEqual(["package-lock.json#/dependencies/@acme~1ui/version"]);
    expect(document.categories.resolved_dependencies!.state).toBe("observed");
  });

  it("reads lockfile version 2 from packages and ignores its legacy section", async () => {
    const { document } = await profile(V2);
    expect(resolved(document)).toEqual({ "package.json#@acme/ui": "2.1.0", "package.json#react": "18.3.1", "package.json#vitest": "3.2.4" });
    expect(pointers(document, "package.json#react")).toEqual(["package-lock.json#/packages/node_modules~1react/version"]);
  });

  it("reads lockfile version 3 workspaces the way Node.js resolves them", async () => {
    const { document, reader } = await profile(V3_WORKSPACES);
    expect(resolved(document)).toEqual({
      "package.json#typescript": "5.9.3",
      // The member's own node_modules wins over the hoisted copy.
      "packages/web/package.json#react": "19.1.0",
      // A workspace link resolves to the linked package's version.
      "packages/web/package.json#@fleet/ui": "0.4.0",
      "packages/ui/package.json#react": "18.3.1",
    });
    expect(pointers(document, "packages/web/package.json#@fleet/ui").sort()).toEqual(["package-lock.json#/packages/node_modules~1@fleet~1ui/resolved", "package-lock.json#/packages/packages~1ui/version"]);

    const [id] = document.categories.resolved_dependencies!.facts.find((fact) => fact.key === "packages/web/package.json#react")!.evidence;
    expect(await resolveEvidence(reader, document.evidence[id!]!)).toMatchObject({ ok: true, excerpt: '"19.1.0"' });
  });

  it("notes dependencies the lockfile does not lock without inventing versions", async () => {
    const { document } = await profile(V3_WORKSPACES);
    expect(Object.keys(resolved(document))).not.toContain("packages/web/package.json#lodash");
    expect(document.diagnostics).toContainEqual({
      path: "package-lock.json",
      reason: "unlocked_dependency",
      detail: "packages/web/package.json declares 1 dependency this lockfile does not lock: lodash",
      detector: "npm-lock",
    });
  });

  it("uses npm-shrinkwrap.json and lockfiles in nested project directories", async () => {
    const { document } = await profile({
      "tools/cli/package.json": json({ name: "cli", dependencies: { commander: "^12.0.0" } }),
      "tools/cli/npm-shrinkwrap.json": json({ lockfileVersion: 3, packages: { "": {}, "node_modules/commander": { version: "12.1.0" } } }),
    });
    expect(resolved(document)).toEqual({ "tools/cli/package.json#commander": "12.1.0" });
  });

  it.each([
    ["invalid JSON", "{ lockfileVersion: 3,", "parse_failed"],
    ["a non-object document", "[]\n", "unsupported_shape"],
    ["an unsupported lockfile version", json({ lockfileVersion: 4, packages: {} }), "unsupported_version"],
    ["a version 3 lockfile without packages", json({ lockfileVersion: 3 }), "unsupported_shape"],
    ["a version 1 lockfile with malformed dependencies", json({ lockfileVersion: 1, dependencies: [] }), "unsupported_shape"],
  ])("reports %s as a skipped input and resolves nothing", async (_name, lockfile, reason) => {
    const { document } = await profile({ "package.json": MANIFEST, "package-lock.json": lockfile });
    expect(document.categories.resolved_dependencies).toMatchObject({ state: "unknown", facts: [], search: { skipped: ["package-lock.json"] } });
    expect(document.diagnostics).toContainEqual(expect.objectContaining({ path: "package-lock.json", reason }));
  });

  it("keeps versions unknown when the lockfile is over budget", async () => {
    const { document } = await profile(
      { "package.json": MANIFEST, "package-lock.json": json({ lockfileVersion: 3, packages: { "": {}, "node_modules/react": { version: "18.3.1" }, padding: { note: "x".repeat(3_000) } } }) },
      { budgets: { maxBlobBytes: 2_000, maxFiles: 100, maxTotalBytes: 1_000_000 } },
    );
    expect(document.categories.resolved_dependencies).toMatchObject({ state: "unknown", search: { skipped: ["package-lock.json"] } });
  });

  it("never stores credentials from git dependency versions", async () => {
    const { document } = await profile({
      "package.json": json({ name: "app", dependencies: { sdk: "git+https://github.com/acme/sdk.git" } }),
      "package-lock.json": json({ lockfileVersion: 1, dependencies: { sdk: { version: "git+https://deploy:s3cr3t@github.com/acme/sdk.git#abc123" } } }),
    });
    expect(resolved(document)).toEqual({ "package.json#sdk": "git+https://[redacted]@github.com/acme/sdk.git#abc123" });
    expect(JSON.stringify(document)).not.toContain("s3cr3t");
  });
});
