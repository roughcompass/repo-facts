import path from "node:path";
import { defineConfig } from "vitest/config";

const packages = path.resolve(import.meta.dirname, "packages");

// Tests import sibling packages from source, so no build is needed first.
const alias = [
  { find: /^@repo-facts\/([a-z-]+)$/, replacement: `${packages}/$1/src/index.ts` },
  { find: /^@repo-facts\/([a-z-]+)\/(.+)$/, replacement: `${packages}/$1/src/$2/index.ts` },
];

export default defineConfig({
  resolve: { alias },
  test: {
    pool: "forks",
    projects: [
      { extends: true, test: { name: "unit", include: ["packages/*/test/**/*.test.ts", "test/lint/**/*.test.ts", "test/docs/**/*.test.ts", "test/golden/**/*.test.ts", "test/rules/**/*.test.ts", "test/hostile/**/*.test.ts"] } },
      // Integration tests start a registry and run npm.
      { extends: true, test: { name: "integration", include: ["test/registry/**/*.test.ts"], testTimeout: 300_000, hookTimeout: 300_000 } },
      // The release test clones and installs a full checkout whose gates run `verify`, so it stays out of `verify`.
      { extends: true, test: { name: "release", include: ["test/release/**/*.test.ts"], testTimeout: 900_000, hookTimeout: 900_000 } },
    ],
  },
});
