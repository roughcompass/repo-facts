import { digestOf, designSystemContentSchema, parseYaml, StructuredParseError } from "@repo-facts/contract";
import { z } from "zod";
import { CatalogBuildError } from "./errors.js";

/**
 * The Digital Enablement team's rules for one design system, in
 * `catalog-rules/<id>.yaml`, reviewed like code: the packages that are the
 * design system's, its provider and theme stylesheets, its token and class
 * prefixes, the components that replace HTML elements, neutral tags and
 * values, CSS property families, and render props. Every value is held to
 * the entry format's narrow patterns.
 */

export const RULES_FORMAT_VERSION = 1;

const curated = designSystemContentSchema.pick({
  name: true,
  providers: true,
  theme_stylesheets: true,
  token_prefix: true,
  class_prefix: true,
  equivalents: true,
  neutral_tags: true,
  neutral_values: true,
  property_families: true,
  render_props: true,
});

export const rulesSchema = z.strictObject({
  format: z.literal(RULES_FORMAT_VERSION),
  id: z.string().regex(/^[a-z][a-z0-9-]*$/, "must be a lowercase id, such as salt"),
  /** The design system's packages. Any export of one, or of a subpath, is a design-system component. */
  packages: z.array(z.string().regex(/^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/, "must be a package name")).min(1),
  ...curated.shape,
});

export type CatalogRules = z.output<typeof rulesSchema>;

/** The content sections rules supply, in the order rules files list them. */
export const RULE_SECTIONS = ["name", "providers", "theme_stylesheets", "token_prefix", "class_prefix", "equivalents", "neutral_tags", "neutral_values", "property_families", "render_props"] as const;

export interface ParsedRules {
  rules: CatalogRules;
  /** `sha256:` of the rules' canonical JSON, so editing a comment doesn't change an entry. */
  version: string;
}

/** Parses and validates a rules file, reporting every problem. */
export function parseRules(text: string, path = "catalog-rules"): ParsedRules {
  let document: unknown;
  try {
    document = parseYaml(text);
  } catch (error) {
    if (!(error instanceof StructuredParseError)) throw error;
    throw new CatalogBuildError("invalid_rules", `${path}: ${error.message}`, [error.message]);
  }
  const parsed = rulesSchema.safeParse(document);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `${path}: ${issue.path.join(".") || "(file)"}: ${issue.message}`);
    throw new CatalogBuildError("invalid_rules", `${path} isn't valid: ${problems.slice(0, 3).join("; ")}`, problems);
  }
  return { rules: parsed.data, version: `sha256:${digestOf(parsed.data).digest}` };
}
