// Copies the reference documents that ship with @repo-facts/contract into the
// package, so consumers such as the Frontend Registry can render the copy
// that matches the installed release. `npm run build` runs it after tsc.
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./lib/registry.mjs";

/** The documents @repo-facts/contract publishes under docs/. */
export const CONTRACT_DOCS = ["detector-contract.md", "reference-catalog.md"];

const target = path.join(ROOT, "packages", "contract", "docs");
fs.rmSync(target, { recursive: true, force: true });
fs.mkdirSync(target, { recursive: true });
for (const name of CONTRACT_DOCS) fs.copyFileSync(path.join(ROOT, "docs", name), path.join(target, name));
