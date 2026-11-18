import { isSensitivePath } from "@repo-facts/contract";

/**
 * Classification of committed paths into the inputs detectors understand.
 * Classification uses only the path; it never reads content.
 *
 * Some inputs are recognized but unsupported by this detector release (for
 * example, CircleCI configuration). They are reported so the categories they
 * could affect stay unknown rather than absent. Build manifests and lockfiles
 * of other ecosystems, such as go.mod or pom.xml, are unsupported inputs that
 * name their ecosystem and the categories they would feed. Sensitive inputs,
 * such as registry credentials and environment files, are recognized from the
 * tree listing; the SnapshotReader never reads them.
 */

export type InputKind = "manifest" | "lockfile" | "workspace" | "ci" | "verification" | "runtime" | "config" | "contract" | "stylesheet" | "template" | "sensitive";

export interface InputRule {
  format: string;
  kind: InputKind;
  label: string;
  supported: boolean;
  matches: (path: string, name: string) => boolean;
  /** The ecosystem of an unsupported build input, such as `Go` or `Maven`. */
  ecosystem?: string;
  /** Categories an unsupported input would feed; they stay unknown unless other inputs establish facts. */
  feeds?: readonly string[];
}

const CODE_EXTENSIONS = ["js", "cjs", "mjs", "ts", "cts", "mts"];
const isNamed = (...names: string[]) => (_path: string, name: string) => names.includes(name);
const isConfig = (stem: string) => (_path: string, name: string) => CODE_EXTENSIONS.some((extension) => name === `${stem}.${extension}`);
const hasExtension = (...extensions: string[]) => (_path: string, name: string) => extensions.some((extension) => name.endsWith(`.${extension}`) && name.length > extension.length + 1);

const hasStylesheetExtension = (extension: string) => (_path: string, name: string) => name.length > extension.length + 1 && name.toLowerCase().endsWith(`.${extension}`);

const rule = (format: string, kind: InputKind, label: string, matches: InputRule["matches"], supported = true): InputRule => ({ format, kind, label, supported, matches });

/** What another ecosystem's build input declares, by the categories it would feed. */
const FEEDS = {
  manifest: ["package_identity", "dependencies", "package_managers", "build_tools", "frameworks", "test_frameworks", "runtime_requirements", "scripts", "workspaces", "packages_produced", "packages_consumed"],
  dependencies: ["dependencies", "package_managers", "build_tools", "frameworks", "test_frameworks", "runtime_requirements", "packages_consumed"],
  lockfile: ["resolved_dependencies", "package_managers"],
  workspace: ["package_identity", "workspaces", "build_tools"],
  wrapper: ["build_tools"],
} as const;

/** An unsupported build input of another ecosystem. */
const foreign = (format: string, ecosystem: string, label: string, kind: keyof typeof FEEDS, matches: InputRule["matches"]): InputRule => ({
  format,
  kind: kind === "lockfile" ? "lockfile" : kind === "workspace" ? "workspace" : "manifest",
  label,
  supported: false,
  matches,
  ecosystem,
  feeds: FEEDS[kind],
});

