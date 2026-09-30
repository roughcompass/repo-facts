import { describe, expect, it } from "vitest";
import { StructuredParseError, parseJson, parseYaml, pointerLines, pointerOf, valueAt } from "../src/structured.js";

describe("structured data", () => {
  it("keeps hostile keys inert and never resolves inherited properties", () => {
    const json = parseJson('{"__proto__":{"polluted":true},"a":{"b":1}}') as Record<string, unknown>;
    const yaml = parseYaml("constructor:\n  prototype: x\nlist: [1, 2]\n") as Record<string, unknown>;

    expect(Object.getPrototypeOf(json)).toBeNull();
    expect(Object.keys(json)).toEqual(["__proto__", "a"]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(valueAt(json as never, "/constructor")).toBeUndefined();
    expect(valueAt(yaml as never, "/constructor/prototype")).toBe("x");
    expect(valueAt(parseJson("{}"), "/toString")).toBeUndefined();
  });

  it("loads YAML custom tags as plain data and refuses alias bombs and duplicate keys", () => {
    expect(parseYaml('run: !!js/function "function () { return 1 }"\n')).toEqual({ run: "function () { return 1 }" });
    const bomb = "a: &a [x,x,x,x,x,x,x,x,x]\nb: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a]\nc: &c [*b,*b,*b,*b,*b,*b,*b,*b,*b]\nd: [*c,*c,*c,*c,*c,*c,*c,*c,*c]\n";
    expect(() => parseYaml(bomb)).toThrow(StructuredParseError);
    expect(() => parseYaml("a: 1\na: 2\n")).toThrow(StructuredParseError);
    expect(() => parseJson("{bad json")).toThrow(StructuredParseError);
  });

  it("escapes and resolves RFC 6901 pointers", () => {
    const value = parseJson('{"a/b":{"~c":[10,20]}}');

    expect(pointerOf(["a/b", "~c", 1])).toBe("/a~1b/~0c/1");
    expect(valueAt(value, "/a~1b/~0c/1")).toBe(20);
    expect(valueAt(value, "/a~1b/~0c/01")).toBeUndefined();
    expect(valueAt(value, "no-leading-slash")).toBeUndefined();
    expect(pointerLines('{\n  "a": {\n    "b": 1\n  }\n}\n', "/a/b")).toEqual({ start: 3, end: 3 });
  });
});
