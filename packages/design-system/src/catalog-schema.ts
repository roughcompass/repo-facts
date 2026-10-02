import { z } from "zod";

/**
 * The design-system catalog and styling-adapter formats, version 1.
 *
 * Catalogs and adapters are data. Every string is held to a narrow pattern,
 * such as a component name, an HTML tag, a CSS property, or a package name,
 * so nothing in them can be code, and every object is strict, so an unknown
 * field is an error. Nothing is built into a pattern from them: detectors
 * compare names for equality and prefixes with `startsWith`.
 */

export const CATALOG_FORMAT_VERSION = 1;

const version = z.string().regex(/^\d+\.\d+\.\d+$/, "must be a version such as 1.2.3");
const catalogId = z.string().regex(/^[a-z][a-z0-9-]*$/, "must be a lowercase id, such as salt");
const label = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[A-Za-z0-9][A-Za-z0-9 .-]*$/, "must be a plain name");
const packageName = z
  .string()
  .min(1)
  .max(214)
  .regex(/^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/, "must be a package name");
const moduleName = z
  .string()
  .min(1)
  .max(214)
  .regex(/^(@[a-z0-9._-]+\/)?[a-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/, "must be a package name or package subpath");
const component = z.string().regex(/^[A-Z][A-Za-z0-9]*$/, "must be a component name, such as Button");
const exportName = z.string().regex(/^[A-Za-z_$][A-Za-z0-9_$]*$/, "must be a plain export name");
const tag = z.string().regex(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/, "must be an HTML tag name");
const property = z.string().regex(/^-?[a-z][a-z0-9]*(-[a-z0-9]+)*$/, "must be a CSS property name");
const family = z.string().regex(/^[a-z][a-z_]*$/, "must be a lowercase family name");
const token = z.string().regex(/^--[A-Za-z][A-Za-z0-9]*(-[A-Za-z0-9]+)*$/, "must be a custom property name");
const tokenPrefix = z.string().regex(/^--[a-z][a-z0-9]*-$/, "must be a custom property prefix, such as --salt-");
const classPrefix = z.string().regex(/^[a-z][a-z0-9]*$/, "must be a lowercase class prefix, such as salt");
const neutralValue = z.string().regex(/^(-?\d+(\.\d+)?%?|[a-z][a-z-]*|[a-z]+[A-Z][A-Za-z]*)$/, "must be a CSS keyword or a plain number");

/** A design system: what it ships, what it replaces, and how its styles are named. */
export const catalogSchema = z.strictObject({
  format: z.literal(CATALOG_FORMAT_VERSION),
  id: catalogId,
  name: label,
  version,
  /** The package versions the generated sections were read from. */
  generated_from: z.record(packageName, version),
  packages: z
    .array(
      z.strictObject({
        name: packageName,
        /** The components the package exports, when the catalog lists them. Any export of a catalog package is a design-system component. */
        components: z.array(component).optional(),
      }),
    )
    .min(1),
  /** The components that provide the theme, such as `SaltProvider`; rendering any of them counts. */
  providers: z.array(z.strictObject({ package: packageName, component })).min(1),
  /** Stylesheet imports that apply the theme, such as `@salt-ds/theme/index.css`. */
  theme_stylesheets: z.array(moduleName).min(1),
  token_prefix: tokenPrefix,
  class_prefix: classPrefix,
  /** The component each intrinsic tag can be replaced by. */
  equivalents: z.array(z.strictObject({ tag, package: packageName, component })),
  /** Tags that are acceptable when unstyled, and replaceable by a layout component when they only lay out. */
  neutral_tags: z.array(tag),
  /** Values that need no token, such as `inherit`, `auto`, `0`, and `100%`. */
  neutral_values: z.array(neutralValue),
  /** Property families: each CSS property belongs to at most one. Unlisted properties are in the family `other`. */
  property_families: z.record(family, z.array(property).min(1)),
  tokens: z.array(token).min(1),
});

export type Catalog = z.output<typeof catalogSchema>;

export const ADAPTER_ROLES = ["class_composer", "styled_factory", "style_factory"] as const;
export type AdapterRole = (typeof ADAPTER_ROLES)[number];

/** Styling libraries, by the role of each export, and the packages that are other UI libraries. */
export const adapterCatalogSchema = z.strictObject({
  format: z.literal(CATALOG_FORMAT_VERSION),
  version,
  adapters: z
    .array(
      z.strictObject({
        module: moduleName,
        /** `default` names the default export. */
        exports: z.array(z.strictObject({ name: exportName, role: z.enum(ADAPTER_ROLES) })).min(1),
      }),
    )
    .min(1),
  /** Component libraries other than the cataloged design systems; their components are counted by package. */
  ui_libraries: z.array(packageName),
});

export type AdapterCatalog = z.output<typeof adapterCatalogSchema>;

/** The token-capable property families, whose values a design system's tokens can supply. */
export const TOKEN_CAPABLE_FAMILIES = ["color", "spacing", "typography", "border", "shadow"] as const;

/** The family whose declarations a design-system layout component can apply. */
export const LAYOUT_FAMILY = "layout";
