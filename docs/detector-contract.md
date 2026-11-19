# Detector Contract

This contract governs how Surveyor's detectors turn one snapshot or working tree into a fact document. It is version 1 of the detector contract and version 3 of the fact document schema, `repo_facts.fact_document`. Surveyor is published as the `@repo-facts/*` packages, and the Frontend Registry consumes it. The types live in [`packages/contract/src/detectors/contract.ts`](../packages/contract/src/detectors/contract.ts), and the schema lives in [`packages/contract/src/facts/schema.ts`](../packages/contract/src/facts/schema.ts). Detectors read content only through a reader; see [source-reader.md](source-reader.md).

## What a detector is

A detector is trusted, reviewed code that ships in a Surveyor release, the `@repo-facts/bundle` version. An analyzed repository can't add, configure, or replace one. Each detector declares:

| Field | Meaning |
| --- | --- |
| `id` | Stable identifier, recorded on every evidence record the detector creates |
| `version` | Changes whenever the detector's output could change |
| `stage` | The stage it runs in (see below) |
| `inputs` | The path patterns it reads, such as `**/package.json` |
| `categories` | The categories it searches |
| `run(context)` | Reads the tree and reports candidates |

Patterns use a closed syntax: an exact path, `**/name` for that file name at any depth, `dir/*` for direct children, and `**/*.ext` for an extension at any depth. Patterns are matched structurally and are never compiled into regular expressions.

## Stages

`runDetectors` ([`packages/contract/src/detectors/run.ts`](../packages/contract/src/detectors/run.ts)) runs the stages in order. Detectors within a stage run in bundle order.

1. `inventory`: manifests, lockfiles, CI files, runtime declarations, configuration names, and language distribution
2. `parse`: JSON, YAML, lockfiles, and parse-only JavaScript and TypeScript syntax trees and stylesheets
3. `convention`: package manager, build and test tools, CI system, verification commands, runtime requirements, frameworks, and resolved dependencies
4. `architecture`: package production and consumption, composition, iframes, runtime contracts, and then design-system recognition and usage
5. `services`: Service Dependencies, plus access and testability signals

Service Dependencies run as their own stage so that service detectors can use architecture results. Reconciliation follows the last stage.

Cancellation is checked before every stage. A caller can also pass a `checkpoint` that throws `DetectorRunCanceled` to stop the run.

A later stage reads earlier results from `context.shared`, keyed by the producing detector or layer. Shared values are in-memory hand-offs. They never appear in the fact document unless a detector also reports them as candidates.

## The context

A detector sees the tree only through its `DetectorContext`:

- `reader` is the `SourceReader`, and `commit` is its commit, or null for a working tree.
- `entries(pattern)` lists tree entries, including their mode, type, size, and object id.
- `text(path)` reads a blob as UTF-8 text. It returns `null` for binary, oversized, over-budget, protected, sensitive, or missing input, and the reader records why.
- `parsed(path, format)` reads and parses JSON or YAML. A parse failure returns `null` and records a `parse_failed` diagnostic. A YAML stream's data is its last document with content: pnpm 9 and later can write its own environment lockfile as a first document before the project lockfile, and a GitLab CI component puts its `spec` header before the pipeline. A YAML pointer resolves in that same document.
- `lines`, `pointer`, and `entry` create evidence records for a line range, a structured-data pointer, or a tree entry.
- `fact`, `search`, `service`, and `reference` report candidates.
- `catalogEntry` records a Reference Catalog entry the facts were compared against, for the document's `catalog_entries`.
- `diagnostic` reports a skipped or unsupported input. A shared layer, such as the syntax parser, passes `{ detector }` to put its own name on the diagnostic. Details pass through credential redaction before they're recorded.

The context offers no checkout path, clone URL, configuration, database, Git runner, process environment, or network. ESLint enforces this for all package source (`packages/*/src`): no network, filesystem, process, worker, Git, database, or environment-loading imports, and no `fetch`, `WebSocket`, `XMLHttpRequest`, `EventSource`, `process`, or `require`. Type-only imports from capability modules are allowed, because TypeScript erases them. `eval`, `Function`, `vm`, `module`, `import()`, and `RegExp` built from data are forbidden everywhere. [`eslint.config.mjs`](../eslint.config.mjs) holds the rules, and [`test/lint/safety-rules.test.ts`](../test/lint/safety-rules.test.ts) proves them.

