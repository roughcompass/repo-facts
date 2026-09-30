import YAML, { isMap, isPair, isScalar, isSeq, type Node as YamlNode } from "yaml";

/**
 * Safe parsing of committed JSON and YAML, and RFC 6901 pointers into it.
 *
 * Parsed values use null-prototype objects, so a document key such as
 * `constructor` or `__proto__` is inert data and a missing key never resolves
 * to an inherited function. YAML is loaded with the core schema only: custom
 * tags resolve to plain strings, merge keys are off, and alias expansion is
 * bounded. Nothing in a document is ever evaluated.
 */

export type Value = null | boolean | number | string | Value[] | { [key: string]: Value };

export class StructuredParseError extends Error {
  override name = "StructuredParseError";
}

export type Format = "json" | "yaml";

const MAX_DEPTH = 100;
const YAML_OPTIONS = { schema: "core", merge: false, maxAliasCount: 100, uniqueKeys: true, strict: true, prettyErrors: false } as const;

export function parseJson(text: string): Value {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new StructuredParseError(`Invalid JSON: ${(error as Error).message}`);
  }
  return normalize(parsed, 0);
}

/** Parses the first YAML document. */
export function parseYaml(text: string): Value {
  return parseYamlAll(text)[0] ?? null;
}

export function parseYamlAll(text: string): Value[] {
  const documents = YAML.parseAllDocuments(text, YAML_OPTIONS);
  const list = Array.isArray(documents) ? documents : [documents];
  return list.map((document) => {
    if (document.errors.length) throw new StructuredParseError(`Invalid YAML: ${document.errors[0]!.message.split("\n")[0]}`);
    try {
      return normalize(document.toJS({ maxAliasCount: YAML_OPTIONS.maxAliasCount }), 0);
    } catch (error) {
      throw new StructuredParseError(`Invalid YAML: ${(error as Error).message}`);
    }
  });
}

export function parse(text: string, format: Format): Value {
  return format === "json" ? parseJson(text) : parseYaml(text);
}

/** Builds an RFC 6901 pointer from path segments. */
export function pointerOf(segments: readonly (string | number)[]): string {
  return segments.map((segment) => `/${String(segment).replaceAll("~", "~0").replaceAll("/", "~1")}`).join("");
}

export function pointerSegments(pointer: string): string[] | null {
  if (pointer === "") return [];
  if (!pointer.startsWith("/")) return null;
  return pointer
    .slice(1)
    .split("/")
    .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"));
}

/** The value at +pointer+, or undefined when it does not exist. */
export function valueAt(value: Value, pointer: string): Value | undefined {
  const segments = pointerSegments(pointer);
  if (!segments) return undefined;
  let current: Value | undefined = value;
  for (const segment of segments) {
    if (Array.isArray(current)) {
      if (!/^(0|[1-9]\d*)$/.test(segment)) return undefined;
      current = current[Number(segment)];
    } else if (current !== null && typeof current === "object") {
      current = Object.hasOwn(current, segment) ? current[segment] : undefined;
    } else {
      return undefined;
    }
    if (current === undefined) return undefined;
  }
  return current;
}

/** A deterministic serialization with sorted keys, used for excerpt digests. */
export function stableStringify(value: Value): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key]!)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** The 1-based line range of the node a pointer names, for showing an excerpt. */
export function pointerLines(text: string, pointer: string): { start: number; end: number } | null {
  const segments = pointerSegments(pointer);
  if (!segments) return null;
  const document = YAML.parseDocument(text, YAML_OPTIONS);
  if (document.errors.length) return null;

  let node: unknown = document.contents;
  let range: [number, number] | null = node && (node as YamlNode).range ? [(node as YamlNode).range![0], (node as YamlNode).range![1]] : null;
  for (const segment of segments) {
    if (isMap(node)) {
      const pair = node.items.find((item) => isPair(item) && isScalar(item.key) && String(item.key.value) === segment);
      if (!pair) return null;
      const keyStart = isScalar(pair.key) && pair.key.range ? pair.key.range[0] : null;
      node = pair.value;
      const valueRange = (node as YamlNode | null)?.range;
      if (keyStart === null || !valueRange) return null;
      range = [keyStart, valueRange[1]];
    } else if (isSeq(node)) {
      node = /^(0|[1-9]\d*)$/.test(segment) ? node.items[Number(segment)] : undefined;
      const itemRange = (node as YamlNode | undefined)?.range;
      if (!itemRange) return null;
      range = [itemRange[0], itemRange[1]];
    } else {
      return null;
    }
  }
  if (!range) return null;
  return { start: lineOf(text, range[0]), end: lineOf(text, Math.max(range[0], range[1] - 1)) };
}

function lineOf(text: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset && index < text.length; index++) if (text.charCodeAt(index) === 10) line++;
  return line;
}

function normalize(value: unknown, depth: number): Value {
  if (depth > MAX_DEPTH) throw new StructuredParseError(`The document nests deeper than ${MAX_DEPTH} levels`);
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((item) => normalize(item, depth + 1));
  if (value instanceof Map) {
    const result = Object.create(null) as Record<string, Value>;
    for (const [key, item] of value) defineKey(result, String(key), normalize(item, depth + 1));
    return result;
  }
  if (typeof value === "object") {
    const result = Object.create(null) as Record<string, Value>;
    for (const key of Object.keys(value)) defineKey(result, key, normalize((value as Record<string, unknown>)[key], depth + 1));
    return result;
  }
  return String(value);
}

function defineKey(target: Record<string, Value>, key: string, value: Value): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}
