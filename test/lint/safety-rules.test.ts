import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

// Proves the lint rules that keep package source from executing, loading,
// or contacting anything stay in force for every package.
const eslint = new ESLint();

async function violations(code: string, filePath = "packages/core/src/example.ts") {
  const [result] = await eslint.lintText(code, { filePath });
  return (result?.messages ?? []).map((message) => `${message.line}:${message.ruleId}`);
}

const PACKAGES = ["contract", "syntax", "core", "architecture", "services", "design-system", "bundle"];

describe("safety lint rules", () => {
  it.each([
    ["eval", "export const run = (code: string) => eval(code);", "no-eval"],
    ["implied eval", 'export const later = () => setTimeout("alert(1)", 1);', "no-implied-eval"],
    ["the Function constructor", "export const run = (code: string) => new Function(code);", "no-new-func"],
    ["a constructor-property escape", 'export const run = () => ({}).constructor.constructor("return 1")();', "no-restricted-syntax"],
    ["Reflect.construct", "export const run = () => Reflect.construct(Function, []);", "no-restricted-properties"],
    ["the vm module", 'import vm from "node:vm";\nexport default vm;', "no-restricted-imports"],
    ["createRequire", 'import { createRequire } from "node:module";\nexport default createRequire;', "no-restricted-imports"],
    ["child_process", 'import { spawn } from "child_process";\nexport default spawn;', "no-restricted-imports"],
    ["worker threads", 'import { Worker } from "node:worker_threads";\nexport default Worker;', "no-restricted-imports"],
    ["a dynamic import", 'export const load = () => import("./other.js");', "no-restricted-syntax"],
    ["a computed dynamic import", "export const load = (name: string) => import(name);", "no-restricted-syntax"],
    ["require()", 'export const fs = require("node:fs");', "no-restricted-globals"],
    ["a RegExp built from data", "export const match = (pattern: string) => new RegExp(pattern);", "no-restricted-syntax"],
    ["a RegExp called with data", "export const match = (pattern: string) => RegExp(pattern);", "no-restricted-syntax"],
    ["the network", 'import https from "node:https";\nexport default https;', "no-restricted-imports"],
    ["DNS", 'import dns from "dns";\nexport default dns;', "no-restricted-imports"],
    ["the filesystem", 'import fs from "node:fs/promises";\nexport default fs;', "no-restricted-imports"],
    ["an HTTP client package", 'import axios from "axios";\nexport default axios;', "no-restricted-imports"],
    ["a database package", 'import Database from "better-sqlite3";\nexport default Database;', "no-restricted-imports"],
    ["a Git client package", 'import git from "isomorphic-git";\nexport default git;', "no-restricted-imports"],
    ["environment loading", 'import "dotenv/config";', "no-restricted-imports"],
    ["fetch", 'export const call = () => fetch("https://example.invalid");', "no-restricted-globals"],
    ["globalThis.fetch", 'export const call = () => globalThis.fetch("https://example.invalid");', "no-restricted-properties"],
    ["WebSocket", 'export const open = () => new WebSocket("wss://example.invalid");', "no-restricted-globals"],
    ["the process environment", "export const token = () => process.env.TOKEN;", "no-restricted-globals"],
    ["globalThis.process", "export const token = () => globalThis.process.env.TOKEN;", "no-restricted-properties"],
  ])("rejects %s in every package", async (_name, code, rule) => {
    for (const name of PACKAGES) {
      expect(await violations(code, `packages/${name}/src/example.ts`), name).toContainEqual(expect.stringContaining(rule));
    }
  });

  it("allows literal regular expressions, static imports, and hashing", async () => {
    const code = 'import crypto from "node:crypto";\nimport path from "node:path";\nexport const pattern = new RegExp("^[a-z]+$");\nexport const digest = (text: string) => crypto.createHash("sha256").update(text).digest("hex");\nexport default path;';
    expect(await violations(code)).toEqual([]);
  });

  it("allows type-only imports from capability modules", async () => {
    const code = 'import type { Stats } from "node:fs";\nimport type { AxiosInstance } from "axios";\nexport type Pair = [Stats, AxiosInstance];';
    expect(await violations(code)).toEqual([]);
  });

  it("does not allow type-only imports of execution modules", async () => {
    expect(await violations('import type { Context } from "node:vm";\nexport type Sandbox = Context;')).toContainEqual(expect.stringContaining("no-restricted-imports"));
  });

  it("leaves tests and build scripts free to use Node facilities", async () => {
    const code = 'import fs from "node:fs";\nexport const read = () => fs.readFileSync("x", "utf8") + process.env.HOME;';
    expect(await violations(code, "packages/core/test/example.test.ts")).toEqual([]);
    expect(await violations(code, "scripts/example.ts")).toEqual([]);
  });
});
