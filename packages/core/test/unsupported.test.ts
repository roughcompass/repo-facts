import { LOCKFILE_NAMES } from "@repo-facts/contract";
import { describe, expect, it } from "vitest";
import { UNSUPPORTED_INPUTS_RULE, classifyPath } from "../src/index.js";
import { profile } from "./support.js";

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

describe("other ecosystems' build inputs", () => {
  it.each([
    ["go.mod", "Go", "manifest"],
    ["go.sum", "Go", "lockfile"],
    ["Cargo.toml", "Rust", "manifest"],
    ["crates/esi/Cargo.lock", "Rust", "lockfile"],
    ["pom.xml", "Maven", "manifest"],
    ["build.gradle.kts", "Gradle", "manifest"],
    ["settings.gradle", "Gradle", "workspace"],
    ["gradlew", "Gradle", "manifest"],
    ["build.sbt", "sbt", "manifest"],
    ["project/plugins.sbt", "sbt", "manifest"],
    ["pyproject.toml", "Python", "manifest"],
    ["setup.cfg", "Python", "manifest"],
    ["docs/requirements-dev.txt", "Python", "manifest"],
    ["requirements/base.txt", "Python", "manifest"],
    ["Pipfile", "Python", "manifest"],
    ["poetry.lock", "Python", "lockfile"],
    ["Gemfile", "Ruby", "manifest"],
    ["Gemfile.lock", "Ruby", "lockfile"],
    ["rbhive.gemspec", "Ruby", "manifest"],
    ["composer.json", "PHP", "manifest"],
    ["composer.lock", "PHP", "lockfile"],
    ["src/Web/Web.csproj", ".NET", "manifest"],
    ["App.fsproj", ".NET", "manifest"],
    ["Umbraco.sln", ".NET", "workspace"],
    ["Directory.Packages.props", ".NET", "manifest"],
    ["deps.edn", "Clojure", "manifest"],
    ["project.clj", "Clojure", "manifest"],
    ["shadow-cljs.edn", "ClojureScript", "manifest"],
    ["mix.exs", "Elixir", "manifest"],
    ["pubspec.yaml", "Dart", "manifest"],
    ["Package.swift", "Swift", "manifest"],
  ])("classifies %s as an unsupported %s input", (path, ecosystem, kind) => {
    expect(classifyPath(path)).toMatchObject({ ecosystem, kind, supported: false });
  });

  it("leaves a Scala application's categories unknown instead of absent, naming the ecosystem", async () => {
    const { document } = await profile({
      "build.sbt": 'lazy val root = (project in file(".")).enablePlugins(PlayScala)\n',
      "project/plugins.sbt": 'addSbtPlugin("org.playframework" % "sbt-plugin" % "3.0.5")\n',
      "app/controllers/HomeController.scala": "package controllers\n",
    });
    for (const category of ["package_identity", "dependencies", "package_managers", "build_tools", "frameworks", "test_frameworks", "runtime_requirements", "scripts", "workspaces"]) {
      expect(document.categories[category], category).toMatchObject({ state: "unknown", facts: [], search: { complete: true, skipped: ["build.sbt", "project/plugins.sbt"] } });
      expect(document.categories[category]!.search.rules, category).toContain(UNSUPPORTED_INPUTS_RULE);
    }
    expect(document.diagnostics).toContainEqual({ path: "build.sbt", reason: "unsupported_input", detail: "sbt build definition is recognized but not analyzed: this detector release doesn't support the sbt ecosystem", detector: "inventory" });
    expect(document.categories.languages!.facts.map((fact) => fact.key)).toEqual(["Scala"]);
  });

  it("puts a lockfile on the resolved_dependencies surface only, and keeps facts other inputs establish", async () => {
    const { document } = await profile({
      "package.json": json({ name: "docs-site", dependencies: { react: "^19.0.0" } }),
      "docs/requirements.txt": "mkdocs==1.6.1\n",
      "Cargo.lock": "version = 4\n",
    });
    expect(document.categories.dependencies).toMatchObject({ state: "observed", search: { complete: true, skipped: ["docs/requirements.txt"] } });
    expect(document.categories.frameworks).toMatchObject({ state: "observed" });
    expect(document.categories.test_frameworks).toMatchObject({ state: "unknown", search: { skipped: ["docs/requirements.txt"] } });
    expect(document.categories.resolved_dependencies!.search.skipped).toEqual(["Cargo.lock"]);
    expect(document.categories.package_identity).toMatchObject({ state: "observed", search: { skipped: [] } });
  });

  it("leaves a JavaScript repository without other ecosystems' inputs as it was", async () => {
    const { document } = await profile({ "package.json": json({ name: "app", dependencies: { react: "^19.0.0" } }) });
    expect(document.categories.test_frameworks).toMatchObject({ state: "absent" });
    expect(document.categories.dependencies!.search.rules).not.toContain(UNSUPPORTED_INPUTS_RULE);
  });
});

describe("component templates", () => {
  it.each([
    ["app/components/order-list.hbs", "handlebars"],
    ["app/views/HomeView.scala.html", "twirl"],
    ["app/views/orders/index.html.erb", "erb"],
    ["Views/Home/Index.cshtml", "razor"],
    ["Components/Counter.razor", "razor"],
  ])("classifies %s as an unsupported %s template", (path, format) => {
    expect(classifyPath(path)).toMatchObject({ kind: "template", format, supported: false, feeds: ["ui_elements", "style_values"] });
  });

  it("keeps ui_elements and style_values unknown when Vue, Svelte, Astro, or Angular templates hold the elements", async () => {
    const { document } = await profile({
      "package.json": json({ name: "app", dependencies: { vue: "^3.5.0" } }),
      "src/App.vue": "<template><button>Go</button></template>\n",
      "src/Nav.svelte": "<nav></nav>\n",
      "src/pages/index.astro": "<main></main>\n",
      "src/app/orders.component.html": "<table></table>\n",
      "public/index.html": "<!doctype html>\n",
    });
    for (const category of ["ui_elements", "style_values"]) {
      expect(document.categories[category], category).toMatchObject({ state: "unknown", search: { skipped: ["src/App.vue", "src/Nav.svelte", "src/app/orders.component.html", "src/pages/index.astro"] } });
    }
    // Skipped for the UI categories only, so no diagnostic marks them skipped everywhere.
    expect(document.diagnostics.filter((diagnostic) => diagnostic.path.startsWith("src/"))).toEqual([]);
  });
});

describe("lockfile names", () => {
  it("classifies every name the read policy budgets as a lockfile as a lockfile input", () => {
    for (const name of LOCKFILE_NAMES) expect(classifyPath(`nested/${name}`)?.kind, name).toBe("lockfile");
  });
});
