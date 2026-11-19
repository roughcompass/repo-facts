# Reference Catalog

The Reference Catalog describes what repositories build on, such as design systems, as versioned data. One entry describes one thing at one version: Salt 1.75.0 is one entry, and Salt 1.74.0 is another. Surveyor compares a repository against the entries for the versions it uses. The Catalog Builder ([`@repo-facts/catalog-builder`](../packages/catalog-builder/README.md)) writes entries from published packages, a design system's own published data, and the team's rules, and the Frontend Registry stores them and decides when to build them. No design system is compiled into Surveyor, so a new version of one needs new entries, not a Surveyor release.

The format is `reference_catalog.entry`, format version 1. Its strict Zod schema lives in [`packages/contract/src/catalog/entry.ts`](../packages/contract/src/catalog/entry.ts), and both Surveyor and the Catalog Builder import it from `@repo-facts/contract`.

## Entry fields

An entry has three parts: its identity, its provenance, and its content.

<!-- entry-fields -->
| Field | Meaning |
| --- | --- |
| `schema` | Always `reference_catalog.entry` |
| `format_version` | The entry format version, `1` |
| `id` | The thing's id, such as `salt`. It's the id in fact keys, as in `component:salt:Button`. |
| `version` | The thing's version, such as `1.75.0`: the version of its first package |
| `packages` | The packages the entry applies to. The first is the thing's own, whose version the entry carries. |
| `packages[].name` | A package name. A tag imported from it, or from a subpath of it, belongs to the thing. |
| `packages[].version` | The version the entry was built from, when a source supplied one, such as `@salt-ds/theme` `1.48.0` for Salt 1.75.0 |
| `built_at` | When the entry was built, as a UTC timestamp |
| `sources` | Where each content section came from |
| `sources[].name` | A package name, or `catalog-rules/<id>.yaml` for the team's rules |
| `sources[].version` | The package's version, or `sha256:<digest>` of the rules file |
| `sources[].snapshot_date` | For data built from a snapshot rather than a release, the snapshot's date |
| `sources[].sections` | The content sections the source supplied |
| `digest` | The SHA-256 of the entry's canonical JSON, without `digest` and `built_at` |
| `kind` | `design_system`, `runtime_api`, or `composition_contract` |
| `content` | What the thing offers, in a shape specific to its kind |

Format version 1 defines content for design systems. `runtime_api` and `composition_contract` are reserved: their content must be empty, `{}`, until a later format version defines it.

Every content section is supplied by exactly one source, and every section a source claims is in the content. A package source can supply no sections, recording only a version.

## Design-system content

Every section is optional: an entry lists what its sources provide, and Surveyor uses what's there.

<!-- design-system-content-fields -->
| Field | Meaning |
| --- | --- |
| `name` | The design system's name, such as `Salt` |
| `token_prefix` | The prefix every token carries, such as `--salt-` |
| `class_prefix` | The prefix of the design system's own class names, such as `salt` in `saltButton` |
| `theme_stylesheets` | The stylesheet imports that apply the theme, such as `@salt-ds/theme/index.css` |
| `providers` | The components that provide the theme. Rendering any of them counts as using the provider. |
| `providers[].package` | The package that exports the provider |
| `providers[].component` | The provider component, such as `SaltProvider` |
| `components` | The components the packages export |
| `components[].name` | A component name, such as `Button` |
| `components[].package` | The package that exports it |
| `components[].props` | The props its declarations define |
| `components[].props[].name` | A prop name, such as `appearance` |
| `components[].props[].values` | The prop's literal values, when its declarations allow only a finite set, such as `bordered`, `solid`, and `transparent` |
| `components[].props[].deprecated` | `true` when the declarations mark the prop deprecated |
| `tokens` | Every custom property the theme defines |
| `tokens[].name` | A token, such as `--salt-spacing-100` |
| `tokens[].deprecated` | `true` when the theme defines the token only among its deprecated tokens |
| `icons` | The icon components |
| `icons[].name` | An icon component, such as `AddIcon` |
| `icons[].package` | The package that exports it |
| `patterns` | The design system's patterns |
| `patterns[].id` | The pattern's id, such as `pattern.app-header` |
| `patterns[].name` | Its name, such as `App header` |
| `patterns[].summary` | One line about it |
| `patterns[].composed_of` | The components it's composed of |
| `patterns[].regions` | Its regions, such as `branding`, `primary-navigation`, and `utility-actions` |
| `deprecations` | Deprecated components, props, and types |
| `deprecations[].id` | The deprecation's id |
| `deprecations[].package` | The package it's in |
| `deprecations[].kind` | `component`, `prop`, or `type` |
| `deprecations[].component` | For a prop, the component it belongs to |
| `deprecations[].name` | The deprecated name, such as `variant` |
| `deprecations[].deprecated_in` | The version that deprecated it, such as `1.36.0` |
| `deprecations[].removed_in` | The version that removed it, if any |
| `deprecations[].replacement` | What replaces it, such as `appearance` |
| `deprecations[].notes` | One line of migration advice |
| `guidance` | Usage guidance, shown to people and never compared with code |
| `equivalents` | The components that replace intrinsic elements |
| `equivalents[].tag` | An HTML tag, such as `button` |
| `equivalents[].package` | The package that exports the replacement |
| `equivalents[].component` | The replacement component, such as `Button` |
| `neutral_tags` | Containers that are acceptable when unstyled, such as `div` and `span` |
| `neutral_values` | Colors, numbers, and lengths that need no token, such as `0`, `100%`, `transparent`, and `inherit` |
| `property_families` | CSS properties by family. Each property is in at most one family, and unlisted properties are in `other`. |
| `render_props` | The props through which a component renders a caller's element as its own root, such as Salt's `render` |

