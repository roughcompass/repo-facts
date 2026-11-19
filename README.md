# Surveyor

Surveyor discovers evidence-backed facts about repositories without running anything from them. It reads committed files through a reader and parses them as data. Each fact is reported as observed, inferred, unknown, or conflicting, with the exact file location that supports it. It compares a repository's code against the Reference Catalog entries for the versions of the design systems it uses. The Frontend Registry, the Digital Enablement team's registry of CIB frontend applications, consumes it as published npm packages, and so does web-doctor.

This repository, its directory, and its npm scope keep the name `repo-facts`: the packages are published as `@repo-facts/*`.

## Packages

All packages are published together at one version. That version is the Surveyor release that every fact document records.

| Package | Contents |
| --- | --- |
| `@repo-facts/contract` | Fact document, Reference Catalog entry format and `selectEntry`, reconciliation, runner, reader interface, read policy, evidence, and canonical JSON. It ships the [detector contract](docs/detector-contract.md) and [Reference Catalog](docs/reference-catalog.md) documents under `docs/`. |
| `@repo-facts/syntax` | Parse-only JavaScript, TypeScript, and CSS syntax, static values, JSX tag resolution, and syntax rules |
| `@repo-facts/core` | Inventory, manifest, tooling, runtime, lockfile, and CI detectors |
| `@repo-facts/architecture` | Composition and package-relationship detectors |
| `@repo-facts/services` | Service Dependency, access, and testability detectors |
| `@repo-facts/design-system` | Design-system recognition and usage detectors, which compare code against supplied Reference Catalog entries, and the styling-adapter catalog |
| `@repo-facts/bundle` | One tested set of detectors: the Surveyor release |

Consumers depend on `@repo-facts/bundle` at an exact version. It depends on every other package at that same version.

## Surveying a repository

```ts
import { analyze, detectorConfiguration, SURVEYOR_RELEASE } from "@repo-facts/bundle";

const document = await analyze(reader, { entries });
```

`entries` are the Reference Catalog entries to compare against, as stored: every current entry of each design system, as the Frontend Registry keeps them. Surveyor picks the entry for the version each repository uses and names it in the fact document's `catalog_entries`. Without entries, no design system is recognized. See [docs/reference-catalog.md](docs/reference-catalog.md) for the entry format and [docs/detector-contract.md](docs/detector-contract.md) for the fact document.

## Setup

You need Node.js 24 (see `.nvmrc`) and npm 11.

```sh
npm ci --ignore-scripts
npm run build
```

The committed `.npmrc` disables dependency lifecycle scripts, so a plain `npm install` also runs none.

## Checks

```sh
npm run check        # typecheck, lint (including the safety rules), unit tests
npm run verify       # check, plus registry integration tests
npm run ci           # verify, release tests, and a release dry run
```

`npm run ci` is what CI runs (`.github/workflows/ci.yml`). The release dry run checks out `HEAD`, builds it, and packs every package, then lists what it would publish. It contacts no registry. With uncommitted changes, it checks a snapshot of the working tree instead of `HEAD`.

The safety rules keep package source from executing, loading, or contacting anything: no network, filesystem, process, Git, or database access, and no dynamic code. They apply to `packages/*/src`. Tests and scripts are exempt.

The unit tests include a name check, `test/names/names.test.ts`, that fails on an old product name anywhere in the repository, apart from the names stored data depends on.

## Fixtures

Golden fixtures under `fixtures/` are small repositories with the fact document Surveyor must produce for each. They're surveyed with the Reference Catalog entries in `test/catalog/`, which tests convert from catalog fixtures: Salt 1.50.0, which is the catalog releases up to 0.6.0 compiled in, Salt 1.75.0, and a small MUI catalog. Change expected documents only with:

```sh
npm run fixtures:update
```

## Local registry

Packages are published only to an internal npm registry. For development in this workspace, `npm run registry` serves a local Verdaccio registry on `127.0.0.1:4873`, with storage under `tmp/registry/`:

```sh
npm run registry
```

It prints the two variables that other shells need:

```sh
export SURVEYOR_NPM_REGISTRY=http://127.0.0.1:4873/
export SURVEYOR_NPM_TOKEN=<printed token>
```

The token belongs to a local account with a random password stored under `tmp/registry/`. The registry has no upstream, so it serves only packages published to it. Set `SURVEYOR_REGISTRY_PORT` to serve it on another port.

`SURVEYOR_NPM_REGISTRY` and `SURVEYOR_NPM_TOKEN` replace `REPO_FACTS_NPM_REGISTRY` and `REPO_FACTS_NPM_TOKEN`. For release 0.7.0 only, the scripts still read the old names, with a warning, when the new ones are unset. The committed `.npmrc` reads only `SURVEYOR_NPM_REGISTRY`.

## Consuming the packages

Add these lines to the consumer's `.npmrc`:

```ini
@repo-facts:registry=${SURVEYOR_NPM_REGISTRY}
omit-lockfile-registry-resolved=true
ignore-scripts=true
```

Then pin an exact release:

```sh
npm install --save-exact @repo-facts/bundle@0.7.0
```

- **The scope resolves only to the internal registry.** If `SURVEYOR_NPM_REGISTRY` is unset, the URL stays unexpanded and the install fails instead of falling back to a public registry.
- **Lockfiles name no registry.** `omit-lockfile-registry-resolved` makes the lockfile record each package's version and SHA-512 integrity but no registry URL. Every install resolves through the scope mapping, and npm rejects bytes that don't match the recorded integrity.
- **Don't use `replace-registry-host=always`.** It makes `npm ci` rewrite scoped tarball URLs to the default public registry.

## Releasing

Every release publishes all packages at one version, in dependency order.

1. Set the version and commit it:

   ```sh
   npm run release:version -- 0.1.0-rc.1
   git commit -am "Release 0.1.0-rc.1"
   ```

2. With `SURVEYOR_NPM_REGISTRY` and `SURVEYOR_NPM_TOKEN` set, publish:

   ```sh
   npm run release:publish
   ```

`release:publish` refuses a dirty tree, mixed versions, and lockfiles that record a registry URL for a `@repo-facts` package. It clones `HEAD` into a temporary directory, runs `npm ci --ignore-scripts`, `verify`, and the build there, and checks that each package ships only its build output, manifest, documents, and provenance. It publishes only if all of that passes. Each package records its source commit and release in `provenance.json` and in the `"repoFacts"` field of its `package.json`, a stored name that consumers read. Prereleases publish under the `next` dist-tag.

The token never enters the repository or a package. npm needs it on a host-specific key, so the script writes a temporary auth file outside the repository and deletes it after publishing.

Published versions are never changed. A correction is a new version. `.github/workflows/release.yml` publishes from CI with the registry address in the `SURVEYOR_NPM_REGISTRY` variable and the token in the `SURVEYOR_NPM_TOKEN` secret.
