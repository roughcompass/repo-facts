# repo-facts

repo-facts discovers evidence-backed facts about repositories without running anything from them. It reads committed files through a reader and parses them as data. Each fact is reported as observed, inferred, unknown, or conflicting, with the exact file location that supports it. Fabricate and web-doctor consume it as published npm packages.

## Packages

All packages are published together at one version. That version is the detector release that every fact document records.

| Package | Contents |
| --- | --- |
| `@repo-facts/contract` | Fact document, reconciliation, runner, reader interface, read policy, evidence, and canonical JSON |
| `@repo-facts/syntax` | Parse-only JavaScript and TypeScript syntax, static values, and syntax rules |
| `@repo-facts/core` | Inventory, manifest, tooling, runtime, lockfile, and CI detectors |
| `@repo-facts/architecture` | Composition and package-relationship detectors |
| `@repo-facts/services` | Service Dependency, access, and testability detectors |
| `@repo-facts/bundle` | One tested set of detectors: the detector release |

Consumers depend on `@repo-facts/bundle` at an exact version. It depends on every other package at that same version.

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

## Local registry

Packages are published only to an internal npm registry. For development in this workspace, `npm run registry` serves a local Verdaccio registry on `127.0.0.1:4873`, with storage under `tmp/registry/`:

```sh
npm run registry
```

It prints the two variables that other shells need:

```sh
export REPO_FACTS_NPM_REGISTRY=http://127.0.0.1:4873/
export REPO_FACTS_NPM_TOKEN=<printed token>
```

The token belongs to a local account with a random password stored under `tmp/registry/`. The registry has no upstream, so it serves only packages published to it.

## Consuming the packages

Add these lines to the consumer's `.npmrc`:

```ini
@repo-facts:registry=${REPO_FACTS_NPM_REGISTRY}
omit-lockfile-registry-resolved=true
ignore-scripts=true
```

Then pin an exact release:

```sh
npm install --save-exact @repo-facts/bundle@0.1.0
```

- **The scope resolves only to the internal registry.** If `REPO_FACTS_NPM_REGISTRY` is unset, the URL stays unexpanded and the install fails instead of falling back to a public registry.
- **Lockfiles name no registry.** `omit-lockfile-registry-resolved` makes the lockfile record each package's version and SHA-512 integrity but no registry URL. Every install resolves through the scope mapping, and npm rejects bytes that don't match the recorded integrity.
- **Don't use `replace-registry-host=always`.** It makes `npm ci` rewrite scoped tarball URLs to the default public registry.

## Releasing

Every release publishes all packages at one version, in dependency order.

1. Set the version and commit it:

   ```sh
   npm run release:version -- 0.1.0-rc.1
   git commit -am "Release 0.1.0-rc.1"
   ```

2. With `REPO_FACTS_NPM_REGISTRY` and `REPO_FACTS_NPM_TOKEN` set, publish:

   ```sh
   npm run release:publish
   ```

`release:publish` refuses a dirty tree, mixed versions, and lockfiles that record a registry URL for a `@repo-facts` package. It clones `HEAD` into a temporary directory, runs `npm ci --ignore-scripts`, `verify`, and the build there, and checks that each package ships only its build output, manifest, and provenance. It publishes only if all of that passes. Each package records its source commit and release in `provenance.json` and in the `repoFacts` field of its `package.json`. Prereleases publish under the `next` dist-tag.

The token never enters the repository or a package. npm needs it on a host-specific key, so the script writes a temporary auth file outside the repository and deletes it after publishing.

Published versions are never changed. A correction is a new version. `.github/workflows/release.yml` publishes from CI with the registry address in the `REPO_FACTS_NPM_REGISTRY` variable and the token in the `REPO_FACTS_NPM_TOKEN` secret.