`guidance` holds `components`, with each component's `summary`, `when_to_use`, and `when_not_to_use`, and `guides`, each with an `id`, a `name`, and a `summary`.

Keywords other than color keywords, such as `flex` or `center`, are neutral without being listed. `neutral_values` lists the values that would otherwise count as raw.

The families `color`, `spacing`, `typography`, `border`, and `shadow` are token-capable: their declarations count toward a token share. A declaration whose value is entirely neutral, such as `margin: 0` or `font: inherit`, needs no token, so it's left out of the share. The `layout` family holds what the design system's layout components apply. A container whose styles are all in `layout` is reported as layout-only, because a layout component could replace it. In Salt's rules, `gap` is a layout property, since Salt's layouts set gaps.

## What an entry can't contain

An entry is inert data. Surveyor compares its names for equality and checks prefixes with `startsWith`; nothing in an entry becomes a regular expression or code.
- **Narrow patterns.** Every string Surveyor compares is held to one: a component name, an HTML tag, a CSS property, a custom property, a package name or subpath, a prop name, a plain literal prop value, a version, or a plain CSS keyword or number. `--salt-.*`, `div|span`, and `() => run()` all fail validation.
- **Strict objects.** An unknown field is an error, at any depth.
- **Prose is displayed, never read.** Pattern summaries, migration notes, and guidance are single lines of text that only people see.

`entryProblems(value)` reports every problem with an entry. Beyond the schema, it checks that:
- the first package carries the entry's version, and no package or source is listed twice;
- every content section has exactly one source, and no source claims a missing section;
- providers and equivalents name the entry's packages and, when a package lists its components, one of them;
- tokens carry the token prefix, theme stylesheets are in the entry's packages, and no property is in two families;
- no tag is both neutral and replaced by a component, and nothing is listed twice;
- the digest matches.

## Digests

An entry is stored as canonical JSON: sorted keys, no insignificant whitespace, and only strings, safe integers, booleans, null, arrays, and objects. `canonicalEntry(entry)` serializes it, and `entryDigest(entry)` is the SHA-256 of the canonical JSON of everything but `digest` and `built_at`. Key order and whitespace never change a digest, and any change to identity, sources, or content does. Leaving out `built_at` means building the same inputs twice gives the same digest, so a rebuild that changes nothing stores nothing new. `sealEntry(entry)` adds the digest to a built entry.

## The version agreement

The format version is an agreement between the Catalog Builder, which writes entries, and Surveyor, which reads them:
- **Rejected, not interpreted.** `readEntry(value)` reads a stored entry. An entry with another `schema` or `format_version` is `unsupported_entry_format`, and one of this format that fails validation is `invalid_entry`. Surveyor doesn't use either. It records a diagnostic naming the entry, its version, and its format version, so the fact document shows what was left out.
- **A new format version for a new meaning.** Adding a field, a kind's content, or a section that Surveyor would read is a new format version, because an older Surveyor's strict schema rejects it. A Surveyor release states the one format version it reads, `ENTRY_FORMAT_VERSION`.
- **Entries outlive releases.** Entries are stored by digest and never changed. A rebuild that produces different content is a new entry with a new digest, and the old entry stays retrievable for the Profiles that name it.

## Choosing an entry

