# Changelog

Surveyor's releases, newest first. Every `@repo-facts/*` package is published at each version.

## 0.7.0

Surveyor compares repositories against Reference Catalog entries supplied for each survey, instead of a design-system catalog compiled into the release. The Frontend Registry, which consumes Surveyor, supplies the entries and adopts this release in the same change.

### Breaking

- **Design systems come from supplied entries.** `analyze(reader, { entries })` takes the Reference Catalog entries to compare against, as stored. It defaults to none, which recognizes no design system: `design_systems` is then `unknown`, with a `no_catalog_entries` diagnostic. The compiled Salt catalog (`CATALOGS`, `CATALOGS_DIGEST`, `catalogSchema`, `compileCatalogs`, and `SHIPPED`) is gone, and so is the assumed `render` prop.
- **`DETECTOR_RELEASE` is now `SURVEYOR_RELEASE`,** with no alias. `runDetectors` and `reconcileFacts` take `surveyorRelease` in place of `detectorRelease`. Stored documents keep their `detector_release` field.
- **Fact document version 3.** It adds `catalog_entries`: each entry the facts were compared against, with its kind, id, version, format version, digest, and the version the repository wanted. Each `design_systems` fact gains `entry`, the version and digest it was compared against, and drops `catalog_version`. Each design-system component fact gains `props`, per scope. `factDocumentProblems` still reads version 2 documents.
- **The detector configuration is version 4.** It names the compiled styling-adapter catalog's digest, `adapters`, in place of `catalogs`, because entries aren't part of a release. A changed entry changes neither the release nor the configuration digest.
- **Detector contract.** `DetectorContext` gains `catalogEntry`, which records an entry for the document's `catalog_entries`.
- **Registry variables.** `REPO_FACTS_NPM_REGISTRY` and `REPO_FACTS_NPM_TOKEN` become `SURVEYOR_NPM_REGISTRY` and `SURVEYOR_NPM_TOKEN`. The release scripts and the release workflow still read the old names, with a warning, for this release only; the committed `.npmrc` reads only the new one. The test-only switches become `SURVEYOR_UPDATE_FIXTURES`, `SURVEYOR_UPDATE_RULES`, `SURVEYOR_UPDATE_EXAMPLES`, `SURVEYOR_SENTINEL_DIR`, and `SURVEYOR_REGISTRY_PORT`, with no fallback.

### Added

- **The Reference Catalog entry format,** `reference_catalog.entry` format version 1, in `@repo-facts/contract`: a strict schema, `readEntry`, `entryProblems`, `canonicalEntry`, `entryDigest`, `sealEntry`, and `selectEntry`. See [docs/reference-catalog.md](docs/reference-catalog.md).
- **Version-matched comparison.** Each design system a repository uses is compared against the entry for the version its lockfile resolves, else the highest version its declared range allows, else the nearest earlier entry. Several design systems in one repository are each compared against their own entry. A repository on `@salt-ds/theme` 1.48.0 no longer reports Salt's newer tokens as unknown.
- **Prop counts.** Each design-system component reports, per scope, how many elements pass each prop, and how many pass each literal value of a prop whose entry lists a finite set. No other value is recorded, and an element with a spread counts as unknown.
- **Render props from entries.** The props through which a component renders a caller's element as its root come from the entry, such as Salt's `render`.
- **Hybrid mobile frameworks.** React Native, Expo, Capacitor, Ionic, and Cordova are reported in `frameworks`, marked `mobile: true`; every framework fact now has `mobile`.
- **Re.Pack federation.** Re.Pack's `ModuleFederationPluginV2` from `@callstack/repack` is reported as Module Federation, with its package and API.
- **Documents in the contract package.** `@repo-facts/contract` ships `docs/detector-contract.md` and `docs/reference-catalog.md`, so consumers can show the copy that matches the installed release.
- **A name check** that fails on an old product name anywhere in the repository.

### Changed

- **Surveyor.** The packages are Surveyor, and the Frontend Registry consumes them; interface text, comments, and diagnostics say "Surveyor release". The npm scope, the repository, and stored names, such as the `repo_facts.*` schemas, `detector_release`, and the `"repoFacts"` provenance field, keep their names.
- **Property families need an entry.** Property families, neutral values, and neutral tags come from the first entry in use. A repository that uses no described design system reports every declaration in the family `other`, and no container as neutral.
- **Detector versions.** `design-system.recognize` 3, `design-system.usage` 3, `composition` 4, `tooling` 3, `inventory` 3, and `yarn-lock` 3.
