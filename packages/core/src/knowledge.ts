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
  /** The packages that declare the framework, in order of preference; the first a manifest declares is reported. */
  packages: readonly string[];
  /** A hybrid mobile framework, which builds native mobile applications. */
  mobile: boolean;
}

const framework = (id: string, label: string, packages: string[], mobile = false): Framework => ({ id, label, packages, mobile });

export const FRAMEWORKS: readonly Framework[] = [
  framework("react", "React", ["react"]),
  framework("next", "Next.js", ["next"]),
  framework("remix", "Remix", ["@remix-run/react"]),
  framework("gatsby", "Gatsby", ["gatsby"]),
  framework("preact", "Preact", ["preact"]),
  framework("vue", "Vue", ["vue"]),
  framework("nuxt", "Nuxt", ["nuxt"]),
  framework("angular", "Angular", ["@angular/core"]),
  framework("svelte", "Svelte", ["svelte"]),
  framework("sveltekit", "SvelteKit", ["@sveltejs/kit"]),
  framework("solid", "Solid", ["solid-js"]),
  framework("lit", "Lit", ["lit"]),
  framework("astro", "Astro", ["astro"]),
  framework("ember", "Ember", ["ember-source"]),
  framework("express", "Express", ["express"]),
  framework("fastify", "Fastify", ["fastify"]),
  framework("koa", "Koa", ["koa"]),
  framework("hono", "Hono", ["hono"]),
  framework("nestjs", "NestJS", ["@nestjs/core"]),
  framework("react-native", "React Native", ["react-native"], true),
  framework("expo", "Expo", ["expo"], true),
  framework("capacitor", "Capacitor", ["@capacitor/core"], true),
  framework("ionic", "Ionic", ["@ionic/react", "@ionic/angular", "@ionic/vue", "@ionic/core"], true),
  framework("cordova", "Cordova", ["cordova", "cordova-android", "cordova-ios"], true),
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
