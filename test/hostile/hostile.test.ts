import child_process, { spawn as namedSpawn } from "node:child_process";
import dns, { lookup as namedLookup } from "node:dns";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import module from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import vm from "node:vm";
import worker_threads from "node:worker_threads";
import { analyze } from "@repo-facts/bundle";
import { type FactDocument, factDocumentProblems } from "@repo-facts/contract";
import { type StylesheetResult, parseStylesheet } from "@repo-facts/syntax";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadFixture, readerFor } from "../golden/harness.js";

/**
 * The hostile-repository fixture runs through the full bundle while every way
 * to reach the network, start a process, load code, or evaluate code is
 * replaced by a trap that records the attempt and throws. Everything in the
 * fixture that could execute writes a sentinel file into
 * REPO_FACTS_SENTINEL_DIR; none may appear.
 */

type Owner = Record<string, unknown>;

function installTraps(): { attempts: string[]; restore: () => void } {
  const attempts: string[] = [];
  const restores: (() => void)[] = [];
  const trap = (owner: object, name: string, label: string) => {
    const target = owner as Owner;
    const original = target[name];
    if (typeof original !== "function") return;
    target[name] = function trapped() {
      attempts.push(label);
      throw new Error(`hostile suite: ${label} was attempted`);
    };
    restores.push(() => {
      target[name] = original;
    });
  };

  for (const name of ["lookup", "lookupService", "resolve", "resolve4", "resolve6", "resolveAny", "resolveCname", "resolveMx", "resolveNs", "resolvePtr", "resolveSrv", "resolveTxt", "reverse"]) {
    trap(dns, name, `dns.${name}`);
    trap(dns.promises, name, `dns.promises.${name}`);
  }
  trap(net, "connect", "net.connect");
  trap(net, "createConnection", "net.createConnection");
  trap(net.Socket.prototype, "connect", "net.Socket.connect");
  trap(tls, "connect", "tls.connect");
  for (const name of ["request", "get"]) {
    trap(http, name, `http.${name}`);
    trap(https, name, `https.${name}`);
  }
  trap(globalThis, "fetch", "fetch");
  trap(globalThis, "WebSocket", "WebSocket");
  trap(globalThis, "EventSource", "EventSource");
  for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) trap(child_process, name, `child_process.${name}`);
  trap(worker_threads, "Worker", "worker_threads.Worker");
  trap(process, "dlopen", "process.dlopen");
  for (const name of ["Script", "runInThisContext", "runInNewContext", "runInContext", "compileFunction"]) trap(vm, name, `vm.${name}`);
  trap(globalThis, "eval", "eval");
  // Loading any CommonJS module, including a repository file, goes through Module._load; `module` is Module itself.
  trap(module, "_load", "module._load");
  trap(module, "createRequire", "module.createRequire");

  // ESM named imports of built-ins see the trapped functions only after syncing.
  module.syncBuiltinESMExports();
  return {
    attempts,
    restore: () => {
      for (const restore of restores.reverse()) restore();
      module.syncBuiltinESMExports();
    },
  };
}

describe("hostile-suite traps", () => {
  it("fire for every channel they guard, including named ESM imports of built-ins", async () => {
    const traps = installTraps();
    const channels: [string, () => unknown][] = [
      ["fetch", () => fetch("http://trap.invalid/")],
      ["dns.lookup", () => dns.lookup("trap.invalid", () => {})],
      ["dns.lookup", () => namedLookup("trap.invalid", () => {})],
      ["dns.promises.resolve", () => dns.promises.resolve("trap.invalid")],
      ["net.connect", () => net.connect(9, "127.0.0.1")],
      ["net.Socket.connect", () => new net.Socket().connect(9, "127.0.0.1")],
      ["https.get", () => https.get("https://trap.invalid/")],
      ["child_process.execSync", () => child_process.execSync("true")],
      ["child_process.spawn", () => namedSpawn("true")],
      ["worker_threads.Worker", () => new worker_threads.Worker("", { eval: true })],
      ["vm.runInNewContext", () => vm.runInNewContext("1")],
      ["eval", () => globalThis.eval("1")],
      ["module.createRequire", () => module.createRequire(import.meta.url)],
    ];
    try {
      for (const [label, call] of channels) expect(call, label).toThrow(`${label} was attempted`);
    } finally {
      traps.restore();
    }
    expect(traps.attempts).toEqual(channels.map(([label]) => label));
    // Restored: named imports see the real functions again.
    expect(namedLookup).toBe(dns.lookup);
    expect(namedSpawn).toBe(child_process.spawn);
  });
});

describe("hostile stylesheets", () => {
  // Parsed in path order under the traps, so the deep stylesheet comes first and the next one must still parse.
  const fixture = loadFixture("hostile-repository");
  const stylesheets = Object.keys(fixture.files).filter((file) => file.endsWith(".css"));
  const parsed = new Map<string, StylesheetResult>();
  let attempts: string[] = [];

  beforeAll(() => {
    const traps = installTraps();
    try {
      for (const file of stylesheets) parsed.set(file, parseStylesheet((fixture.files[file] as Buffer).toString("utf8")));
    } finally {
      traps.restore();
    }
    attempts = traps.attempts;
  });

  it("skips the stylesheet nested past the depth limit whole, and parses the next", () => {
    expect(stylesheets).toEqual(["src/styles/deep.css", "src/styles/remote.css"]);
    const deep = parsed.get("src/styles/deep.css")!;
    expect(deep.ok).toBe(false);
    expect(!deep.ok && deep.failure.reason).toBe("stylesheet_depth_limit");
    expect(parsed.get("src/styles/remote.css")!.ok).toBe(true);
  });

  it("reads imports and url() targets as data, making no request and loading nothing", () => {
    const remote = parsed.get("src/styles/remote.css")!;
    if (!remote.ok) throw new Error(remote.failure.reason);
    expect(remote.stylesheet.imports.map((entry) => entry.url)).toEqual(["https://example.invalid/theme.css", "../payload.js"]);
    expect(remote.stylesheet.unparsed).toEqual([]);
    expect(attempts).toEqual([]);
  });
});