## Candidates

Detectors report candidates. Reconciliation decides what the fact document says.

### Facts

A `FactCandidate` names a `category` and a `key`, proposes a `value`, and cites `evidence`.

- `observed` means the value was read from a literal position, such as a manifest field, lockfile entry, CI step, or string literal.
- `inferred` means the value combines several signals. An inferred candidate must include `reasoning`, a sentence that connects its evidence to its conclusion.

Candidates with the same category and key are reconciled together. Use the key to name the subject, not the value. For example, `runtime_requirements/node` has one key per runtime, so `>=20` in `package.json` and `18` in `.nvmrc` conflict. For a multi-valued category such as `dependencies`, give each value its own key.

Values must be canonical JSON: strings, safe integers, booleans, null, arrays, and objects. Fractions aren't allowed; report a count, or a percentage scaled to an integer.

### Searches

A `SearchRecord` states what a detector examined for a category. It names the rule, the `surface` of paths whose content the search depended on, whether the search was `complete`, and anything it `skipped`. A search that needs only tree entries, such as language distribution by extension, has an empty surface. Report a search for every category you examine, including when you find nothing. Without a complete search, a category with no facts stays `unknown`.

### Service Dependencies

A `ServiceCandidate` groups call sites under a logical `key` and proposes Service Dependency facts: `identity`, `protocol`, `endpoint`, `operations`, `request_shape`, `consumed_response_fields`, `authentication`, `timeout`, `retry`, `proxy`, `contracts`, and `substitutes`. Candidates with the same key merge.

Each fact candidate has a basis:

- `observed` or `inferred` follows the same rules as other facts.
- `unknown` records why a fact can't be established, with the evidence that shows the call. A computed or cross-file endpoint is `unknown`, not guessed.
- `absent` is a bounded negative and must carry its `search`. It is published only when the search was complete and nothing it covered was skipped. Otherwise the fact is `unknown`, and its search is kept.

A fact that no detector addresses is `unknown`, with the rule `not-established`.

The `contracts` and `substitutes` facts associate committed API contracts, generated schemas, interceptors, module mocks, stubs, and fixtures with a service by evidence. Each item names its `association`: for example, a matching server origin, an intercepted path, or a mocked module where the service is called. No association claims that a substitute behaves like the service.

For each service, every candidate is tied, still possible, or ruled out by evidence. The fact is `observed` only when every tie is direct evidence, and `inferred` when any tie is a reasoned association, such as a global `fetch` stub. It is `absent` only after a complete search in which every candidate was ruled out. A candidate that could apply but isn't tied, such as a mock of an unresolved path alias, leaves the fact `unknown`. When several documents could each be a service's contract, each is its own candidate, and the fact is `conflicting`.

### Relationship references and diagnostics

A `ReferenceCandidate` is a typed, evidence-backed pointer to another repository or service, such as a consumed package or a composition remote. Consumers resolve these references across repositories. A diagnostic records a path, a reason, and a detail. Never include secret values, credentials, or raw repository content beyond what identifies the input.

## Categories and extensions

The contract owns 26 shared categories (`SHARED_CATEGORIES`), each with a flag saying whether a complete search may conclude it's absent:

| Group | Categories |
| --- | --- |
| Inventory | `languages`, `submodules` |
| Packages | `package_identity`, `workspaces` |
| Tooling | `package_managers`, `build_tools`, `test_frameworks` |
| Verification | `ci_systems`, `scripts`, `verification_commands` |
| Runtime | `runtime_requirements` |
| Dependencies | `dependencies`, `resolved_dependencies` |
| Architecture | `frameworks`, `composition`, `packages_produced`, `packages_consumed`, `served_origins`, `runtime_integrations` |
| Services | `access_signals`, `egress_routes`, `api_contracts`, `test_substitutes` |
| Interface | `design_systems`, `ui_elements`, `style_values` |