/** Build manifests, dependency lists, lockfiles, workspaces, and wrappers of ecosystems this release doesn't analyze. */
const FOREIGN_RULES: readonly InputRule[] = [
  foreign("go-mod", "Go", "Go module (go.mod)", "manifest", isNamed("go.mod")),
  foreign("go-sum", "Go", "Go checksums (go.sum)", "lockfile", isNamed("go.sum")),
  foreign("go-work", "Go", "Go workspace (go.work)", "workspace", isNamed("go.work")),
  foreign("cargo-toml", "Rust", "Cargo manifest (Cargo.toml)", "manifest", isNamed("Cargo.toml")),
  foreign("cargo-lock", "Rust", "Cargo lockfile (Cargo.lock)", "lockfile", isNamed("Cargo.lock")),
  foreign("maven-pom", "Maven", "Maven project (pom.xml)", "manifest", isNamed("pom.xml")),
  foreign("maven-wrapper", "Maven", "Maven wrapper", "wrapper", isNamed("mvnw", "mvnw.cmd")),
  foreign("gradle-build", "Gradle", "Gradle build script", "manifest", isNamed("build.gradle", "build.gradle.kts")),
  foreign("gradle-settings", "Gradle", "Gradle settings", "workspace", isNamed("settings.gradle", "settings.gradle.kts")),
  foreign("gradle-wrapper", "Gradle", "Gradle wrapper", "wrapper", isNamed("gradlew", "gradlew.bat")),
  foreign("gradle-catalog", "Gradle", "Gradle version catalog", "dependencies", hasExtension("versions.toml")),
  foreign("gradle-lock", "Gradle", "Gradle lockfile", "lockfile", isNamed("gradle.lockfile")),
  foreign("sbt-build", "sbt", "sbt build definition", "manifest", hasExtension("sbt")),
  foreign("sbt-properties", "sbt", "sbt build properties", "wrapper", (path) => path === "project/build.properties" || path.endsWith("/project/build.properties")),
  foreign("python-project", "Python", "Python project (pyproject.toml)", "manifest", isNamed("pyproject.toml")),
  foreign("python-setup", "Python", "Python setup script or configuration", "manifest", isNamed("setup.py", "setup.cfg")),
  foreign("python-requirements", "Python", "pip requirements file", "dependencies", (path, name) => name.endsWith(".txt") && (name.startsWith("requirements") || path.split("/").at(-2) === "requirements")),
  foreign("pipfile", "Python", "Pipfile", "dependencies", isNamed("Pipfile")),
  foreign("python-lock", "Python", "Python lockfile", "lockfile", isNamed("Pipfile.lock", "poetry.lock", "uv.lock", "pdm.lock")),
  foreign("gemfile", "Ruby", "Gemfile", "dependencies", isNamed("Gemfile", "gems.rb")),
  foreign("gemfile-lock", "Ruby", "Gemfile lockfile", "lockfile", isNamed("Gemfile.lock", "gems.locked")),
  foreign("gemspec", "Ruby", "Ruby gem specification", "manifest", hasExtension("gemspec")),
  foreign("composer-json", "PHP", "Composer manifest (composer.json)", "manifest", isNamed("composer.json")),
  foreign("composer-lock", "PHP", "Composer lockfile (composer.lock)", "lockfile", isNamed("composer.lock")),
  foreign("dotnet-project", ".NET", ".NET project file", "manifest", hasExtension("csproj", "fsproj", "vbproj")),
  foreign("dotnet-solution", ".NET", ".NET solution", "workspace", hasExtension("sln", "slnx")),
  foreign("dotnet-packages", ".NET", ".NET package declarations", "dependencies", isNamed("Directory.Packages.props", "Directory.Build.props", "packages.config")),
  foreign("nuget-lock", ".NET", "NuGet lockfile (packages.lock.json)", "lockfile", isNamed("packages.lock.json")),
  foreign("clojure-deps", "Clojure", "Clojure deps.edn", "manifest", isNamed("deps.edn")),
  foreign("leiningen", "Clojure", "Leiningen project (project.clj)", "manifest", isNamed("project.clj")),
  foreign("shadow-cljs", "ClojureScript", "shadow-cljs configuration", "manifest", isNamed("shadow-cljs.edn")),
  foreign("mix-exs", "Elixir", "Mix project (mix.exs)", "manifest", isNamed("mix.exs")),
  foreign("mix-lock", "Elixir", "Mix lockfile (mix.lock)", "lockfile", isNamed("mix.lock")),
  foreign("pubspec", "Dart", "Dart pubspec (pubspec.yaml)", "manifest", isNamed("pubspec.yaml")),
  foreign("pubspec-lock", "Dart", "Dart pubspec lockfile (pubspec.lock)", "lockfile", isNamed("pubspec.lock")),
  foreign("swift-package", "Swift", "Swift package manifest (Package.swift)", "manifest", isNamed("Package.swift")),
  foreign("swift-resolved", "Swift", "Swift package resolution (Package.resolved)", "lockfile", isNamed("Package.resolved")),
  foreign("podfile", "CocoaPods", "CocoaPods Podfile", "dependencies", isNamed("Podfile")),
  foreign("podfile-lock", "CocoaPods", "CocoaPods lockfile (Podfile.lock)", "lockfile", isNamed("Podfile.lock")),
];

