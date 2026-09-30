import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// @ts-expect-error The helpers are plain ESM scripts without type declarations.
import { ROOT, createToken, freePort, startRegistry } from "../../scripts/lib/registry.mjs";

const PACKAGES = ["contract", "syntax", "core", "architecture", "services", "bundle"];
const IDENTITY = ["-c", "user.name=repo-facts release test", "-c", "user.email=release-test@repo-facts.invalid"];

/**
 * Releases run from throwaway copies of this repository, committed under a
 * test identity, so the real repository's history is never touched.
 */
describe("lockstep releases", () => {
  let workspace: string;
  let registry: { url: string; stop: () => Promise<void> };
  let token: string;

  const git = (cwd: string, ...args: string[]) => execFileSync("git", [...IDENTITY, ...args], { cwd, encoding: "utf8" }).trim();

  /** A copy of the repository with its files committed, like a fresh clone. */
  const copyRepository = (name: string) => {
    const root = path.join(workspace, name);
    const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: ROOT, encoding: "utf8" }).split("\0").filter(Boolean);
    for (const file of files) {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.copyFileSync(path.join(ROOT, file), path.join(root, file));
    }
    // Reuse installed tooling to run the scripts; publication installs afresh.
    fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(root, "node_modules"));
    git(root, "init", "--quiet", "-b", "main");
    fs.appendFileSync(path.join(root, ".git", "info", "exclude"), "node_modules\n");
    git(root, "add", "--all");
    git(root, "commit", "--quiet", "-m", "Initial");
    return root;
  };

  /** Runs the README's release steps: set the version, then commit it (with +change+ applied first). */
  const sourceRepository = (name: string, version: string, change?: (root: string) => void) => {
    const root = copyRepository(name);
    const versioned = spawnSync("npm", ["run", "release:version", "--", version], { cwd: root, encoding: "utf8" });
    expect(versioned.status, versioned.stderr).toBe(0);
    if (change) {
      change(root);
      git(root, "add", "--all");
    }
    git(root, "commit", "--quiet", "-am", `Release ${version}`);
    return root;
  };

  const release = (root: string) =>
    spawnSync("npm", ["run", "release:publish"], { cwd: root, encoding: "utf8", env: { ...process.env, REPO_FACTS_NPM_REGISTRY: registry.url, REPO_FACTS_NPM_TOKEN: token } });

  /** Versions of +name+ in the registry. Retries a reused socket that the registry already closed. */
  const published = async (name: string): Promise<string[]> => {
    for (let attempt = 1; ; attempt++) {
      try {
        const response = await fetch(new URL(`@repo-facts%2f${name}`, registry.url));
        return response.ok ? Object.keys(((await response.json()) as { versions: Record<string, unknown> }).versions) : [];
      } catch (error) {
        if (attempt === 3) throw error;
      }
    }
  };

  beforeAll(async () => {
    workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "repo-facts-release-test-")));
    const storage = path.join(workspace, "registry");
    registry = await startRegistry({ port: await freePort(), storage, quiet: true });
    token = await createToken(registry.url, storage);
  });

  afterAll(async () => {
    await registry?.stop();
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it("publishes every package at one version with provenance, resolvable through the bundle", async () => {
    const root = sourceRepository("good", "0.1.0-rc.0");
    const commit = git(root, "rev-parse", "HEAD");
    const result = release(root);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    // The gates ran in the clean checkout before anything was published.
    expect(result.stdout).toMatch(/> [^\n]*verify\n/);
    expect(result.stdout.indexOf("Publishing")).toBeGreaterThan(result.stdout.search(/Tests +\d+ passed/));
    const order = [...result.stdout.matchAll(/Publishing (@repo-facts\/[a-z]+)@/g)].map((match) => match[1]);
    expect(order).toEqual(["@repo-facts/contract", "@repo-facts/core", "@repo-facts/syntax", "@repo-facts/architecture", "@repo-facts/services", "@repo-facts/bundle"]);

    const consumer = path.join(workspace, "consumer");
    fs.mkdirSync(consumer);
    fs.copyFileSync(path.join(ROOT, ".npmrc"), path.join(consumer, ".npmrc"));
    fs.writeFileSync(path.join(consumer, "package.json"), JSON.stringify({ name: "consumer", version: "0.0.0", private: true }));
    const installed = spawnSync("npm", ["install", "--save-exact", "@repo-facts/bundle@0.1.0-rc.0"], { cwd: consumer, encoding: "utf8", env: { ...process.env, REPO_FACTS_NPM_REGISTRY: registry.url } });
    expect(installed.status, installed.stderr).toBe(0);

    for (const name of PACKAGES) {
      const directory = path.join(consumer, "node_modules", "@repo-facts", name);
      const manifest = JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8"));
      expect(manifest.version, name).toBe("0.1.0-rc.0");
      expect(manifest.repoFacts, name).toEqual({ commit, release: "0.1.0-rc.0" });
      expect(JSON.parse(fs.readFileSync(path.join(directory, "provenance.json"), "utf8")), name).toEqual({ package: `@repo-facts/${name}`, version: "0.1.0-rc.0", commit });
      expect(fs.existsSync(path.join(directory, "dist", "index.js")), name).toBe(true);
      const shipped = fs.readdirSync(directory, { recursive: true, encoding: "utf8" });
      expect(shipped.filter((file) => file.endsWith(".tsbuildinfo") || file.startsWith("src")), name).toEqual([]);
      for (const [dependency, range] of Object.entries((manifest.dependencies ?? {}) as Record<string, string>)) {
        if (dependency.startsWith("@repo-facts/")) expect(range, `${name} -> ${dependency}`).toBe("0.1.0-rc.0");
      }
    }
    expect(fs.readdirSync(path.join(consumer, "node_modules", "@repo-facts")).sort()).toEqual([...PACKAGES].sort());
  });

  it("dry-runs uncommitted work without a registry, building and packing every package", () => {
    const root = copyRepository("dry-run");
    fs.appendFileSync(path.join(root, "README.md"), "\nuncommitted\n");
    const environment = { ...process.env };
    delete environment.REPO_FACTS_NPM_REGISTRY;
    const started = Date.now();
    const result = spawnSync("npm", ["run", "release:dry-run"], { cwd: root, encoding: "utf8", env: environment });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("Dry run of the uncommitted working tree.");
    expect([...result.stdout.matchAll(/Would publish (@repo-facts\/[a-z]+)@0\.0\.0/g)].map((match) => match[1])).toHaveLength(PACKAGES.length);
    expect(result.stdout).not.toContain("Publishing");
    expect(Date.now() - started).toBeLessThan(120_000);
  });

  it("refuses to release a dirty tree", async () => {
    const root = sourceRepository("dirty", "0.2.0-rc.0");
    fs.appendFileSync(path.join(root, "README.md"), "\nuncommitted\n");
    const result = release(root);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Refusing to release a dirty tree");
    expect(await published("contract")).not.toContain("0.2.0-rc.0");
  });

  it("refuses to release when a gate fails, before publishing anything", async () => {
    const root = sourceRepository("failing", "0.3.0-rc.0", (tree) => {
      fs.mkdirSync(path.join(tree, "packages", "contract", "test"), { recursive: true });
      fs.writeFileSync(path.join(tree, "packages", "contract", "test", "gate.test.ts"), 'import { expect, it } from "vitest";\n\nit("fails the release gate", () => {\n  expect(1).toBe(2);\n});\n');
    });
    const result = release(root);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("fails the release gate");
    expect(result.stdout).not.toContain("Publishing");
    for (const name of PACKAGES) expect(await published(name), name).not.toContain("0.3.0-rc.0");
  });

  it("refuses mixed versions", async () => {
    const root = sourceRepository("mixed", "0.4.0-rc.0", (tree) => {
      const file = path.join(tree, "packages", "core", "package.json");
      const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
      manifest.version = "0.4.0-rc.1";
      fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
    });
    const result = release(root);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("@repo-facts/core is at 0.4.0-rc.1, not 0.4.0-rc.0");
    expect(await published("core")).not.toContain("0.4.0-rc.1");
  });
});
