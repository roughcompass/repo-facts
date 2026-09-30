import { describe, expect, it } from "vitest";
import { CanonicalJsonError, MAX_DEPTH, digestOf, dump, freeze, isCanonical, parse, sha256 } from "../src/canonical-json.js";

const shuffle = <T>(values: T[], seed: number): T[] => {
  const copy = [...values];
  let state = seed;
  for (let index = copy.length - 1; index > 0; index--) {
    state = (state * 1103515245 + 12345) % 2 ** 31;
    const other = state % (index + 1);
    [copy[index], copy[other]] = [copy[other]!, copy[index]!];
  }
  return copy;
};

const rebuild = (value: unknown, seed: number): unknown => {
  if (Array.isArray(value)) return value.map((item) => rebuild(item, seed));
  if (value && typeof value === "object") {
    return Object.fromEntries(shuffle(Object.entries(value), seed).map(([key, item]) => [key, rebuild(item, seed + 1)]));
  }
  return value;
};

describe("canonical JSON", () => {
  it("sorts keys by UTF-16 code unit, including integer-like keys", () => {
    expect(dump({ b: 1, a: [3, { z: true, y: null }], "10": "ten", "9": "nine", B: "upper", é: 1 })).toBe(
      '{"10":"ten","9":"nine","B":"upper","a":[3,{"y":null,"z":true}],"b":1,"é":1}',
    );
  });

  it("produces the same text and digest regardless of key insertion order", () => {
    const document = { schema: "x", facts: [{ key: "b", evidence: ["e2", "e1"] }], nested: { c: { d: 1, e: 2 }, a: "x" }, "2": 2, "11": 11 };
    const expected = digestOf(document);

    for (let seed = 1; seed <= 25; seed++) expect(digestOf(rebuild(document, seed))).toEqual(expected);
    expect(expected.digest).toBe(sha256(expected.text));
  });

  it.each([
    ["a fraction", 1.5],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["an unsafe integer", 2 ** 53],
    ["undefined", undefined],
    ["a function", () => 1],
    ["a Date", new Date(0)],
    ["a Map", new Map()],
    ["a class instance", new (class Point {})()],
    ["a bigint", 1n],
    ["a lone surrogate", "\uD800"],
  ])("rejects %s", (_label, value) => {
    expect(() => dump({ value })).toThrow(CanonicalJsonError);
  });

  it("rejects nesting deeper than the limit", () => {
    let deep: unknown = 1;
    for (let depth = 0; depth <= MAX_DEPTH; depth++) deep = [deep];
    expect(() => dump(deep)).toThrow(/nesting depth/);
  });

  it("normalizes negative zero", () => {
    expect(dump({ value: -0 })).toBe('{"value":0}');
  });

  it.each([
    ["whitespace", '{ "a": 1 }'],
    ["unsorted keys", '{"b":1,"a":2}'],
    ["a decimal integer", '{"a":1.0}'],
    ["an exponent", '{"a":1e2}'],
    ["a duplicate key", '{"a":1,"a":2}'],
    ["a fraction", '{"a":0.5}'],
    ["invalid JSON", "{"],
  ])("does not accept %s as canonical", (_label, text) => {
    expect(isCanonical(text)).toBe(false);
  });

  it("parses into null-prototype objects and keeps __proto__ and constructor as inert data", () => {
    const text = '{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},"prototype":1}';
    const parsed = parse(text) as Record<string, unknown>;

    expect(Object.getPrototypeOf(parsed)).toBeNull();
    expect(Object.keys(parsed)).toEqual(["__proto__", "constructor", "prototype"]);
    expect(parsed.__proto__).toEqual({ polluted: true });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty("polluted");
    expect(dump(parsed)).toBe(text);
    expect(isCanonical(text)).toBe(true);
  });

  it("freezes documents deeply", () => {
    const frozen = freeze({ a: { b: [1, { c: 2 }] } }) as { a: { b: [number, { c: number }] } };

    expect(Object.isFrozen(frozen.a.b[1])).toBe(true);
    expect(() => {
      frozen.a.b[1].c = 3;
    }).toThrow(TypeError);
  });
});
