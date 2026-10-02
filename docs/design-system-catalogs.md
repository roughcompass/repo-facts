# Design-System Catalogs

The design-system detectors recognize a design system, and the styling libraries around it, only through catalogs. A catalog is data. It names a design system's packages, components, tokens, and conventions. The adapter catalog names the styling libraries whose calls carry classes and styles. Supporting another design system means adding a catalog and fixtures, not changing a detector.

Catalogs live in `packages/design-system/catalogs/`. `adapters.yaml` is the adapter catalog, and every other `.yaml` file is a design-system catalog, such as `salt.yaml`. `npm run rules:compile` validates them with the schemas in [`packages/design-system/src/catalog-schema.ts`](../packages/design-system/src/catalog-schema.ts) and writes `src/catalogs.generated.ts`, which is committed and shipped. `test/rules/rules.test.ts` fails if the generated module drifts from its YAML. The compiled data's digest is part of the detector configuration, so changing a catalog, even one token, changes the release's configuration digest.

Facts derived from a catalog name it and its `version`. Change the version whenever the catalog's content changes.

## Catalog format

<!-- catalog-fields -->
| Field | Meaning |
| --- | --- |
| `format` | The catalog format version, `1` |
| `id` | The design system's id in fact keys, such as `salt` in `component:salt:Button` |
| `name` | The design system's name |
| `version` | The catalog's version, as `1.2.3` |
| `generated_from` | The package versions the generated sections were read from |
| `packages` | The design system's packages |
| `packages[].name` | A package name. A tag imported from it, or from a subpath of it, is a design-system component. |
| `packages[].components` | The components the package exports, when the catalog lists them |
| `providers` | The components that provide the theme. Rendering any of them counts as using the provider. |
| `providers[].package` | The package that exports the provider |
| `providers[].component` | The provider component, such as `SaltProvider` |
| `theme_stylesheets` | The stylesheet imports that apply the theme, such as `@salt-ds/theme/index.css` |
| `token_prefix` | The prefix every token carries, such as `--salt-` |
| `class_prefix` | The prefix of the design system's own class names, such as `salt` in `saltButton` |
| `equivalents` | The components that replace intrinsic elements |
| `equivalents[].tag` | An HTML tag, such as `button` |
| `equivalents[].package` | The package that exports the replacement |
| `equivalents[].component` | The replacement component, such as `Button` |
| `neutral_tags` | Containers that are acceptable when unstyled, such as `div` and `span` |
| `neutral_values` | Colors, numbers, and lengths that need no token, such as `0`, `100%`, `transparent`, and `inherit` |
| `property_families` | CSS properties by family. Each property is in at most one family, and unlisted properties are in `other`. |
| `tokens` | Every custom property the design system defines |

Keywords other than color keywords, such as `flex` or `center`, are neutral without being listed. `neutral_values` lists the values that would otherwise count as raw.

The families `color`, `spacing`, `typography`, `border`, and `shadow` are token-capable: their declarations count toward a token share. The `layout` family holds what the design system's layout components apply. A container whose styles are all in `layout` is reported as layout-only, because a layout component could replace it. In the Salt catalog, `gap` is a layout property, since Salt's layouts set gaps.

## Adapter format

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
| `ui_libraries` | Component libraries other than the cataloged design systems, such as `@mui/material` |

| Role | Recognized as |
| --- | --- |
| `class_composer` | A call whose arguments are class names, such as `clsx("row", active && "active")`. A `cva` definition is one too: calling the variant it returns applies its classes. |
| `styled_factory` | A call that makes a component from another one, such as ``styled(Button)`...` `` or ``styled.div`...` `` |
| `style_factory` | A tagged template or object of styles, such as ``css`...` `` |

An import resolves to an export the way [syntax rules](syntax-rules.md#matching) resolve a callee: a named import `x` is the default export's member `x`. So `import styled from "styled-components"` matches the export `default`, and `import { styled } from "styled-components"` matches `styled`.

## Generating the Salt catalog

```sh
node scripts/catalog-salt.mjs ../fleet/spa-root/node_modules
npm run rules:compile
```

`scripts/catalog-salt.mjs` reads installed packages from the `node_modules` path it's given, and rewrites three sections of `salt.yaml`:
- `generated_from`, with the versions of `@salt-ds/core` and `@salt-ds/theme` it read
- the `components` of `@salt-ds/core`, from the package's type declarations: exported functions that return JSX, and constants typed as components
- `tokens`, every `--salt-` custom property the `@salt-ds/theme` stylesheets define

It keeps every other section and every comment, so the curated sections stay curated. Nothing reads packages at analysis time. Review the diff, bump the catalog's `version`, and compile.

## What a catalog can't contain

Every string is held to a narrow pattern: a component name, an HTML tag, a CSS property, a custom property, a package name or subpath, a version, or a plain CSS keyword or number. Every object is strict, so an unknown field is an error. A YAML tag such as `!!js/function` loads as plain text and fails its pattern. Compiled catalogs are round-tripped through canonical JSON, so they contain only inert data, and detectors only compare names for equality or check prefixes. Nothing in a catalog becomes a regular expression.

The compiler reports every problem in every file together:
- duplicate packages, components, tokens, equivalents, neutral tags, neutral values, providers, or theme stylesheets
- a component in two packages, or a property in two families
- a provider or equivalent that names a package outside the catalog, or a component its package doesn't list
- a token without the catalog's prefix, or a theme stylesheet outside the catalog's packages
- a tag that's both neutral and replaced by a component
- two catalogs with the same id, package, or token prefix
- a duplicate adapter module or export, or a UI library that's a cataloged design-system package

## Adding a design system

1. Write `catalogs/<id>.yaml` in the catalog format. A generator script like `catalog-salt.mjs` keeps a long token list current.
2. Run `npm run rules:compile`.
3. Add golden fixtures that use the design system, and run `npm run fixtures:update`.
4. Release a new detector version. Its configuration digest changes with the catalog.