/** Ordered: the first matching rule classifies a path. */
export const INPUT_RULES: readonly InputRule[] = [
  // Never read (the SnapshotReader refuses them): these commonly hold credentials.
  rule("sensitive", "sensitive", "Credential or secret file", (path) => isSensitivePath(path), false),

  rule("package-json", "manifest", "package.json", isNamed("package.json")),

  rule("npm-lock", "lockfile", "npm lockfile", isNamed("package-lock.json", "npm-shrinkwrap.json")),
  rule("pnpm-lock", "lockfile", "pnpm lockfile", isNamed("pnpm-lock.yaml")),
  rule("yarn-lock", "lockfile", "Yarn lockfile", isNamed("yarn.lock")),
  { ...rule("bun-lock", "lockfile", "Bun lockfile", isNamed("bun.lockb", "bun.lock"), false), feeds: ["resolved_dependencies"] },
  { ...rule("deno-lock", "lockfile", "Deno lockfile", isNamed("deno.lock"), false), feeds: ["resolved_dependencies"] },

  rule("pnpm-workspace", "workspace", "pnpm workspace", isNamed("pnpm-workspace.yaml")),
  rule("lerna", "workspace", "Lerna configuration", isNamed("lerna.json")),
  rule("nx", "workspace", "Nx configuration", isNamed("nx.json")),
  rule("turbo", "workspace", "Turborepo configuration", isNamed("turbo.json")),
  { ...rule("rush", "workspace", "Rush configuration", isNamed("rush.json"), false), feeds: ["workspaces"] },

  ...FOREIGN_RULES,

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

  // Stylesheets are read by the detectors that parse them: CSS, SCSS, and Less. Sass's indented syntax isn't parsed.
  rule("css-module", "stylesheet", "CSS module", hasStylesheetExtension("module.css")),
  rule("css", "stylesheet", "CSS stylesheet", hasStylesheetExtension("css")),
  rule("scss-module", "stylesheet", "SCSS module", hasStylesheetExtension("module.scss")),
  rule("scss", "stylesheet", "SCSS stylesheet", hasStylesheetExtension("scss")),
  rule("less-module", "stylesheet", "Less module", hasStylesheetExtension("module.less")),
  rule("less", "stylesheet", "Less stylesheet", hasStylesheetExtension("less")),
  rule("sass", "stylesheet", "Sass stylesheet (indented syntax)", hasStylesheetExtension("sass"), false),

  // Component templates hold elements and styles that only JSX and stylesheets are read for.
  ...(
    [
      ["vue", "Vue single-file component", hasExtension("vue")],
      ["svelte", "Svelte component", hasExtension("svelte")],
      ["astro", "Astro component", hasExtension("astro")],
      ["angular-template", "Angular component template", hasExtension("component.html")],
      ["handlebars", "Handlebars template", hasExtension("hbs", "handlebars")],
      ["twirl", "Play Twirl template", hasExtension("scala.html")],
      ["erb", "ERB template", hasExtension("erb")],
      ["razor", "Razor view", hasExtension("cshtml", "razor")],
    ] as const
  ).map(([format, label, matches]): InputRule => ({ ...rule(format, "template", label, matches, false), feeds: ["ui_elements", "style_values", "accessibility"] })),
];

/**
 * Vendored and generated code is not the repository's own: installed
 * packages, Yarn's committed release and plugins, minified bundles, and Go
 * modules vendored with `go mod vendor`. It is left out of inputs, sources,
 * and languages, the way node_modules is; the fact document's inventory
 * counts still include it, because they describe the tree.
 */

/** Directory names whose contents are vendored third-party code, not the repository's own inputs. */
export const VENDORED_DIRECTORIES = ["node_modules", "bower_components", ".yarn"] as const;

/** File-name endings of minified bundles. */
export const MINIFIED_SUFFIXES = [".min.js", ".min.mjs", ".min.cjs", ".min.css"] as const;

/** Files Yarn Plug'n'Play generates. */
const GENERATED_NAMES = new Set([".pnp.cjs", ".pnp.js", ".pnp.loader.mjs"]);

