// Helpers for the local development registry and for registry
// authentication. Tokens come only from the environment and are written only
// to temporary files outside the repository.
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const VERDACCIO = path.join(ROOT, "node_modules", ".bin", "verdaccio");

export async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

/**
 * Starts Verdaccio with the committed configuration. +storage+ defaults to
 * tmp/registry; tests pass a temporary directory so runs never share state.
 */
export async function startRegistry({ port = 4873, storage = path.join(ROOT, "tmp", "registry"), quiet = false } = {}) {
  fs.mkdirSync(storage, { recursive: true });
  const template = fs.readFileSync(path.join(ROOT, "registry", "verdaccio.yaml"), "utf8");
  const config = path.join(storage, "verdaccio.yaml");
  fs.writeFileSync(config, template.replace("../tmp/registry/storage", "./storage").replace("../tmp/registry/htpasswd", "./htpasswd"));
  const child = spawn(VERDACCIO, ["--config", config, "--listen", `127.0.0.1:${port}`], { stdio: quiet ? "ignore" : "inherit", env: { ...process.env, NODE_ENV: "production" } });
  const url = `http://127.0.0.1:${port}/`;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(`Verdaccio exited with ${child.exitCode}`);
    try {
      const response = await fetch(new URL("-/ping", url));
      if (response.ok) return { url, stop: () => new Promise((resolve) => (child.exitCode !== null ? resolve() : (child.once("exit", resolve), child.kill("SIGTERM")))) };
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  child.kill("SIGTERM");
  throw new Error(`Verdaccio did not start on ${url}`);
}

/**
 * Creates or logs in to the local registry account kept in +storage+ and
 * returns its token. The password is random and never leaves +storage+.
 */
export async function createToken(url, storage = path.join(ROOT, "tmp", "registry")) {
  const accountFile = path.join(storage, "account.json");
  if (!fs.existsSync(accountFile)) {
    fs.writeFileSync(accountFile, JSON.stringify({ name: "repo-facts-dev", password: crypto.randomBytes(24).toString("base64url") }), { mode: 0o600 });
  }
  const { name, password } = JSON.parse(fs.readFileSync(accountFile, "utf8"));
  const login = (authorization) =>
    fetch(new URL(`-/user/org.couchdb.user:${encodeURIComponent(name)}`, url), {
      method: "PUT",
      headers: { "content-type": "application/json", ...(authorization && { authorization }) },
      body: JSON.stringify({ name, password, type: "user" }),
    });
  // A new account registers; an existing one (409) logs in with its stored credentials.
  let response = await login();
  if (response.status === 409) response = await login(`Basic ${Buffer.from(`${name}:${password}`).toString("base64")}`);
  const body = await response.json();
  if (!body.token) throw new Error(`The registry refused to issue a token (${response.status})`);
  return body.token;
}

/**
 * Writes a temporary npm user configuration that authenticates to +registry+
 * with +token+, and returns its path and a cleanup function. npm requires
 * tokens on a host-specific key, which a committed .npmrc cannot derive.
 */
export function authConfig(registry = process.env.REPO_FACTS_NPM_REGISTRY, token = process.env.REPO_FACTS_NPM_TOKEN) {
  if (!registry) throw new Error("REPO_FACTS_NPM_REGISTRY is not set");
  if (!token) throw new Error("REPO_FACTS_NPM_TOKEN is not set");
  const { host, pathname } = new URL(registry);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "repo-facts-npm-"));
  const file = path.join(directory, "npmrc");
  fs.writeFileSync(file, `//${host}${pathname.endsWith("/") ? pathname : `${pathname}/`}:_authToken=${token}\n`, { mode: 0o600 });
  return { file, cleanup: () => fs.rmSync(directory, { recursive: true, force: true }) };
}