`frameworks` reports each framework a manifest declares, with the `package` that declares it and its specifiers. The hybrid mobile frameworks, React Native, Expo, Capacitor, Ionic, and Cordova, are marked `mobile: true`, and every other framework `mobile: false`. A framework with several packages is reported by the first one the manifest declares: Ionic by `@ionic/react`, `@ionic/angular`, `@ionic/vue`, or `@ionic/core`, and Cordova by `cordova` or its platform packages.

`composition` reports each Module Federation build with its name, remotes, exposes, and shared modules, and the `package` and `api` its plugin came from, so consumers can tell the federation generations apart. That covers webpack, Rspack (`ModuleFederationPluginV1`), the Module Federation 2 plugins and runtime, the Vite, Next.js, and Rsbuild plugins, Native Federation, and Re.Pack's `ModuleFederationPluginV2` from `@callstack/repack`, which React Native super apps build with.

The Interface categories come from the design-system detectors in `@repo-facts/design-system`, which recognize design systems only through the Reference Catalog entries supplied for a survey; see [reference-catalog.md](reference-catalog.md). No design system is compiled into a release.
- **`design_systems`** reports each design system a repository declares or imports, and the entry it was compared against: the entry for the version the repository's lockfile resolves, else the highest version its declared range allows, else the nearest earlier one. Its `entry` names that entry's `version` and `digest`, or is null when every supplied entry is later than the version in use. With no design-system entries supplied, nothing can be recognized: the search isn't complete, so the category is `unknown` rather than `absent`, and a `no_catalog_entries` diagnostic says why.
- **`ui_elements`** counts JSX elements where they're written, by design-system component, intrinsic tag, and customization. Each component fact also counts, per scope, the `props` passed to it: how many elements pass each prop by name, and, for a prop whose entry lists a finite set of values, how many pass each literal value in that set. No other prop value is recorded, so `aria-label="Delete account"` counts as an `aria-label` and nothing more. An element with a spread attribute could pass any prop, so it counts as `unknown` instead. `key` and `ref` aren't props.
- **Render props.** An intrinsic element passed as one of a design system's render props, such as Salt's `render` in `<VerticalNavigationItemTrigger render={<a href="#orders" />} />`, is the root that component renders: it's reported under `rendered:<tag>`, with the components that render it, and not as a raw element. The entry names the render props.
- **`style_values`** classifies style declarations by property family and value kind and reports adherence findings, against the tokens of the entries in use. Property families, neutral values, and neutral tags come from the first entry in use, by id. A repository that uses no described design system has none, so its declarations are all in the family `other` and no container is neutral.

Their counts are split into the `app`, `stories`, and `tests` scopes.

Stylesheets are read in three dialects: CSS, SCSS, and Less, each with its modules (`*.module.css`, `*.module.scss`, `*.module.less`). SCSS and Less are read as data, never compiled:
- Nested rules are flattened for selector findings, as native CSS nesting is. A parent suffix, such as `&__header` inside `.card`, resolves to the class `card__header`, which CSS-module class lookups use, and its rule isn't associated with the parent's class.
- Preprocessor variables (`$name`, `@name`) are never tokens. A value that uses one, or an interpolation, is `unresolved`. A `var(--salt-...)` reference counts as a token wherever it's written.
- A class whose rules apply an SCSS `@include` or `@extend`, or a Less mixin call or `:extend`, gets declarations from elsewhere, so an element styled with it has an unresolved style. A mixin's own body isn't any class's, and isn't a global element selector.
- An interpolated selector, or a parent suffix whose parent doesn't end in a class, is noted as `unresolved_selector`, and the classes it would define aren't indexed. An interpolated property is counted as `unparsed`. Neither is guessed.
- A CSS module's `:export` and `:import` blocks hand values to and from JavaScript, so their declarations aren't styles.

`@import`, `@use`, and `@forward` are recorded as data and never followed. Sass's indented syntax (`*.sass`) isn't parsed, and neither are component and view templates: Vue (`*.vue`), Svelte (`*.svelte`), Astro (`*.astro`), Angular (`*.component.html`), Handlebars (`*.hbs`), Play Twirl (`*.scala.html`), ERB (`*.erb`), and Razor (`*.cshtml`, `*.razor`). Each is a skipped input on the surfaces of `ui_elements` and `style_values`, so a Vue application's elements are unknown rather than absent. A template is skipped only there: it has no `unsupported_input` diagnostic, because other searches read some templates, such as an Angular template's HTML for import maps.

