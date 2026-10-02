import { type ComponentValue, type CssDeclaration, type CssToken, parseStylesheet } from "@repo-facts/syntax";
import { type Catalog, TOKEN_CAPABLE_FAMILIES } from "./catalog-schema.js";
import type { IndexedDeclaration, StyleIndex, StyleSource } from "./styles.js";

/**
 * Value classification: each style declaration's property family, from the
 * catalog's property map, and its value kind, by its weakest component in
 * this order: unresolved, raw, other custom property, token alias, token,
 * neutral.
 *
 * A token alias is a custom property whose every definition in the
 * repository resolves to catalog tokens, within four alias steps. The
 * observed kind counts an alias as another custom property; the resolved kind
 * counts it as a token alias, and is an inference.
 */

export const VALUE_KINDS = ["unresolved", "raw", "other_custom_property", "token_alias", "token", "neutral"] as const;
export type ValueKind = (typeof VALUE_KINDS)[number];

export const MAX_ALIAS_STEPS = 4;
export const OTHER_FAMILY = "other";

const RANK: Record<ValueKind, number> = { unresolved: 0, raw: 1, other_custom_property: 2, token_alias: 3, token: 4, neutral: 5 };
const weakest = (a: ValueKind, b: ValueKind): ValueKind => (RANK[a] <= RANK[b] ? a : b);

export interface Classification {
  family: string;
  /** The kind as written: an alias is another custom property. */
  observed: ValueKind;
  /** The kind with token aliases resolved. */
  resolved: ValueKind;
  /** The catalogs whose tokens the value uses, directly or through aliases. */
  systems: ReadonlySet<string>;
  /** The aliases the resolved kind relies on. */
  aliases: ReadonlySet<string>;
}

/** A declaration to classify: from a stylesheet, a template body, or a style object. */
export interface StyleValue {
  property: string;
  /** The parsed value, or null when it comes from an expression that isn't a literal. */
  value: readonly ComponentValue[] | null;
  /** Spans of the text the value was parsed from that were template interpolations. */
  interpolations?: readonly (readonly [number, number])[];
}

const CSS_WIDE = new Set(["inherit", "initial", "unset", "revert", "revert-layer"]);
const COLOR_FUNCTIONS = new Set(["rgb", "rgba", "hsl", "hsla", "hwb", "lab", "lch", "oklab", "oklch", "color", "color-mix", "light-dark"]);
const MATH_FUNCTIONS = new Set(["calc", "min", "max", "clamp", "round", "mod", "rem", "abs", "sign", "sin", "cos", "tan", "pow", "sqrt", "hypot", "log", "exp"]);
const FONT_FAMILY_PROPERTIES = new Set(["font-family"]);
const FONT_PROPERTIES = new Set(["font", "font-family"]);
// The CSS named colors (CSS Color 4), each a literal color.
const NAMED_COLORS = new Set(
  "aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen".split(" "),
);

interface Kinds {
  observed: ValueKind;
  resolved: ValueKind;
  systems: Set<string>;
  aliases: Set<string>;
  /** The most alias steps any reference in the value takes. */
  steps: number;
}

export class ValueClassifier {
  private readonly families = new Map<string, string>();
  private readonly neutral: ReadonlySet<string>;
  private readonly tokens: ReadonlyMap<string, string>;
  private readonly aliasSteps = new Map<string, { steps: number; systems: Set<string>; aliases: Set<string> } | null>();

  /** Families and neutral values come from +primary+; tokens from every catalog in +catalogs+. */
  constructor(
    primary: Catalog,
    catalogs: readonly Catalog[],
    private readonly index: StyleIndex,
  ) {
    for (const [family, properties] of Object.entries(primary.property_families)) for (const property of properties) this.families.set(property, family);
    this.neutral = new Set(primary.neutral_values.map((value) => value.toLowerCase()));
    this.tokens = new Map(catalogs.flatMap((catalog) => catalog.tokens.map((token) => [token, catalog.id] as const)));
  }

  familyOf(property: string): string {
    return this.families.get(property) ?? OTHER_FAMILY;
  }

  isTokenCapable(family: string): boolean {
    return (TOKEN_CAPABLE_FAMILIES as readonly string[]).includes(family);
  }

