# @repo-facts/catalog-builder

The Catalog Builder writes Reference Catalog entries: one `reference_catalog.entry` per design system per version, which Surveyor compares repositories against. The Frontend Registry runs it as a `catalog.build` job, stores what it writes, and supplies the entries to surveys. The entry format, and how Surveyor picks and uses entries, are in [docs/reference-catalog.md](../../docs/reference-catalog.md), which `@repo-facts/contract` ships.

The builder is the only part that downloads. Surveyor's packages never import it, and a lint rule enforces that. Its code is released with Surveyor, but its output is data: a new Salt version needs new entries, not a release.

## Sources

An entry for a design system at one version comes from three sources, in order of precedence. Each section of the entry names the source that supplied it, and the version of that source.

1. **The published packages, at that exact version.** The builder fetches each tarball from the configured registry, checks it against the integrity the registry records, and reads it in memory as data. It never installs a package or runs a script.
   - **Components and props** come from the design system's own package, such as `@salt-ds/core`: its exports whose declared types are React components, and the props those types declare. When a prop allows only a finite set of literals, such as `"solid" | "bordered" | "transparent"` or `boolean`, its values are listed. The declarations are type-checked in memory with TypeScript's standard library and nothing else, so props that come from React's types aren't listed.
   - **Tokens** come from the theme package's stylesheets, such as `@salt-ds/theme`: every custom property with the token prefix. A token that only the deprecated parts of a stylesheet define is marked deprecated.
   - **Icons** come from the icons package's exports, such as `@salt-ds/icons`.
2. **The design system's own published data.** For Salt, that's the registry in the newest `@salt-ds/mcp`, `generated/*.json`. It supplies patterns, each with the components it's composed of and its regions, deprecations, and guidance. It's built from Salt's main branch, not from a release, so the entry records the snapshot's date, and nothing version-specific comes from it. Deprecations are kept only when the release's version of their package has them.
3. **The team's rules,** `catalog-rules/<id>.yaml`, reviewed like code: the design system's packages, providers, theme stylesheets, token and class prefixes, the components that replace HTML elements, neutral tags and values, CSS property families, and render props. Their version in the entry is the digest of what they say, so editing a comment changes nothing. This package ships Salt's, [catalog-rules/salt.yaml](catalog-rules/salt.yaml); the Frontend Registry keeps the copy it builds with in `config/catalog-rules/`.

Every built entry is validated against the entry schema in `@repo-facts/contract` and sealed with its digest. Building the same inputs twice gives the same digest; only `built_at` differs.

## Configuration

A thing to build is described the way the Frontend Registry's `config/catalog.yaml` describes it. `catalogThingSchema` validates it:

```yaml
kind: design_system
id: salt
package: "@salt-ds/core"   # its version is the entry's; components and props come from it
tokens: "@salt-ds/theme"   # optional: tokens come from its stylesheets
icons: "@salt-ds/icons"    # optional: icons come from its exports
data:                      # optional: the design system's own published data
  package: "@salt-ds/mcp"
  format: salt-mcp
```

```ts
import { buildFromRegistry } from "@repo-facts/catalog-builder";

const entry = await buildFromRegistry(thing, "1.75.0", {
  rules: saltRulesText,                       // the text of catalog-rules/salt.yaml
  registry: "https://registry.npmjs.org/",    // the default
});
```

| Option | Meaning |
| --- | --- |
| `rules` | The text of the team's rules for the thing. Required. |
| `registry` | The npm registry to read packages from. Defaults to the public registry; CIB points it at its internal mirror, which the Frontend Registry sets with `FRONTEND_REGISTRY_CATALOG_REGISTRY`. |
| `versions` | Exact versions of the tokens, icons, or data packages, by name, in place of the ones the builder chooses. |
| `timeoutMs` | How long one request may take. Defaults to 60 seconds. |
| `fetch` | The `fetch` to use. Defaults to the global one. |
| `now` | When the build is recorded as happening. Defaults to now. |

The builder chooses the other packages' versions from the registry's metadata:
- **Tokens and icons packages** are the versions released with the design system's own package: the lowest published version in the range that package declares for them as a dependency or peer dependency, or, when it declares none, the highest release published no later than it. Salt 1.75.0 is `@salt-ds/core` 1.75.0, `@salt-ds/theme` 1.48.0, and `@salt-ds/icons` 1.19.0.
- **The published data** is the most recently published version of its package.

Authenticated registries aren't supported yet.

## Failures

A build that fails throws a `CatalogBuildError` and produces no entry, so the entries in use stay as they were. Its `reason` says why:

| Reason | Meaning |
| --- | --- |
| `registry_unreachable` | The registry couldn't be reached, or answered with an error |
| `not_found` | The package or version isn't published, or no companion version was released with it |
| `integrity_mismatch` | A tarball doesn't match the integrity the registry records |
| `invalid_package` | A tarball can't be read, names another package, or a configured source wasn't supplied |
| `invalid_rules` | The rules file isn't valid; `problems` lists every problem |
| `invalid_entry` | The built entry fails validation; `problems` lists every problem |

## Offline

Only `buildFromRegistry`, `fetchPackument`, and `fetchPackage` use the network. `buildEntry(thing, sources, { builtAt })` builds from packages already read, with `readPackage(name, version, tarballBytes)`, so a build can run from tarballs fetched earlier, or from a mirror copied by other means, with no network at all. Surveys never need the network: the Frontend Registry hands Surveyor the stored entries.
