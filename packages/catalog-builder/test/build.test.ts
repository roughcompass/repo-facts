import { entryProblems } from "@repo-facts/contract";
import { describe, expect, it } from "vitest";
import { CatalogBuildError, buildEntry, readPackage, readTarball } from "../src/index.js";
import { SALT, salt175, tarball } from "./support.js";

// reference-catalog: every built entry is validated and digested; a build that fails produces nothing.

/** The error +build+ throws. */
function failure(build: () => unknown): CatalogBuildError {
  try {
    build();
  } catch (error) {
    if (error instanceof CatalogBuildError) return error;
    throw error;
  }
  throw new Error("expected the build to fail");
}

describe("building an entry", () => {
  it("yields the same digest from the same inputs, whenever it's built", () => {
    const first = buildEntry(SALT, salt175(), { builtAt: "2026-11-19T00:00:00.000Z" });
    const second = buildEntry(SALT, salt175(), { builtAt: "2026-11-20T09:30:00.000Z" });
    expect(entryProblems(first)).toEqual([]);
    expect(second.digest).toBe(first.digest);
    expect(second.built_at).not.toBe(first.built_at);
  });

  it("changes the digest when a source changes", () => {
    const sources = salt175();
    const changed = buildEntry(SALT, { ...sources, rules: sources.rules.replace("render_props: [render]", "render_props: [render, as]") }, { builtAt: "2026-11-19T00:00:00.000Z" });
    expect(changed.digest).not.toBe(buildEntry(SALT, sources, { builtAt: "2026-11-19T00:00:00.000Z" }).digest);
  });

  it("fails without output when a source produces an invalid entry", () => {
    const sources = salt175();
    const theme = sources.packages.get("@salt-ds/theme")!;
    // A token the entry format can't hold: a custom property name with an empty segment.
    const files = [...theme.files].map(([file, bytes]) => ({ path: `package/${file}`, content: file === "css/theme.css" ? `${new TextDecoder().decode(bytes)}\n.salt-theme { --salt--broken: 1px; }\n` : Buffer.from(bytes) }));
    const broken = readPackage("@salt-ds/theme", "1.48.0", tarball(files));
    let entry: unknown = null;
    const error = failure(() => (entry = buildEntry(SALT, { ...sources, packages: new Map([...sources.packages, ["@salt-ds/theme", broken]]) }, { builtAt: "2026-11-19T00:00:00.000Z" })));
    expect(error.reason).toBe("invalid_entry");
    expect(error.problems).toContainEqual(expect.stringContaining("must be a custom property name"));
    expect(entry).toBeNull();
  });

  it("fails when a configured source wasn't supplied", () => {
    const sources = salt175();
    const error = failure(() => buildEntry(SALT, { packages: new Map([...sources.packages].filter(([name]) => name !== "@salt-ds/icons")), rules: sources.rules }, { builtAt: "2026-11-19T00:00:00.000Z" }));
    expect(error.reason).toBe("invalid_package");
    expect(error.problems).toEqual(["@salt-ds/icons wasn't supplied", "@salt-ds/mcp wasn't supplied"]);
  });
});

describe("reading a tarball", () => {
  it("reads regular files under the package directory, including long paths", () => {
    const long = `package/${"deep/".repeat(30)}file.d.ts`;
    const files = readTarball(tarball([{ path: "package/package.json", content: "{}" }, { path: long, content: "export {};" }, { path: "package/dir", type: "directory" }]));
    expect([...files.keys()]).toEqual(["package.json", long.slice("package/".length)]);
  });

  it("skips links and paths that would leave the package", () => {
    const files = readTarball(tarball([
      { path: "package/package.json", content: "{}" },
      { path: "package/link", type: "symlink", target: "/etc/passwd" },
      { path: "package/../outside.js", content: "x" },
      { path: "/absolute.js", content: "x" },
    ]));
    expect([...files.keys()]).toEqual(["package.json"]);
  });

  it("rejects a package whose manifest names another package or version", () => {
    const bytes = tarball([{ path: "package/package.json", content: JSON.stringify({ name: "@salt-ds/core", version: "1.74.0" }) }]);
    expect(failure(() => readPackage("@salt-ds/core", "1.75.0", bytes))).toMatchObject({ reason: "invalid_package", message: "The tarball for @salt-ds/core@1.75.0 contains @salt-ds/core@1.74.0" });
    expect(failure(() => readTarball(Buffer.from("not a tarball")))).toMatchObject({ reason: "invalid_package" });
  });
});