const prototypes = [Object.prototype, Array.prototype, Function.prototype, String.prototype];
const shapeOf = () => prototypes.map((prototype) => Object.getOwnPropertyNames(prototype).sort());

describe("hostile repository", () => {
  let sentinels: string;
  let document: FactDocument;
  let attempts: string[];
  let before: string[][];
  const requested: string[] = [];

  beforeAll(async () => {
    sentinels = fs.mkdtempSync(path.join(os.tmpdir(), "repo-facts-sentinels-"));
    const fixture = loadFixture("hostile-repository");
    // Record every path a detector asks the reader for, including link targets.
    const reader = readerFor(fixture);
    const read = reader.read.bind(reader);
    const readMany = reader.readMany.bind(reader);
    const linkTarget = reader.linkTarget.bind(reader);
    reader.read = (file) => (requested.push(file), read(file));
    reader.readMany = (files) => (requested.push(...files), readMany(files));
    reader.linkTarget = (file) => (requested.push(file), linkTarget(file));
    const previous = process.env.REPO_FACTS_SENTINEL_DIR;
    process.env.REPO_FACTS_SENTINEL_DIR = sentinels;
    before = shapeOf();
    const traps = installTraps();
    try {
      document = await analyze(reader);
    } finally {
      traps.restore();
      if (previous === undefined) delete process.env.REPO_FACTS_SENTINEL_DIR;
      else process.env.REPO_FACTS_SENTINEL_DIR = previous;
    }
    attempts = traps.attempts;
  });

  afterAll(() => {
    fs.rmSync(sentinels, { recursive: true, force: true });
  });

  it("runs the full bundle to a valid document", () => {
    expect(factDocumentProblems(document)).toEqual([]);
  });

  it("attempts no network, DNS, process, worker, module-loading, or evaluation call", () => {
    expect(attempts).toEqual([]);
  });

  it("creates no sentinel, so nothing in the repository ran", () => {
    expect(fs.readdirSync(sentinels)).toEqual([]);
  });

  it("leaves built-in prototypes unpolluted", () => {
    expect(shapeOf()).toEqual(before);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("reports lifecycle scripts and remote commands as data, never running them", () => {
    const scripts = document.categories.scripts!.facts.map((fact) => fact.key);
    expect(scripts).toEqual(expect.arrayContaining([expect.stringContaining("preinstall"), expect.stringContaining("postinstall"), expect.stringContaining("prepare")]));
    expect(JSON.stringify(document.categories.verification_commands)).toContain("npm test");
  });

  it("reads configuration modules as syntax: their object literals are reported, their side effects are not", () => {
    expect(document.categories.composition!.facts).toContainEqual(expect.objectContaining({ key: "module-federation:hostile", value: expect.objectContaining({ remotes: [{ alias: "trap", federation_name: "trap", entry: { kind: "literal", value: "http://trap.invalid/remoteEntry.js" } }] }) }));
    expect(document.categories.egress_routes!.facts).toContainEqual(expect.objectContaining({ key: "dev-proxy:vite.config.ts:/api" }));
  });

  it("records the trap endpoints as Service Dependencies without contacting them", () => {
    const keys = document.service_dependencies.map((service) => service.key);
    expect(keys).toEqual(expect.arrayContaining(["http://trap.invalid", "websocket:ws://trap.invalid", "sse:http://127.0.0.1:9"]));
    for (const service of document.service_dependencies) expect(service.access.state).toBe("unknown");
  });

  it("never asks for sensitive files or the symbolic link, and never clones the submodule", () => {
    expect(requested.length).toBeGreaterThan(10);
    expect(requested.filter((file) => [".env", ".npmrc", "outside-link"].includes(file))).toEqual([]);
    // Sensitive files are reported by existence only.
    expect(document.categories.access_signals!.facts.map((fact) => fact.key)).toEqual(expect.arrayContaining(["file:.env", "file:.npmrc"]));
    expect(document.inventory.symlinks).toBe(1);
    expect(document.categories.submodules!.facts).toMatchObject([{ key: "vendor/trap", value: { path: "vendor/trap", commit: "1111111111111111111111111111111111111111" } }]);
    expect(JSON.stringify(document)).not.toContain("do-not-leak");
    expect(JSON.stringify(document)).not.toContain("root:");
  });

  it("bounds hostile inputs with diagnostics instead of hanging or guessing", () => {
    const reasons = document.diagnostics.map((diagnostic) => `${diagnostic.path}: ${diagnostic.reason}`);
    expect(reasons).toEqual(expect.arrayContaining(["src/deep.ts: syntax_depth_limit", "src/styles/deep.css: stylesheet_depth_limit", expect.stringMatching(/^\.github\/workflows\/bomb\.yml: parse_failed$/), expect.stringMatching(/^public\/deep\.importmap\.json: /)]));
    // The deep stylesheet is a skipped input; the next one is parsed and counted.
    for (const category of ["ui_elements", "style_values"]) expect(document.categories[category]!.search.skipped).toContain("src/styles/deep.css");
    expect(document.categories.style_values!.search.skipped).not.toContain("src/styles/remote.css");
    expect(document.categories.style_values!.facts.map((fact) => fact.key)).toEqual(expect.arrayContaining(["declarations:color"]));
  });
});