The package, tooling, and dependency categories cover JavaScript and TypeScript packages. Other ecosystems' build inputs are recognized by name but not analyzed: Go (`go.mod`, `go.sum`, `go.work`), Rust (`Cargo.toml`, `Cargo.lock`), Maven (`pom.xml`, `mvnw`), Gradle (`build.gradle`, `settings.gradle`, `gradlew`, version catalogs, `gradle.lockfile`), sbt (`*.sbt`, `project/build.properties`), Python (`pyproject.toml`, `setup.py`, `setup.cfg`, `requirements*.txt`, `Pipfile`, and lockfiles), Ruby (`Gemfile`, `*.gemspec`, `Gemfile.lock`), PHP (`composer.json`, `composer.lock`), .NET (`*.csproj`, `*.fsproj`, `*.sln`, `Directory.Packages.props`, `packages.lock.json`), Clojure and ClojureScript (`deps.edn`, `project.clj`, `shadow-cljs.edn`), Elixir (`mix.exs`, `mix.lock`), Dart (`pubspec.yaml`), Swift (`Package.swift`, `Package.resolved`), and CocoaPods. Each one gets an `unsupported_input` diagnostic that names its ecosystem, and the `unsupported-inputs` detector puts it on the surface of every category it would feed: a manifest feeds `package_identity`, `dependencies`, `package_managers`, `build_tools`, `frameworks`, `test_frameworks`, `runtime_requirements`, `scripts`, `workspaces`, `packages_produced`, and `packages_consumed`, and a lockfile feeds `resolved_dependencies` and `package_managers`. A skipped input keeps a category with no facts `unknown` instead of `absent`, so a Scala or Go repository never reads as having no dependencies. A category with facts from inputs this release does analyze, such as a `package.json` beside a `docs/requirements.txt`, keeps its facts and lists the other ecosystem's input under `skipped`.

Vendored and generated code isn't the repository's own, so the inventory leaves it out of inputs, sources, and languages: `node_modules`, `bower_components`, and `.yarn` directories at any depth, minified bundles (`*.min.js`, `*.min.mjs`, `*.min.cjs`, `*.min.css`), Yarn Plug'n'Play loaders (`.pnp.cjs`, `.pnp.js`, `.pnp.loader.mjs`), and Go vendor directories, which are a `vendor` directory holding `modules.txt` or beside a `go.mod`. A directory merely named `vendor` can hold the repository's own code, and a `*.bundle.js` file can be source, so neither is excluded by name. No diagnostic is recorded for excluded paths, and the document's `inventory` counts still include them, because they describe the tree.

A product registers extra categories when it runs the bundle, with ids namespaced as `<namespace>.<name>`, such as `web-doctor.routes`. `categoriesFor(extensions)` rejects an un-namespaced id, a duplicate, or an id that collides with a shared one.

Every document contains every shared category plus every registered extension, and nothing else. It also lists the extensions it was produced with, including their bounded-negative flags, so any validator can check it without knowing which product produced it. Extension detectors follow this same contract and live in the product that registers them.

## Reconciliation

`reconcileFacts` ([`packages/contract/src/facts/reconcile.ts`](../packages/contract/src/facts/reconcile.ts)) builds the document:

- A fact candidate without evidence, or an inferred candidate without reasoning, isn't published. It becomes an `unsupported_assertion` diagnostic.
- Agreeing candidates merge. The result is `observed` if any candidate observed it, and all of their evidence is kept.
- Disagreeing candidates produce a `conflicting` fact. It lists every candidate with its evidence and has no chosen value.
- Every category appears, with a state that follows from its facts: `observed`, `inferred`, `mixed`, or `conflicting`. A category with no facts is `absent` only when it allows a bounded negative, every search for it was complete, and nothing was skipped. Any other category with no facts is `unknown`.
- A path on a search's surface counts as skipped when the reader skipped it or a detector couldn't parse it. `SKIPPED_INPUT_REASONS` lists those diagnostic reasons. Other diagnostics are notes, and the detector that raises one decides whether its own search skipped something.
- `composition`, `served_origins`, `runtime_integrations`, and `resolved_dependencies` never report `absent`, because no bounded search can rule them out.
- Every Service Dependency's access state is `unknown`. Static discovery can't establish entitlement, credentials, or reachability. `missing_evidence` lists the facts that are unknown or conflicting. `characterizable` is true only when the endpoint, operations, and consumed response fields are established.
- A detector that throws becomes a `detector_failed` diagnostic, and every category it declared is marked incomplete. A failure therefore can't read as an absence.