/** Whether +path+ is vendored or generated code; +vendorDirectories+ are vendor roots found from the tree, such as Go's. */
export function isVendored(path: string, vendorDirectories: readonly string[] = []): boolean {
  const segments = path.split("/");
  if (segments.some((segment) => (VENDORED_DIRECTORIES as readonly string[]).includes(segment))) return true;
  const name = segments[segments.length - 1]!;
  if (GENERATED_NAMES.has(name) || MINIFIED_SUFFIXES.some((suffix) => name.length > suffix.length && name.toLowerCase().endsWith(suffix))) return true;
  return vendorDirectories.some((directory) => path === directory || path.startsWith(`${directory}/`));
}

/**
 * Go vendor directories: a `vendor` directory that holds `modules.txt`, which
 * `go mod vendor` writes, or that sits beside a `go.mod`. Another directory
 * named vendor may hold the repository's own code, so the name alone isn't enough.
 */
export function goVendorDirectories(paths: readonly string[]): string[] {
  const all = new Set(paths);
  const found = new Set<string>();
  for (const path of paths) {
    if (path === "vendor/modules.txt" || path.endsWith("/vendor/modules.txt")) found.add(path.slice(0, -"/modules.txt".length));
    if (path === "go.mod" || path.endsWith("/go.mod")) {
      const directory = `${path.slice(0, -"go.mod".length)}vendor`;
      if (all.has(directory)) found.add(directory);
    }
  }
  return [...found].sort();
}

export function classifyPath(path: string, vendorDirectories: readonly string[] = []): InputRule | null {
  if (isVendored(path, vendorDirectories)) return null;
  const name = path.slice(path.lastIndexOf("/") + 1);
  return INPUT_RULES.find((candidate) => candidate.matches(path, name)) ?? null;
}

export interface Language {
  name: string;
  extensions: readonly string[];
}

/** Languages by file extension, or by file name for files that have none. Vendored paths are not counted. */
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
  { name: "F#", extensions: ["fs", "fsi", "fsx"] },
  { name: "Scala", extensions: ["scala", "sc", "sbt"] },
  { name: "Groovy", extensions: ["groovy", "gradle", "gvy"] },
  { name: "Clojure", extensions: ["clj", "cljc", "edn"] },
  { name: "ClojureScript", extensions: ["cljs"] },
  { name: "Swift", extensions: ["swift"] },
  { name: "Objective-C", extensions: ["m", "mm"] },
  { name: "C", extensions: ["c", "h"] },
  { name: "C++", extensions: ["cpp", "cc", "cxx", "c++", "hpp", "hh", "hxx", "h++"] },
  { name: "Dart", extensions: ["dart"] },
  { name: "Elixir", extensions: ["ex", "exs"] },
  { name: "Erlang", extensions: ["erl", "hrl"] },
  { name: "Haskell", extensions: ["hs", "lhs"] },
  { name: "Elm", extensions: ["elm"] },
  { name: "Perl", extensions: ["pl", "pm"] },
  { name: "Lua", extensions: ["lua"] },
  { name: "R", extensions: ["r"] },
  { name: "SQL", extensions: ["sql"] },
  { name: "CUE", extensions: ["cue"] },
  { name: "Terraform", extensions: ["tf", "tfvars"] },
  { name: "HCL", extensions: ["hcl"] },
  { name: "Protocol Buffers", extensions: ["proto"] },
  { name: "TOML", extensions: ["toml"] },
  { name: "PowerShell", extensions: ["ps1", "psm1"] },
  { name: "Dockerfile", extensions: ["dockerfile"] },
];

/** Languages of files known by name alone. */
const BY_NAME: ReadonlyMap<string, string> = new Map([
  ["Dockerfile", "Dockerfile"],
  ["Containerfile", "Dockerfile"],
  ["Jenkinsfile", "Groovy"],
  ["Gemfile", "Ruby"],
  ["Rakefile", "Ruby"],
  ["Podfile", "Ruby"],
]);

const BY_EXTENSION = new Map(LANGUAGES.flatMap((language) => language.extensions.map((extension) => [extension, language.name] as const)));

export function languageOf(path: string): string | null {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const named = BY_NAME.get(name);
  if (named) return named;
  const dot = name.lastIndexOf(".");
  return dot > 0 ? (BY_EXTENSION.get(name.slice(dot + 1).toLowerCase()) ?? null) : null;
}
