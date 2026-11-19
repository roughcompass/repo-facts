import crypto from "node:crypto";
import semver from "semver";
import { CatalogBuildError } from "./errors.js";
import { type PackageFiles, readPackage } from "./tarball.js";

/**
 * Reading packages from an npm registry: a package's metadata, and its
 * tarball at an exact version, checked against the integrity the registry
 * records. Only the Catalog Builder downloads; surveys never do.
 */

/** The public npm registry, the default. CIB points the builder at its internal mirror. */
export const DEFAULT_REGISTRY = "https://registry.npmjs.org/";

export interface RegistryOptions {
  /** The registry's base address. Defaults to the public npm registry. */
  registry?: string;
  /** The fetch to use; tests pass one that serves fixtures. Defaults to the global fetch. */
  fetch?: typeof fetch;
  /** How long one request may take. Defaults to 60 seconds. */
  timeoutMs?: number;
}

/** What a registry records about one version of a package. */
export interface PublishedVersion {
  version: string;
  /** When it was published, as the registry records it, or null. */
  time: string | null;
  tarball: string;
  integrity: string | null;
  shasum: string | null;
  dependencies: Record<string, string>;
  peerDependencies: Record<string, string>;
}

export interface Packument {
  name: string;
  versions: ReadonlyMap<string, PublishedVersion>;
  distTags: Readonly<Record<string, string>>;
}

const MAX_METADATA_BYTES = 64 * 1024 * 1024;

/** A package's registry metadata. */
export async function fetchPackument(name: string, options: RegistryOptions = {}): Promise<Packument> {
  const url = new URL(name.replace("/", "%2f"), registryOf(options));
  const response = await request(url, options, "application/json");
  const text = await boundedText(response, MAX_METADATA_BYTES, `${name}'s metadata`);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new CatalogBuildError("invalid_package", `The registry's metadata for ${name} isn't JSON`);
  }
  const record = isRecord(body) ? body : {};
  const versions = isRecord(record.versions) ? record.versions : {};
  const times = isRecord(record.time) ? record.time : {};
  const published = new Map<string, PublishedVersion>();
  for (const [version, value] of Object.entries(versions)) {
    if (!semver.valid(version) || !isRecord(value) || !isRecord(value.dist) || typeof value.dist.tarball !== "string") continue;
    published.set(version, {
      version,
      time: typeof times[version] === "string" ? (times[version] as string) : null,
      tarball: value.dist.tarball,
      integrity: typeof value.dist.integrity === "string" ? value.dist.integrity : null,
      shasum: typeof value.dist.shasum === "string" ? value.dist.shasum : null,
      dependencies: strings(value.dependencies),
      peerDependencies: strings(value.peerDependencies),
    });
  }
  return { name, versions: published, distTags: strings(record["dist-tags"]) };
}

/** A package's tarball at exactly +version+, verified against the registry's integrity, and read as data. */
export async function fetchPackage(packument: Packument, version: string, options: RegistryOptions = {}): Promise<PackageFiles> {
  const published = packument.versions.get(version);
  if (!published) throw new CatalogBuildError("not_found", `${packument.name}@${version} isn't published on ${registryOf(options)}`);
  const url = new URL(published.tarball, registryOf(options));
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new CatalogBuildError("invalid_package", `${packument.name}@${version}'s tarball isn't on an HTTP address`);
  const response = await request(url, options, "application/octet-stream");
  const bytes = await boundedBytes(response, 64 * 1024 * 1024, `${packument.name}@${version}`);
  verifyIntegrity(packument.name, version, bytes, published);
  return readPackage(packument.name, version, bytes);
}

/** Checks +bytes+ against the SHA-512 integrity the registry records, or its SHA-1 shasum when it records only that. */
export function verifyIntegrity(name: string, version: string, bytes: Uint8Array, published: Pick<PublishedVersion, "integrity" | "shasum">): void {
  const sha512 = published.integrity?.split(/\s+/).find((item) => item.startsWith("sha512-"));
  if (sha512) {
    if (`sha512-${crypto.createHash("sha512").update(bytes).digest("base64")}` !== sha512) throw new CatalogBuildError("integrity_mismatch", `${name}@${version}'s tarball doesn't match the integrity the registry records`);
    return;
  }
  if (published.shasum) {
    if (crypto.createHash("sha1").update(bytes).digest("hex") !== published.shasum) throw new CatalogBuildError("integrity_mismatch", `${name}@${version}'s tarball doesn't match the shasum the registry records`);
    return;
  }
  throw new CatalogBuildError("integrity_mismatch", `The registry records no integrity for ${name}@${version}`);
}

function registryOf(options: RegistryOptions): string {
  const registry = options.registry ?? DEFAULT_REGISTRY;
  return registry.endsWith("/") ? registry : `${registry}/`;
}

async function request(url: URL, options: RegistryOptions, accept: string): Promise<Response> {
  const fetcher = options.fetch ?? fetch;
  let response: Response;
  try {
    response = await fetcher(url, { headers: { accept }, redirect: "follow", signal: AbortSignal.timeout(options.timeoutMs ?? 60_000) });
  } catch (error) {
    throw new CatalogBuildError("registry_unreachable", `Couldn't reach ${url.origin}: ${(error as Error).message}`);
  }
  if (response.status === 404) throw new CatalogBuildError("not_found", `${url.href} isn't on the registry`);
  if (!response.ok) throw new CatalogBuildError("registry_unreachable", `${url.origin} answered ${response.status} for ${url.pathname}`);
  return response;
}

async function boundedBytes(response: Response, limit: number, label: string): Promise<Uint8Array> {
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > limit) throw new CatalogBuildError("invalid_package", `${label} is larger than ${limit} bytes`);
  return bytes;
}

async function boundedText(response: Response, limit: number, label: string): Promise<string> {
  return new TextDecoder().decode(await boundedBytes(response, limit, label));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function strings(value: unknown): Record<string, string> {
  return isRecord(value) ? Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string")) : {};
}