`factDocumentProblems` validates a document against the schema and checks the semantic rules:
- Every cited evidence id must exist and name the document's commit.
- Category states must match their facts and searches.
- No fact may be asserted without evidence or inferred without reasoning.
- No conflict may be missing its candidates.
- No absent Service Dependency fact may lack a complete search.

Reconciliation refuses to return a document that fails these checks.

## The fact document

[`examples/fact-document.json`](examples/fact-document.json) is a complete document from a working tree: its `commit` is null. It shows a conflicting Node requirement, with both candidates and their evidence, and an absent `test_frameworks` category after a complete search. [`examples/fact-document-with-extension.json`](examples/fact-document-with-extension.json) adds a registered `example.routes` extension category. Both are regenerated by `test/docs/docs.test.ts`, which fails if they drift.

### Reference Catalog entries

`catalog_entries` lists each Reference Catalog entry the document's facts were compared against, once per thing, in kind and id order:

| Field | Meaning |
| --- | --- |
| `kind` | The entry's kind, such as `design_system` |
| `id` | The thing's id, such as `salt` |
| `version` | The entry's version, such as `1.75.0` |
| `format_version` | The entry's format version |
| `digest` | The entry's digest |
| `wanted` | The `package` whose version the repository wanted, and that `version`: the version a lockfile resolves, else the highest version a declared range allows, else null |

Entries supplied but not used aren't listed, so rebuilding an unrelated entry changes nothing. When every supplied entry is later than the version in use, `version`, `format_version`, and `digest` are null: no entry was compared, and a later build for that version would change the comparison. `selectEntry` from `@repo-facts/contract`, given the same entries and `{ kind, id, ...wanted }`, picks the same entry Surveyor did, which is how a consumer tells whether a document is still the one a survey would produce now.

For example, a repository whose lockfile resolves `@salt-ds/core` 1.76.0, surveyed when the newest Salt entry is 1.75.0, lists the Salt 1.75.0 entry with `wanted` `{ "package": "@salt-ds/core", "version": "1.76.0" }`, and its `design_systems` fact names the same entry.

## Product envelopes

A product embeds the fact document unchanged inside its own document and adds only its own identity, such as the repository and commit. Shared validation then runs on exactly what the detectors produced, and product fields can't slip past the fact document's strict schema. The Frontend Registry's Repository Profile is such an envelope.

## Determinism and versioning

The fact document is serialized as canonical JSON, with sorted keys and no whitespace, and digested with SHA-256. Reconciliation sorts every list it emits, so neither candidate order nor object key insertion order changes the document. `packages/contract/test/fact-document.test.ts` verifies both properties.

The fact document's `schema_version` changes whenever a document valid under the new version could fail validation under the old one, such as when a shared category is added:

| Version | Change |
| --- | --- |
| 1 | The first fact document schema |
| 2 | Adds the Interface categories `design_systems`, `ui_elements`, and `style_values` |
| 3 | Adds `catalog_entries`, the Reference Catalog entries the document was compared against |

A consumer validates that a document has exactly the shared categories it knows, so a version 1 consumer rejects a version 2 document cleanly by its version rather than by its unregistered categories. `factDocumentProblems` reads versions 2 and 3; Surveyor writes version 3.

Change a detector's `version`, and publish a new release, whenever its output could change for the same content. That includes parser upgrades. The Surveyor release is recorded in every document's `detector_release` field, a stored name kept from earlier releases, and earlier documents keep the release that produced them. Reference Catalog entries aren't part of a release: a changed entry changes the documents surveyed with it, which name its new digest, but not the release or its configuration digest.
