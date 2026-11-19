import { z } from "zod";

/**
 * The styling-adapter catalog format, version 1. Design systems are no longer
 * compiled into a release: they come from Reference Catalog entries
 * (`reference_catalog.entry` in @repo-facts/contract). The adapter catalog,
 * knowledge of third-party styling libraries, stays compiled in.
 *
 * Adapters are data. Every string is held to a narrow pattern, such as a
 * module or an export name, so nothing in them can be code, and every object
 * is strict, so an unknown field is an error.
 */

export const CATALOG_FORMAT_VERSION = 1;

const version = z.string().regex(/^\d+\.\d+\.\d+$/, "must be a version such as 1.2.3");
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
const exportName = z.string().regex(/^[A-Za-z_$][A-Za-z0-9_$]*$/, "must be a plain export name");

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
  /** Component libraries other than the design systems entries describe; their components are counted by package. */
  ui_libraries: z.array(packageName),
});

export type AdapterCatalog = z.output<typeof adapterCatalogSchema>;

/** The token-capable property families, whose values a design system's tokens can supply. */
export const TOKEN_CAPABLE_FAMILIES = ["color", "spacing", "typography", "border", "shadow"] as const;

/** The family whose declarations a design-system layout component can apply. */
export const LAYOUT_FAMILY = "layout";
