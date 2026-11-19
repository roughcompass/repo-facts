import zlib from "node:zlib";
import { CatalogBuildError } from "./errors.js";

/**
 * Package tarballs, read as data. A tarball is gunzipped and its tar entries
 * read in memory: regular files only, with npm's leading `package/` directory
 * removed. Nothing is written to disk, and nothing in a package runs: install
 * scripts are never invoked, because no package manager is.
 */

/** Bounds on what one tarball may hold. */
export const TARBALL_LIMITS = { maxCompressedBytes: 64 * 1024 * 1024, maxBytes: 256 * 1024 * 1024, maxFiles: 50_000 } as const;

export interface PackageFiles {
  name: string;
  version: string;
  /** File contents by path within the package, such as `dist-types/index.d.ts`. */
  files: ReadonlyMap<string, Uint8Array>;
  /** The parsed package.json. */
  manifest: Record<string, unknown>;
}

const decoder = new TextDecoder("utf-8", { fatal: false });

/** A file's text, or null when the package doesn't have it. */
export function textOf(pkg: PackageFiles, path: string): string | null {
  const bytes = pkg.files.get(path);
  return bytes ? decoder.decode(bytes) : null;
}

/** Every file in a tarball, by path, without the leading directory npm packs everything under. */
export function readTarball(bytes: Uint8Array): Map<string, Uint8Array> {
  if (bytes.length > TARBALL_LIMITS.maxCompressedBytes) throw new CatalogBuildError("invalid_package", `The tarball is larger than ${TARBALL_LIMITS.maxCompressedBytes} bytes`);
  let tar: Buffer;
  try {
    tar = zlib.gunzipSync(bytes, { maxOutputLength: TARBALL_LIMITS.maxBytes });
  } catch (error) {
    throw new CatalogBuildError("invalid_package", `The tarball isn't a gzip stream within ${TARBALL_LIMITS.maxBytes} bytes: ${(error as Error).message}`);
  }
  const files = new Map<string, Uint8Array>();
  let offset = 0;
  let longName: string | null = null;
  let paxPath: string | null = null;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const size = octal(header.subarray(124, 136));
    const type = String.fromCharCode(header[156]!);
    const body = tar.subarray(offset + 512, offset + 512 + size);
    if (body.length !== size) throw new CatalogBuildError("invalid_package", "The tarball ends inside an entry");
    offset += 512 + Math.ceil(size / 512) * 512;

    if (type === "L") {
      longName = cString(body);
      continue;
    }
    if (type === "x") {
      paxPath = paxRecords(body).get("path") ?? null;
      continue;
    }
    if (type === "g") continue;
    const ustarName = cString(header.subarray(0, 100));
    const prefix = header.subarray(257, 263).toString("latin1").startsWith("ustar") ? cString(header.subarray(345, 500)) : "";
    const name = paxPath ?? longName ?? (prefix ? `${prefix}/${ustarName}` : ustarName);
    longName = null;
    paxPath = null;
    if (type !== "0" && type !== "\0") continue;
    const path = packagePath(name);
    if (path === null) continue;
    if (files.size >= TARBALL_LIMITS.maxFiles) throw new CatalogBuildError("invalid_package", `The tarball holds more than ${TARBALL_LIMITS.maxFiles} files`);
    files.set(path, new Uint8Array(body));
  }
  return files;
}

/** Reads a package's tarball: its files and its manifest, which must name +name+ at +version+. */
export function readPackage(name: string, version: string, bytes: Uint8Array): PackageFiles {
  const files = readTarball(bytes);
  const text = files.get("package.json");
  let manifest: unknown;
  try {
    manifest = text ? JSON.parse(decoder.decode(text)) : null;
  } catch {
    manifest = null;
  }
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) throw new CatalogBuildError("invalid_package", `${name}@${version} has no readable package.json`);
  const record = manifest as Record<string, unknown>;
  if (record.name !== name || record.version !== version) throw new CatalogBuildError("invalid_package", `The tarball for ${name}@${version} contains ${String(record.name)}@${String(record.version)}`);
  return { name, version, files, manifest: record };
}

/** A tar entry's path within the package: the leading directory removed, and nothing that could escape it. */
function packagePath(name: string): string | null {
  const segments = name.split("/").filter((segment) => segment !== "" && segment !== ".");
  if (segments.length < 2 || segments.some((segment) => segment === "..") || name.startsWith("/")) return null;
  return segments.slice(1).join("/");
}

function octal(field: Uint8Array): number {
  const text = cString(field).trim();
  const value = text ? Number.parseInt(text, 8) : 0;
  if (!Number.isSafeInteger(value) || value < 0) throw new CatalogBuildError("invalid_package", "The tarball has an entry with an invalid size");
  return value;
}

function cString(field: Uint8Array): string {
  const end = field.indexOf(0);
  return decoder.decode(end === -1 ? field : field.subarray(0, end));
}

/** The records of a pax extended header, such as `path`. Each is `<length> <key>=<value>\n`, its length in bytes. */
function paxRecords(body: Uint8Array): Map<string, string> {
  const records = new Map<string, string>();
  let position = 0;
  while (position < body.length) {
    const space = body.indexOf(0x20, position);
    if (space === -1) break;
    const length = Number.parseInt(decoder.decode(body.subarray(position, space)), 10);
    if (!Number.isSafeInteger(length) || length <= space - position || position + length > body.length) break;
    const record = decoder.decode(body.subarray(space + 1, position + length - 1));
    const equals = record.indexOf("=");
    if (equals > 0) records.set(record.slice(0, equals), record.slice(equals + 1));
    position += length;
  }
  return records;
}