`selectEntry(entries, wanted)` picks the entry a repository is compared against. `wanted` names the thing, by `kind` and `id`, and the version wanted:
- **Exact.** The entry at exactly the wanted version.
- **Nearest earlier.** Otherwise, the entry at the highest version below it. A repository on Salt 1.76.0 is compared against Salt 1.75.0 until a 1.76.0 entry exists.
- **None.** Otherwise, `null`. Every entry is later than what the repository uses.

Versions compare by semantic-version precedence, so `1.76.0-rc.1` comes before `1.76.0`, and a repository on `1.76.0-beta.3` gets `1.75.0` rather than `1.76.0-rc.1`. A wanted version of `null`, for a repository that imports a thing without declaring a version of it, picks the newest entry.

`wanted.package` names the package whose version is wanted. Each entry records the version of every package it was built from, so a repository that resolves only `@salt-ds/theme` 1.48.0 is matched against the Salt entry built from that theme. Without `package`, the thing's own version is compared. When several entries share the chosen version, such as two Salt versions built from the same theme, the higher entry version wins, then the later build, then the lower digest, so the result never depends on input order.

Surveyor calls `selectEntry` for each thing a repository uses, and the Frontend Registry calls it again with the wanted version each fact document records. If it returns another digest, the repository's recipe has changed and it's surveyed again.

## How Surveyor uses entries

A survey is given entries; Surveyor never downloads them. `analyze(reader, { entries })` from `@repo-facts/bundle` takes every current entry of each described thing, as stored, and defaults to none:
- **Reading.** Each entry is read with `readEntry`. One in an unsupported format, or one that fails validation, isn't used, and the fact document records an `unsupported_entry_format` or `invalid_entry` diagnostic naming it.
- **Recognizing.** A design system is recognized by the packages any of its entries list: a manifest declares one, a source file or stylesheet imports one or a theme stylesheet, or a source file renders a provider. With no design-system entries, nothing can be recognized, so `design_systems` stays `unknown` and a `no_catalog_entries` diagnostic says why.
- **Wanting a version.** For each design system in use, Surveyor works out the version the repository wants, trying the entry's packages in order, so the design system's own package comes first. It takes the highest version any lockfile resolves for the first package one does. Otherwise, for the first package any manifest declares, it takes the highest version among the entries that a declared range allows, or the lowest version the range allows when none does. With neither, no version is wanted.
- **Selecting.** `selectEntry` picks the entry for that version. The fact document lists it in `catalog_entries`, with the wanted version, and the `design_systems` fact names its version and digest. When every entry is later than the version in use, the fact names no entry, and the design system's code isn't compared.
- **Comparing.** Components are the exports of the entry's packages, and their props are counted, with values only for props whose entry lists a finite set. Tokens, the token and class prefixes, equivalents, neutral tags and values, property families, and render props all come from the selected entry. Two design systems in one repository are each compared against their own entry.

The fact document is a function of the snapshot, the Surveyor release, its configuration, and the entries supplied. A changed entry changes neither the release nor its configuration digest; a survey with it names its new digest.

## Styling adapters

The adapter catalog isn't part of the Reference Catalog. It names the styling libraries whose calls carry classes and styles, such as `clsx` and `styled-components`. That's knowledge of third-party tooling that rarely changes and doesn't vary by repository, so it stays compiled into Surveyor. It lives in `packages/design-system/catalogs/adapters.yaml`, and `npm run rules:compile` validates it and writes `src/adapters.generated.ts`, which is committed and shipped. Its digest is part of the detector configuration.

<!-- adapter-fields -->
| Field | Meaning |
| --- | --- |
| `format` | The catalog format version, `1` |
| `version` | The adapter catalog's version, as `1.2.3` |
| `adapters` | The styling libraries |
| `adapters[].module` | The module that exports the library's functions, such as `clsx` |
| `adapters[].exports` | The exports the detectors recognize |
| `adapters[].exports[].name` | An export name. `default` names the default export. |
| `adapters[].exports[].role` | What the export does: `class_composer`, `styled_factory`, or `style_factory` |
| `ui_libraries` | Component libraries other than the design systems that entries describe, such as `@mui/material` |

| Role | Recognized as |
| --- | --- |
| `class_composer` | A call whose arguments are class names, such as `clsx("row", active && "active")`. A `cva` definition is one too: calling the variant it returns applies its classes. |
| `styled_factory` | A call that makes a component from another one, such as ``styled(Button)`...` `` or ``styled.div`...` `` |
| `style_factory` | A tagged template or object of styles, such as ``css`...` `` |

An import resolves to an export the way [syntax rules](syntax-rules.md#matching) resolve a callee: a named import `x` is the default export's member `x`. So `import styled from "styled-components"` matches the export `default`, and `import { styled } from "styled-components"` matches `styled`.