  classify(input: StyleValue): Classification {
    const family = this.familyOf(input.property);
    if (input.value === null) return { family, observed: "unresolved", resolved: "unresolved", systems: new Set(), aliases: new Set() };
    const kinds = this.values(input.value, { property: input.property, family, inFunction: false, interpolations: input.interpolations ?? [], visiting: new Set() });
    return { family, observed: kinds.observed, resolved: kinds.resolved, systems: kinds.systems, aliases: kinds.aliases };
  }

  /** Classifies a declaration from a stylesheet or template body. */
  classifyDeclaration(declaration: CssDeclaration, source?: StyleSource): Classification {
    return this.classify({ property: declaration.property, value: declaration.value, interpolations: source?.interpolations ?? [] });
  }

  /** The definitions an alias relies on, for an inference's reasoning. */
  aliasDefinitions(name: string): readonly IndexedDeclaration[] {
    return this.index.definitions.get(name) ?? [];
  }

  private values(values: readonly ComponentValue[], context: ValueContext): Kinds {
    const kinds: Kinds = { observed: "neutral", resolved: "neutral", systems: new Set(), aliases: new Set(), steps: 0 };
    for (const value of values) {
      const part = this.value(value, context);
      if (!part) continue;
      kinds.observed = weakest(kinds.observed, part.observed);
      kinds.resolved = weakest(kinds.resolved, part.resolved);
      for (const system of part.systems) kinds.systems.add(system);
      for (const alias of part.aliases) kinds.aliases.add(alias);
      kinds.steps = Math.max(kinds.steps, part.steps);
    }
    return kinds;
  }

  private value(value: ComponentValue, context: ValueContext): Kinds | null {
    if (context.interpolations.some(([start, end]) => value.start < end && value.end > start)) return single("unresolved");
    if (value.kind === "block") return this.values(value.value, context);
    if (value.kind === "function") return this.function(value, context);
    return this.token(value.token, context);
  }

  private function(value: Extract<ComponentValue, { kind: "function" }>, context: ValueContext): Kinds {
    const name = value.name.toLowerCase();
    if (name === "var") return this.reference(value, context);
    if (name === "env" || name === "url" || name === "attr") return single("neutral");
    if (COLOR_FUNCTIONS.has(name)) {
      // A color built from literals is a literal color; one built from references is as strong as they are.
      if (!containsVar(value.value)) return single("raw");
      return this.values(value.value, { ...context, inFunction: true });
    }
    return this.values(value.value, { ...context, inFunction: context.inFunction || MATH_FUNCTIONS.has(name) });
  }

  private reference(value: Extract<ComponentValue, { kind: "function" }>, context: ValueContext): Kinds {
    const first = value.value.find((part) => !(part.kind === "token" && part.token.type === "whitespace"));
    if (!first || first.kind !== "token" || first.token.type !== "ident" || !first.token.value.startsWith("--")) return single("unresolved");
    const name = first.token.value;
    const system = this.tokens.get(name);
    if (system) return { observed: "token", resolved: "token", systems: new Set([system]), aliases: new Set(), steps: 0 };
    const alias = this.alias(name, context.visiting);
    if (!alias) return single("other_custom_property");
    return { observed: "other_custom_property", resolved: "token_alias", systems: new Set(alias.systems), aliases: new Set([name, ...alias.aliases]), steps: alias.steps };
  }

  /** Whether every definition of +name+ resolves to catalog tokens, within the step limit. */
  private alias(name: string, visiting: Set<string>): { steps: number; systems: Set<string>; aliases: Set<string> } | null {
    if (this.aliasSteps.has(name)) return this.aliasSteps.get(name)!;
    if (visiting.has(name)) return null;
    const definitions = this.index.definitions.get(name) ?? [];
    if (!definitions.length) return null;
    visiting.add(name);
    let result: { steps: number; systems: Set<string>; aliases: Set<string> } | null = { steps: 0, systems: new Set(), aliases: new Set() };
    for (const definition of definitions) {
      const kinds = this.values(definition.declaration.value, { property: name, family: OTHER_FAMILY, inFunction: false, interpolations: definition.source.interpolations, visiting });
      if (kinds.resolved !== "token" && kinds.resolved !== "token_alias") {
        result = null;
        break;
      }
      result.steps = Math.max(result.steps, kinds.steps + 1);
      for (const system of kinds.systems) result.systems.add(system);
      for (const alias of kinds.aliases) result.aliases.add(alias);
    }
    visiting.delete(name);
    if (result && result.steps > MAX_ALIAS_STEPS) result = null;
    this.aliasSteps.set(name, result);
    return result;
  }

