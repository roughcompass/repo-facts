import { describe, expect, it } from "vitest";
// @ts-expect-error The helpers are plain ESM scripts without type declarations.
import { registryEnvironment } from "../../scripts/lib/registry.mjs";

// SURVEYOR_NPM_REGISTRY and SURVEYOR_NPM_TOKEN replace REPO_FACTS_NPM_REGISTRY and REPO_FACTS_NPM_TOKEN, which are read, with a warning, for one more release.

const read = (env: Record<string, string>) => {
  const warnings: string[] = [];
  const result = registryEnvironment(env, (message: string) => warnings.push(message)) as { registry?: string; token?: string };
  return { ...result, warnings };
};

describe("registry variables", () => {
  it("reads SURVEYOR_NPM_REGISTRY and SURVEYOR_NPM_TOKEN without a warning", () => {
    expect(read({ SURVEYOR_NPM_REGISTRY: "http://127.0.0.1:4873/", SURVEYOR_NPM_TOKEN: "new" })).toEqual({ registry: "http://127.0.0.1:4873/", token: "new", warnings: [] });
  });

  it("falls back to the deprecated names, with a warning for each", () => {
    expect(read({ REPO_FACTS_NPM_REGISTRY: "http://127.0.0.1:4873/", REPO_FACTS_NPM_TOKEN: "old" })).toEqual({
      registry: "http://127.0.0.1:4873/",
      token: "old",
      warnings: ["REPO_FACTS_NPM_REGISTRY is deprecated and is read for one more release; set SURVEYOR_NPM_REGISTRY instead.", "REPO_FACTS_NPM_TOKEN is deprecated and is read for one more release; set SURVEYOR_NPM_TOKEN instead."],
    });
  });

  it("prefers the new names when both are set", () => {
    expect(read({ SURVEYOR_NPM_REGISTRY: "http://new.example.invalid/", REPO_FACTS_NPM_REGISTRY: "http://old.example.invalid/" })).toEqual({ registry: "http://new.example.invalid/", token: undefined, warnings: [] });
  });
});
