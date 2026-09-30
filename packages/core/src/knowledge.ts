/**
 * What package names and configuration files declare, for this detector
 * release. A tool is reported only when a manifest declares one of its
 * packages or the repository commits one of its configuration files.
 */

export interface Tool {
  id: string;
  label: string;
  packages: readonly string[];
  /** Inventory formats of configuration files that declare the tool. */
  configs: readonly string[];
}

const tool = (id: string, label: string, packages: string[], configs: string[] = []): Tool => ({ id, label, packages, configs });

export const BUILD_TOOLS: readonly Tool[] = [
  tool("vite", "Vite", ["vite"], ["vite-config"]),
  tool("webpack", "webpack", ["webpack", "webpack-cli"], ["webpack-config"]),
  tool("rspack", "Rspack", ["@rspack/core", "@rspack/cli"], ["rspack-config"]),
  tool("rsbuild", "Rsbuild", ["@rsbuild/core"]),
  tool("rollup", "Rollup", ["rollup"], ["rollup-config"]),
  tool("esbuild", "esbuild", ["esbuild"]),
  tool("tsup", "tsup", ["tsup"], ["tsup-config"]),
  tool("parcel", "Parcel", ["parcel"]),
  tool("babel", "Babel", ["@babel/core"], ["babel-config"]),
  tool("swc", "SWC", ["@swc/core", "@swc/cli"]),
  tool("typescript", "TypeScript compiler", ["typescript"], ["tsconfig"]),
  tool("turborepo", "Turborepo", ["turbo"], ["turbo"]),
  tool("nx", "Nx", ["nx"], ["nx"]),
  tool("lerna", "Lerna", ["lerna"], ["lerna"]),
];

export const TEST_FRAMEWORKS: readonly Tool[] = [
  tool("jest", "Jest", ["jest"], ["jest-config"]),
  tool("vitest", "Vitest", ["vitest"], ["vitest-config"]),
  tool("mocha", "Mocha", ["mocha"]),
  tool("jasmine", "Jasmine", ["jasmine", "jasmine-core"]),
  tool("karma", "Karma", ["karma"], ["karma-config"]),
  tool("ava", "AVA", ["ava"]),
  tool("tap", "node-tap", ["tap"]),
  tool("uvu", "uvu", ["uvu"]),
  tool("playwright", "Playwright Test", ["@playwright/test"], ["playwright-config"]),
  tool("cypress", "Cypress", ["cypress"], ["cypress-config"]),
  tool("web-test-runner", "Web Test Runner", ["@web/test-runner"]),
  tool("testcafe", "TestCafe", ["testcafe"]),
  tool("webdriverio", "WebdriverIO", ["@wdio/cli"]),
];

export interface Framework {
  id: string;
  label: string;
  package: string;
}

export const FRAMEWORKS: readonly Framework[] = [
  { id: "react", label: "React", package: "react" },
  { id: "next", label: "Next.js", package: "next" },
  { id: "remix", label: "Remix", package: "@remix-run/react" },
  { id: "gatsby", label: "Gatsby", package: "gatsby" },
  { id: "preact", label: "Preact", package: "preact" },
  { id: "vue", label: "Vue", package: "vue" },
  { id: "nuxt", label: "Nuxt", package: "nuxt" },
  { id: "angular", label: "Angular", package: "@angular/core" },
  { id: "svelte", label: "Svelte", package: "svelte" },
  { id: "sveltekit", label: "SvelteKit", package: "@sveltejs/kit" },
  { id: "solid", label: "Solid", package: "solid-js" },
  { id: "lit", label: "Lit", package: "lit" },
  { id: "astro", label: "Astro", package: "astro" },
  { id: "ember", label: "Ember", package: "ember-source" },
  { id: "express", label: "Express", package: "express" },
  { id: "fastify", label: "Fastify", package: "fastify" },
  { id: "koa", label: "Koa", package: "koa" },
  { id: "hono", label: "Hono", package: "hono" },
  { id: "nestjs", label: "NestJS", package: "@nestjs/core" },
];

/** Manifest dependency fields, in the order they are reported. */
export const DEPENDENCY_FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const;
export type DependencyField = (typeof DEPENDENCY_FIELDS)[number];

/** Runtimes whose declared versions are reported as runtime requirements. */
export const RUNTIMES = ["node", "npm", "pnpm", "yarn", "bun", "deno"] as const;
export type Runtime = (typeof RUNTIMES)[number];

/** Package managers implied by the lockfile each writes. */
export const LOCKFILE_MANAGERS: Readonly<Record<string, string>> = {
  "npm-lock": "npm",
  "pnpm-lock": "pnpm",
  "yarn-lock": "yarn",
  "bun-lock": "bun",
  "deno-lock": "deno",
};
