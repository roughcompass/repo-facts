import { z } from "zod";

/**
 * A thing the Reference Catalog describes, and where its entries come from,
 * as the Frontend Registry configures it in `config/catalog.yaml`. Format
 * version 1 builds design systems.
 */

const packageName = z.string().regex(/^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/, "must be a package name");

export const catalogThingSchema = z.strictObject({
  kind: z.literal("design_system"),
  id: z.string().regex(/^[a-z][a-z0-9-]*$/, "must be a lowercase id, such as salt"),
  /** The design system's own package. Its version is the entry's, and components and their props come from its declarations. */
  package: packageName,
  /** The theme package whose stylesheets define the tokens. */
  tokens: packageName.optional(),
  /** The package whose exports are the icons. */
  icons: packageName.optional(),
  /** The design system's own published data, read as a whole: patterns, deprecations, and guidance. */
  data: z.strictObject({ package: packageName, format: z.literal("salt-mcp") }).optional(),
});

export type CatalogThing = z.output<typeof catalogThingSchema>;