  private token(token: CssToken, context: ValueContext): Kinds | null {
    switch (token.type) {
      case "whitespace":
      case "comma":
      case "delim":
      case "colon":
      case "semicolon":
        return null;
      case "number":
        if (Number(token.value) === 0 || this.neutral.has(token.value)) return single("neutral");
        return single(!context.inFunction && this.isTokenCapable(context.family) ? "raw" : "neutral");
      case "percentage":
        return single(Number(token.value) === 0 || this.neutral.has(`${token.value}%`) || context.inFunction ? "neutral" : "raw");
      case "dimension":
        return single(Number(token.value) === 0 ? "neutral" : "raw");
      case "hash":
        return single("raw");
      case "ident": {
        const lower = token.value.toLowerCase();
        if (this.neutral.has(lower) || CSS_WIDE.has(lower)) return single("neutral");
        if (NAMED_COLORS.has(lower)) return single("raw");
        return single(FONT_FAMILY_PROPERTIES.has(context.property) ? "raw" : "neutral");
      }
      case "string":
        return single(FONT_PROPERTIES.has(context.property) ? "raw" : "neutral");
      case "url":
        return single("neutral");
      default:
        return single("unresolved");
    }
  }
}

interface ValueContext {
  property: string;
  family: string;
  /** Inside a math or color function, where unitless numbers and percentages are operands, not literals. */
  inFunction: boolean;
  interpolations: readonly (readonly [number, number])[];
  visiting: Set<string>;
}

function single(kind: ValueKind): Kinds {
  return { observed: kind, resolved: kind, systems: new Set(), aliases: new Set(), steps: 0 };
}

function containsVar(values: readonly ComponentValue[]): boolean {
  return values.some((value) => value.kind !== "token" && ((value.kind === "function" && value.name.toLowerCase() === "var") || containsVar(value.value)));
}

/** React's unitless style properties: a number on any other property is a pixel length. */
const UNITLESS = new Set([
  "animation-iteration-count",
  "aspect-ratio",
  "border-image-outset",
  "border-image-slice",
  "border-image-width",
  "box-flex",
  "box-flex-group",
  "box-ordinal-group",
  "column-count",
  "columns",
  "fill-opacity",
  "flex",
  "flex-grow",
  "flex-negative",
  "flex-order",
  "flex-positive",
  "flex-shrink",
  "flood-opacity",
  "font-weight",
  "grid-area",
  "grid-column",
  "grid-column-end",
  "grid-column-span",
  "grid-column-start",
  "grid-row",
  "grid-row-end",
  "grid-row-span",
  "grid-row-start",
  "line-clamp",
  "line-height",
  "opacity",
  "order",
  "orphans",
  "scale",
  "stop-opacity",
  "stroke-dasharray",
  "stroke-dashoffset",
  "stroke-miterlimit",
  "stroke-opacity",
  "stroke-width",
  "tab-size",
  "widows",
  "z-index",
  "zoom",
]);

/** A style-object key as a CSS property: camelCase becomes kebab-case, and `Webkit`, `Moz`, and `ms` become vendor prefixes. */
export function cssProperty(key: string): string {
  if (key.startsWith("--")) return key;
  if (key.includes("-")) return key.toLowerCase();
  const kebab = key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
  return kebab.startsWith("ms-") ? `-${kebab}` : kebab;
}

/**
 * A style-object value as component values: a number is pixels on a length
 * property, as React treats it; a string is parsed as CSS, and is `unparsed`
 * when the CSS syntax rules discard it.
 */
export function styleObjectValue(property: string, value: string | number): ComponentValue[] | "unparsed" {
  if (typeof value === "number") {
    const text = String(value);
    const token: CssToken = UNITLESS.has(property) || value === 0 ? { type: "number", value: text, start: 0, end: text.length } : { type: "dimension", value: text, unit: "px", start: 0, end: text.length + 2 };
    return [{ kind: "token", token, start: token.start, end: token.end }];
  }
  const result = parseStylesheet(`x: ${value}`, { mode: "declarations" });
  if (!result.ok || result.stylesheet.unparsed.length || result.stylesheet.declarations.length !== 1) return "unparsed";
  return result.stylesheet.declarations[0]!.value;
}
