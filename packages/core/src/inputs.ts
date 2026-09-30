import { isSensitivePath } from "@repo-facts/contract";

/**
 * Classification of committed paths into the inputs detectors understand.
 * Classification uses only the path; it never reads content.
 *
 * Some inputs are recognized but unsupported by this detector release (for
 * example, CircleCI configuration). They are reported so the categories they
 * could affect stay unknown rather than absent. Sensitive inputs, such as
 * registry credentials and environment files, are recognized from the tree
 * listing; the SnapshotReader never reads them.
 */

export type InputKind = "manifest" | "lockfile" | "workspace" | "ci" | "verification" | "runtime" | "config" | "contract" | "sensitive";

export interface InputRule {
  format: string;
  kind: InputKind;
  label: string;
  supported: boolean;
  matches: (path: string, name: string) => boolean;
}

const CODE_EXTENSIONS = ["js", "cjs", "mjs", "ts", "cts", "mts"];
const isNamed = (...names: string[]) => (_path: string, name: string) => names.includes(name);
const isConfig = (stem: string) => (_path: string, name: string) => CODE_EXTENSIONS.some((extension) => name === `${stem}.${extension}`);
const hasExtension = (...extensions: string[]) => (_path: string, name: string) => extensions.some((extension) => name.endsWith(`.${extension}`) && name.length > extension.length + 1);

const rule = (format: string, kind: InputKind, label: string, matches: InputRule["matches"], supported = true): InputRule => ({ format, kind, label, supported, matches });

/** Ordered: the first matching rule classifies a path. */
export const INPUT_RULES: readonly InputRule[] = [
  // Never read (the SnapshotReader refuses them): these commonly hold credentials.
  rule("sensitive", "sensitive", "Credential or secret file", (path) => isSensitivePath(path), false),

  rule("package-json", "manifest", "package.json", isNamed("package.json")),

  rule("npm-lock", "lockfile", "npm lockfile", isNamed("package-lock.json", "npm-shrinkwrap.json")),
  rule("pnpm-lock", "lockfile", "pnpm lockfile", isNamed("pnpm-lock.yaml")),
  rule("yarn-lock", "lockfile", "Yarn lockfile", isNamed("yarn.lock")),
  rule("bun-lock", "lockfile", "Bun lockfile", isNamed("bun.lockb", "bun.lock"), false),
  rule("deno-lock", "lockfile", "Deno lockfile", isNamed("deno.lock"), false),

  rule("pnpm-workspace", "workspace", "pnpm workspace", isNamed("pnpm-workspace.yaml")),
  rule("lerna", "workspace", "Lerna configuration", isNamed("lerna.json")),
  rule("nx", "workspace", "Nx configuration", isNamed("nx.json")),
  rule("turbo", "workspace", "Turborepo configuration", isNamed("turbo.json")),
  rule("rush", "workspace", "Rush configuration", isNamed("rush.json"), false),

  rule("github-actions", "ci", "GitHub Actions workflow", (path) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(path)),
  rule("gitlab-ci", "ci", "GitLab CI", (path) => path === ".gitlab-ci.yml"),
  rule("jenkinsfile", "ci", "Jenkinsfile", isNamed("Jenkinsfile")),
  rule("circleci", "ci", "CircleCI configuration", (path) => path === ".circleci/config.yml", false),
  rule("azure-pipelines", "ci", "Azure Pipelines", (path) => path === "azure-pipelines.yml", false),
  rule("travis", "ci", "Travis CI", (path) => path === ".travis.yml", false),
  rule("bitbucket-pipelines", "ci", "Bitbucket Pipelines", (path) => path === "bitbucket-pipelines.yml", false),
  rule("buildkite", "ci", "Buildkite pipeline", (path) => /^\.buildkite\/[^/]+\.ya?ml$/.test(path), false),
  rule("drone", "ci", "Drone CI", (path) => path === ".drone.yml", false),

  rule("makefile", "verification", "Makefile", isNamed("Makefile", "makefile", "GNUmakefile")),
  rule("shell", "verification", "Shell script", hasExtension("sh", "bash")),

  rule("nvmrc", "runtime", ".nvmrc", isNamed(".nvmrc")),
  rule("node-version", "runtime", ".node-version", isNamed(".node-version")),
  rule("tool-versions", "runtime", ".tool-versions", isNamed(".tool-versions")),
  rule("dockerfile", "runtime", "Dockerfile", (_path, name) => name === "Dockerfile" || name.endsWith(".Dockerfile")),

  rule("tsconfig", "config", "TypeScript configuration", (_path, name) => name === "jsconfig.json" || /^tsconfig(\.[\w-]+)?\.json$/.test(name)),
  rule("babel-config", "config", "Babel configuration", (path, name) => isConfig("babel.config")(path, name) || name === ".babelrc" || name === "babel.config.json"),
  rule("eslint-config", "config", "ESLint configuration", (path, name) => isConfig("eslint.config")(path, name) || name.startsWith(".eslintrc")),
  rule("prettier-config", "config", "Prettier configuration", (path, name) => isConfig("prettier.config")(path, name) || name.startsWith(".prettierrc")),
  ...(
    [
      ["vite", "Vite"],
      ["vitest", "Vitest"],
      ["webpack", "webpack"],
      ["rspack", "Rspack"],
      ["rollup", "Rollup"],
      ["tsup", "tsup"],
      ["jest", "Jest"],
      ["playwright", "Playwright"],
      ["cypress", "Cypress"],
      ["next", "Next.js"],
      ["nuxt", "Nuxt"],
      ["svelte", "Svelte"],
      ["astro", "Astro"],
      ["remix", "Remix"],
      ["postcss", "PostCSS"],
      ["tailwind", "Tailwind CSS"],
      ["module-federation", "Module Federation"],
    ] as const
  ).map(([stem, label]) => rule(`${stem}-config`, "config", `${label} configuration`, isConfig(`${stem}.config`))),
  rule("karma-config", "config", "Karma configuration", isNamed("karma.conf.js", "karma.conf.cjs", "karma.conf.ts")),
  rule("angular-config", "config", "Angular workspace", isNamed("angular.json")),
  rule("import-map", "config", "Import map", (_path, name) => name === "importmap.json" || name === "import-map.json" || name.endsWith(".importmap.json")),

  rule("openapi", "contract", "OpenAPI document", (_path, name) => /^(openapi|swagger)(\.[\w-]+)?\.(json|ya?ml)$/.test(name) || /\.(openapi|swagger)\.(json|ya?ml)$/.test(name)),
  rule("graphql-schema", "contract", "GraphQL document", hasExtension("graphql", "gql")),
];

