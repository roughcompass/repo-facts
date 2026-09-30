# Detector Contract

This contract governs how detectors turn one snapshot or working tree into a fact document. It is version 1 of the contract and of the fact document schema, `repo_facts.fact_document`. The types live in [`packages/contract/src/detectors/contract.ts`](../packages/contract/src/detectors/contract.ts), and the schema lives in [`packages/contract/src/facts/schema.ts`](../packages/contract/src/facts/schema.ts). Detectors read content only through a reader; see [source-reader.md](source-reader.md).

## What a detector is

A detector is trusted, reviewed code that ships in a detector release, the `@repo-facts/bundle` version. An analyzed repository can't add, configure, or replace one. Each detector declares:

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
2. `parse`: JSON, YAML, lockfiles, and parse-only JavaScript and TypeScript syntax trees
3. `convention`: package manager, build and test tools, CI system, verification commands, runtime requirements, frameworks, and resolved dependencies
4. `architecture`: package production and consumption, composition, iframes, and runtime contracts
5. `services`: Service Dependencies, plus access and testability signals

Service Dependencies run as their own stage so that service detectors can use architecture results. Reconciliation follows the last stage.

Cancellation is checked before every stage. A caller can also pass a `checkpoint` that throws `DetectorRunCanceled` to stop the run.

A later stage reads earlier results from `context.shared`, keyed by the producing detector or layer. Shared values are in-memory hand-offs. They never appear in the fact document unless a detector also reports them as candidates.

## The context

A detector sees the tree only through its `DetectorContext`:

- `reader` is the `SourceReader`, and `commit` is its commit, or null for a working tree.
- `entries(pattern)` lists tree entries, including their mode, type, size, and object id.
- `text(path)` reads a blob as UTF-8 text. It returns `null` for binary, oversized, over-budget, protected, sensitive, or missing input, and the reader records why.
- `parsed(path, format)` reads and parses JSON or YAML. A parse failure returns `null` and records a `parse_failed` diagnostic.
- `lines`, `pointer`, and `entry` create evidence records for a line range, a structured-data pointer, or a tree entry.
- `fact`, `search`, `service`, and `reference` report candidates.
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

### Relationship references and diagnostics

A `ReferenceCandidate` is a typed, evidence-backed pointer to another repository or service, such as a consumed package or a composition remote. Consumers resolve these references across repositories. A diagnostic records a path, a reason, and a detail. Never include secret values, credentials, or raw repository content beyond what identifies the input.

## Categories and extensions

The contract owns 23 shared categories (`SHARED_CATEGORIES`), each with a flag saying whether a complete search may conclude it's absent. A product registers extra categories when it runs the bundle, with ids namespaced as `<namespace>.<name>`, such as `web-doctor.routes`. `categoriesFor(extensions)` rejects an un-namespaced id, a duplicate, or an id that collides with a shared one.

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

## Product envelopes

A product embeds the fact document unchanged inside its own document and adds only its own identity, such as the source repository and assessment. Shared validation then runs on exactly what the detectors produced, and product fields can't slip past the fact document's strict schema. Fabricate's Repository Profile is such an envelope.

## Determinism and versioning

The fact document is serialized as canonical JSON, with sorted keys and no whitespace, and digested with SHA-256. Reconciliation sorts every list it emits, so neither candidate order nor object key insertion order changes the document. `packages/contract/test/fact-document.test.ts` verifies both properties.

Change a detector's `version`, and publish a new release, whenever its output could change for the same content. That includes parser upgrades. The release version is recorded in every document's `detector_release`, and earlier documents keep the release that produced them.
