import { describe, expect, it } from "vitest";
import { type CatalogSource, compileAdapters } from "../src/index.js";

// Styling adapters are data compiled into the release (detector-catalog spec: syntax patterns are declarative, versioned rules).
// Design systems are Reference Catalog entries now; @repo-facts/contract validates those.

const ADAPTERS = `
format: 1
version: 1.0.0
adapters:
  - module: styled-components
    exports: [{ name: styled, role: styled_factory }, { name: default, role: styled_factory }, { name: css, role: style_factory }]
  - module: clsx
    exports: [{ name: default, role: class_composer }]
ui_libraries: [antd, "@mui/material"]
`;

const source = (text: string, path = "libraries.yaml"): CatalogSource => ({ path, text });
const problems = (adapters = ADAPTERS) => {
  const result = compileAdapters(source(adapters));
  return result.ok ? [] : result.problems;
};

describe("adapter compilation", () => {
  it("compiles to sorted, canonical data with a digest", () => {
    const result = compileAdapters(source(ADAPTERS));
    if (!result.ok) throw new Error(result.problems.join("\n"));
    expect(result.adapters.adapters.map((adapter) => [adapter.module, adapter.exports.map((entry) => entry.name)])).toEqual([
      ["clsx", ["default"]],
      ["styled-components", ["css", "default", "styled"]],
    ]);
    expect(result.adapters.ui_libraries).toEqual(["@mui/material", "antd"]);
    expect(result.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic: list order and key order do not change the output", () => {
    const reordered = ADAPTERS.replace("ui_libraries: [antd, \"@mui/material\"]", "ui_libraries: [\"@mui/material\", antd]").replace("format: 1\nversion: 1.0.0", "version: 1.0.0\nformat: 1");
    const first = compileAdapters(source(ADAPTERS));
    const second = compileAdapters(source(reordered));
    expect(second).toEqual(first);
    if (!first.ok) throw new Error("expected the adapters to compile");
    expect(compileAdapters(source(ADAPTERS.replace("antd", "primereact")))).not.toMatchObject({ digest: first.digest });
  });

  it.each([
    ["an unknown adapter field", ADAPTERS.replace("role: class_composer }", "role: class_composer, call: true }"), "Unrecognized key"],
    ["an unknown adapter role", ADAPTERS.replace("role: class_composer", "role: evaluator"), "role"],
    ["an executable-looking module", ADAPTERS.replace("module: clsx", 'module: "javascript:alert(1)"'), "must be a package name or package subpath"],
    ["an executable-looking export", ADAPTERS.replace("name: default, role: class_composer", "name: \"x(){}\", role: class_composer"), "must be a plain export name"],
  ])("rejects %s", (_name, adapters, message) => {
    expect(problems(adapters)).toContainEqual(expect.stringContaining(message));
  });

  it("rejects duplicate adapters, exports, and UI libraries", () => {
    const adapters = ADAPTERS.replace("  - module: clsx", "  - module: clsx\n    exports: [{ name: default, role: class_composer }, { name: default, role: class_composer }]\n  - module: clsx").replace("ui_libraries: [antd,", "ui_libraries: [antd, antd,");
    expect(problems(adapters)).toEqual(expect.arrayContaining([expect.stringContaining("module clsx is listed more than once"), expect.stringContaining("export default of clsx is listed more than once"), expect.stringContaining("UI library antd is listed more than once")]));
  });

  it("reports malformed YAML with its path", () => {
    expect(problems("format: [1")).toContainEqual(expect.stringMatching(/^libraries\.yaml: Invalid YAML/));
  });
});