/** Directory names whose contents are vendored third-party code, not the repository's own inputs. */
export const VENDORED_DIRECTORIES = ["node_modules", "bower_components"] as const;

export function isVendored(path: string): boolean {
  return path.split("/").some((segment) => (VENDORED_DIRECTORIES as readonly string[]).includes(segment));
}

export function classifyPath(path: string): InputRule | null {
  if (isVendored(path)) return null;
  const name = path.slice(path.lastIndexOf("/") + 1);
  return INPUT_RULES.find((candidate) => candidate.matches(path, name)) ?? null;
}

export interface Language {
  name: string;
  extensions: readonly string[];
}

/** Languages by file extension. Vendored paths are not counted. */
export const LANGUAGES: readonly Language[] = [
  { name: "TypeScript", extensions: ["ts", "tsx", "mts", "cts"] },
  { name: "JavaScript", extensions: ["js", "jsx", "mjs", "cjs"] },
  { name: "CSS", extensions: ["css"] },
  { name: "Sass", extensions: ["scss", "sass"] },
  { name: "Less", extensions: ["less"] },
  { name: "HTML", extensions: ["html", "htm"] },
  { name: "Vue", extensions: ["vue"] },
  { name: "Svelte", extensions: ["svelte"] },
  { name: "Astro", extensions: ["astro"] },
  { name: "GraphQL", extensions: ["graphql", "gql"] },
  { name: "JSON", extensions: ["json", "jsonc"] },
  { name: "YAML", extensions: ["yml", "yaml"] },
  { name: "Markdown", extensions: ["md", "mdx"] },
  { name: "Shell", extensions: ["sh", "bash"] },
  { name: "Python", extensions: ["py"] },
  { name: "Ruby", extensions: ["rb"] },
  { name: "Go", extensions: ["go"] },
  { name: "Java", extensions: ["java"] },
  { name: "Kotlin", extensions: ["kt", "kts"] },
  { name: "Rust", extensions: ["rs"] },
  { name: "PHP", extensions: ["php"] },
  { name: "C#", extensions: ["cs"] },
];

const BY_EXTENSION = new Map(LANGUAGES.flatMap((language) => language.extensions.map((extension) => [extension, language.name] as const)));

export function languageOf(path: string): string | null {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? (BY_EXTENSION.get(name.slice(dot + 1).toLowerCase()) ?? null) : null;
}
