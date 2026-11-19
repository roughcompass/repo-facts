import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { type CatalogThing, type PackageFiles, readPackage } from "../src/index.js";

/**
 * Fixtures for the Catalog Builder's tests.
 *
 * test/fixtures holds Salt's published tarballs, downloaded once from the
 * public npm registry and trimmed to keep the repository small. Each is still
 * an npm tarball, with its files under `package/` and its own package.json,
 * holding only what the builder reads:
 * - `@salt-ds/core` 1.75.0 and 1.50.0, and `@salt-ds/icons` 1.19.0: the type
 *   declarations (`dist-types/**\/*.d.ts`). The JavaScript, CSS, and source
 *   maps are left out.
 * - `@salt-ds/theme` 1.48.0 and 1.33.0: the stylesheets, unchanged.
 * - `@salt-ds/mcp` 0.0.0-snapshot-20260331141637: `generated/metadata.json`
 *   and `deprecations.json` unchanged, and `patterns.json`,
 *   `components.json`, and `guides.json` with only the fields the builder
 *   reads (ids, names, summaries, when to use, `composed_of`, and the
 *   scaffold's regions). Its examples, props, tokens, icons, and search
 *   indexes, about 13 MB, are left out.
 * File contents are otherwise byte for byte as published; the tarballs are
 * repacked with fixed modes and times.
 */

export const FIXTURES = path.join(import.meta.dirname, "fixtures");

/** A fixture tarball's bytes, such as `@salt-ds/core` 1.75.0. */
export function fixtureTarball(name: string, version: string): Buffer {
  return fs.readFileSync(path.join(FIXTURES, `${name.replace("@", "").replace("/", "-")}-${version}.tgz`));
}

/** A fixture package, read. */
export function fixturePackage(name: string, version: string): PackageFiles {
  return readPackage(name, version, fixtureTarball(name, version));
}

/** Salt, as the Frontend Registry's config/catalog.yaml describes it. */
export const SALT: CatalogThing = { kind: "design_system", id: "salt", package: "@salt-ds/core", tokens: "@salt-ds/theme", icons: "@salt-ds/icons", data: { package: "@salt-ds/mcp", format: "salt-mcp" } };

/** The team's rules for Salt, as the package ships them. */
export const SALT_RULES = fs.readFileSync(path.join(import.meta.dirname, "..", "catalog-rules", "salt.yaml"), "utf8");

export const MCP_VERSION = "0.0.0-snapshot-20260331141637";

/** The sources of Salt 1.75.0, read from the fixtures. */
export function salt175() {
  return {
    packages: new Map([fixturePackage("@salt-ds/core", "1.75.0"), fixturePackage("@salt-ds/theme", "1.48.0"), fixturePackage("@salt-ds/icons", "1.19.0")].map((pkg) => [pkg.name, pkg])),
    data: fixturePackage("@salt-ds/mcp", MCP_VERSION),
    rules: SALT_RULES,
  };
}

export type TarEntry = { path: string; content?: string | Buffer; type?: "file" | "symlink" | "directory"; target?: string };

/** A gzipped tarball holding +entries+, as npm packs one; long paths use a pax header. */
export function tarball(entries: readonly TarEntry[]): Buffer {
  const blocks: Buffer[] = [];
  const header = (name: string, size: number, type: string, target = "") => {
    const block = Buffer.alloc(512);
    block.write(name.slice(0, 100), 0, 100, "utf8");
    block.write("0000644\0", 100);
    block.write("0000000\0", 108);
    block.write("0000000\0", 116);
    block.write(`${size.toString(8).padStart(11, "0")}\0`, 124);
    block.write("00000000000\0", 136);
    block.write("        ", 148);
    block.write(type, 156);
    block.write(target, 157, 100, "utf8");
    block.write("ustar\0", 257);
    block.write("00", 263);
    let sum = 0;
    for (const byte of block) sum += byte;
    block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
    return block;
  };
  const body = (content: Buffer) => [content, Buffer.alloc((512 - (content.length % 512)) % 512)];
  for (const entry of entries) {
    const content = Buffer.from(entry.content ?? "");
    if (Buffer.byteLength(entry.path) > 100) {
      const record = (length: number) => `${length} path=${entry.path}\n`;
      let length = Buffer.byteLength(record(0));
      while (Buffer.byteLength(record(length)) !== length) length = Buffer.byteLength(record(length));
      const pax = Buffer.from(record(length));
      blocks.push(header("PaxHeader", pax.length, "x"), ...body(pax));
    }
    const type = entry.type === "symlink" ? "2" : entry.type === "directory" ? "5" : "0";
    blocks.push(header(entry.path, entry.type === "file" || !entry.type ? content.length : 0, type, entry.target), ...(entry.type === "file" || !entry.type ? body(content) : []));
  }
  blocks.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(blocks));
}
