import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// @ts-expect-error The helpers are plain ESM scripts without type declarations.
import { ROOT, authConfig, createToken, freePort, startRegistry } from "../../scripts/lib/registry.mjs";

interface Registry {
  url: string;
  stop: () => Promise<void>;
}

const SCRATCH = "@repo-facts/scratch";

describe("local registry and committed npm configuration", () => {
  let workspace: string;
  let storage: string;
  let registry: Registry;
  let token: string;
  let emptyUserconfig: string;

  const npm = (cwd: string, args: string[], env: Record<string, string | undefined> = {}) =>
    spawnSync("npm", args, {
      cwd,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        HOME: workspace,
        npm_config_cache: path.join(workspace, "cache"),
        npm_config_update_notifier: "false",
        npm_config_fund: "false",
        npm_config_audit: "false",
        REPO_FACTS_NPM_REGISTRY: registry.url,
        ...env,
      },
    });

  /** A directory holding the committed .npmrc and the given package.json. */
  const project = (name: string, manifest: object, files: Record<string, string> = {}) => {
    const directory = path.join(workspace, name);
    fs.mkdirSync(directory, { recursive: true });
    fs.copyFileSync(path.join(ROOT, ".npmrc"), path.join(directory, ".npmrc"));
    fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify(manifest, null, 2));
    for (const [file, content] of Object.entries(files)) fs.writeFileSync(path.join(directory, file), content);
    return directory;
  };

  beforeAll(async () => {
    workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "repo-facts-registry-")));
    storage = path.join(workspace, "registry");
    emptyUserconfig = path.join(workspace, "empty-npmrc");
    fs.writeFileSync(emptyUserconfig, "");
    registry = await startRegistry({ port: await freePort(), storage, quiet: true });
    token = await createToken(registry.url, storage);

    const sentinel = path.join(workspace, "lifecycle-ran");
    const scratch = project(
      "scratch",
      { name: SCRATCH, version: "0.0.1", type: "module", main: "index.js", scripts: { postinstall: `node -e "require('fs').writeFileSync('${sentinel}','ran')"`, install: `node -e "require('fs').writeFileSync('${sentinel}','ran')"` } },
      { "index.js": "export const answer = 42;\n" },
    );
    const auth = authConfig(registry.url, token);
    try {
      const published = npm(scratch, ["publish", "--userconfig", auth.file]);
      expect(published.status, published.stderr).toBe(0);
    } finally {
      auth.cleanup();
    }
  }, 60_000);

  afterAll(async () => {
    await registry?.stop();
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it("installs an exact version without running lifecycle scripts and records its integrity", () => {
    const consumer = project("consumer", { name: "consumer", version: "0.0.0", private: true });
    const installed = npm(consumer, ["install", "--save-exact", `${SCRATCH}@0.0.1`, "--userconfig", emptyUserconfig]);
    expect(installed.status, installed.stderr).toBe(0);

    expect(fs.existsSync(path.join(workspace, "lifecycle-ran"))).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(consumer, "package.json"), "utf8")).dependencies).toEqual({ [SCRATCH]: "0.0.1" });

    // The lockfile names no registry, so installs always go through the scope mapping.
    const lock = JSON.parse(fs.readFileSync(path.join(consumer, "package-lock.json"), "utf8"));
    const entry = lock.packages[`node_modules/${SCRATCH}`];
    expect(entry).not.toHaveProperty("resolved");
    const tarball = execFileSync("curl", ["-sf", `${registry.url}${SCRATCH}/-/scratch-0.0.1.tgz`]);
    expect(entry.integrity).toBe(`sha512-${crypto.createHash("sha512").update(tarball).digest("base64")}`);

    fs.rmSync(path.join(consumer, "node_modules"), { recursive: true, force: true });
    const reinstalled = npm(consumer, ["ci", "--userconfig", emptyUserconfig], { npm_config_cache: path.join(workspace, "ci-cache") });
    expect(reinstalled.status, reinstalled.stderr).toBe(0);
    expect(fs.existsSync(path.join(consumer, "node_modules", "@repo-facts", "scratch", "index.js"))).toBe(true);
  }, 60_000);

  it("refuses a package whose bytes do not match the recorded integrity", () => {
    const consumer = project("tampered", { name: "tampered", version: "0.0.0", private: true, dependencies: { [SCRATCH]: "0.0.1" } });
    const installed = npm(consumer, ["install", "--userconfig", emptyUserconfig]);
    expect(installed.status, installed.stderr).toBe(0);
    const lockFile = path.join(consumer, "package-lock.json");
    const lock = JSON.parse(fs.readFileSync(lockFile, "utf8"));
    lock.packages[`node_modules/${SCRATCH}`].integrity = `sha512-${crypto.createHash("sha512").update("other bytes").digest("base64")}`;
    fs.writeFileSync(lockFile, JSON.stringify(lock, null, 2));
    fs.rmSync(path.join(consumer, "node_modules"), { recursive: true, force: true });

    const reinstalled = npm(consumer, ["ci", "--userconfig", emptyUserconfig], { npm_config_cache: path.join(workspace, "fresh-cache") });
    expect(reinstalled.status).not.toBe(0);
    expect(reinstalled.stderr).toContain("EINTEGRITY");
  }, 60_000);

  it("fails closed when the internal registry is not configured", () => {
    const consumer = project("unconfigured", { name: "unconfigured", version: "0.0.0", private: true });
    const installed = npm(consumer, ["install", `${SCRATCH}@0.0.1`, "--userconfig", emptyUserconfig], { REPO_FACTS_NPM_REGISTRY: undefined });
    expect(installed.status).not.toBe(0);
    expect(fs.existsSync(path.join(consumer, "node_modules", "@repo-facts"))).toBe(false);
  }, 60_000);

  it("keeps credentials out of every file the repository would commit", () => {
    const account = JSON.parse(fs.readFileSync(path.join(storage, "account.json"), "utf8")) as { password: string };
    const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: ROOT, encoding: "utf8" }).split("\0").filter(Boolean);
    expect(files.length).toBeGreaterThan(10);
    // Files npm or CI could load as configuration must never carry a literal token.
    // Test fixtures elsewhere hold fake ones on purpose, to prove readers never read them.
    const configuration = (file: string) => path.basename(file) === ".npmrc" || /^(\.github|registry|scripts)\//.test(file);
    expect(files.filter(configuration).length).toBeGreaterThan(3);
    for (const file of files) {
      const content = fs.readFileSync(path.join(ROOT, file), "utf8");
      expect(content.includes(token), file).toBe(false);
      expect(content.includes(account.password), file).toBe(false);
      if (configuration(file)) expect(content, file).not.toMatch(/_authToken\s*=\s*[^$\s]/);
    }
  });
});
