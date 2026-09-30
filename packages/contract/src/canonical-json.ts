import crypto from "node:crypto";

/**
 * Deterministic JSON for immutable documents.
 *
 * Every value has exactly one serialization: object keys are sorted by UTF-16
 * code unit, there is no insignificant whitespace, and only strings, safe
 * integers, booleans, null, arrays, and objects are allowed. Array order is
 * meaningful; producers sort arrays before serializing.
 *
 * Objects are serialized key by key rather than with JSON.stringify, which
 * would emit integer-like keys ("10", "9") in numeric order first.
 *
 * Parsed documents use null-prototype objects, so keys such as `__proto__`,
 * `constructor`, and `prototype` are ordinary inert data.
 */

export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;
export interface JsonObject {
  [key: string]: JsonValue;
}

export class CanonicalJsonError extends Error {
  override name = "CanonicalJsonError";
}

export const MAX_DEPTH = 64;

/** Serializes a value canonically, rejecting anything outside the allowed types. */
export function dump(value: unknown): string {
  return serialize(value, 0, "$");
}

/** Parses JSON text into null-prototype objects. Does not require canonical input. */
export function parse(text: string): JsonValue {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text, (_key, value: unknown) => (isObject(value) ? toNullPrototype(value) : value));
  } catch (error) {
    throw new CanonicalJsonError(`Invalid JSON: ${(error as Error).message}`);
  }
  dump(parsed); // enforces types and depth
  return parsed as JsonValue;
}

export function isCanonical(text: unknown): text is string {
  if (typeof text !== "string") return false;
  try {
    return dump(parse(text)) === text;
  } catch {
    return false;
  }
}

/** SHA-256 of the UTF-8 bytes of a serialization, as lowercase hex. */
export function sha256(text: string): string {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

/** Canonical serialization and its digest. */
export function digestOf(value: unknown): { text: string; digest: string } {
  const text = dump(value);
  return { text, digest: sha256(text) };
}

/** A deep, null-prototype, frozen copy of a canonical value. */
export function freeze<T extends JsonValue>(value: T): T {
  return deepFreeze(parse(dump(value))) as T;
}

function serialize(value: unknown, depth: number, path: string): string {
  if (depth > MAX_DEPTH) throw new CanonicalJsonError(`${path} exceeds the maximum nesting depth of ${MAX_DEPTH}`);

  switch (typeof value) {
    case "string":
      if (!value.isWellFormed()) throw new CanonicalJsonError(`${path} is not a well-formed Unicode string`);
      return JSON.stringify(value);
    case "number":
      if (!Number.isSafeInteger(value)) throw new CanonicalJsonError(`${path} must be a safe integer (got ${String(value)})`);
      return Object.is(value, -0) ? "0" : String(value);
    case "boolean":
      return value ? "true" : "false";
    case "object": {
      if (value === null) return "null";
      if (Array.isArray(value)) return `[${value.map((item, index) => serialize(item, depth + 1, `${path}[${index}]`)).join(",")}]`;
      if (!isObject(value)) throw new CanonicalJsonError(`${path} must be a plain object`);
      const keys = Object.keys(value).sort();
      const members = keys.map((key) => {
        if (!key.isWellFormed()) throw new CanonicalJsonError(`${path} has a key that is not well-formed Unicode`);
        return `${JSON.stringify(key)}:${serialize((value as Record<string, unknown>)[key], depth + 1, `${path}.${key}`)}`;
      });
      return `{${members.join(",")}}`;
    }
    default:
      throw new CanonicalJsonError(`${path} has unsupported type ${typeof value}`);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function toNullPrototype(value: Record<string, unknown>): Record<string, unknown> {
  const result = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(value)) {
    Object.defineProperty(result, key, { value: value[key], enumerable: true, writable: true, configurable: true });
  }
  return result;
}

function deepFreeze(value: unknown): unknown {
  if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}
