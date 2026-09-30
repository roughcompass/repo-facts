import { REFERENCE_ROLES, REFERENCE_TYPES, SERVICE_FACTS } from "@repo-facts/contract";
import { z } from "zod";

/**
 * The syntax rule format, version 1.
 *
 * A rule is data. It matches one kind of syntax node from a closed
 * vocabulary, captures values from it, and says what to report. Nothing in a
 * rule is executed or compiled into a pattern: identifiers must be plain
 * names, and there are no expressions, regular expressions, or code fields.
 */

export const RULE_FORMAT_VERSION = 1;

const identifier = z.string().regex(/^[A-Za-z_$][A-Za-z0-9_$]*$/, "must be a plain identifier");
const moduleName = z
  .string()
  .min(1)
  .max(214)
  .regex(/^(@[a-z0-9._-]+\/)?[a-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/, "must be a package name or package subpath");
const oneOrMore = <T extends z.ZodType>(item: T) => z.union([item, z.array(item).min(1)]).transform((value) => (Array.isArray(value) ? value : [value]) as z.output<T>[]);
const ruleId = z.string().regex(/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/, "must be dotted lowercase, such as services.fetch");

/**
 * What a call, `new`, or tagged-template expression's callee must be. Exactly
 * one root: an unbound global, a module binding, another rule's matched
 * instance, or any receiver (with a method list).
 */
const calleeSchema = z
  .strictObject({
    /** An identifier not bound in the file, also reached through globalThis, window, or self. */
    global: identifier.optional(),
    /** A binding imported (or required) from one of these modules. */
    module: oneOrMore(moduleName).optional(),
    /** A const bound to a node that this other rule matched, such as an axios instance. */
    instanceOf: ruleId.optional(),
    /** Any receiver; requires `method`. */
    anyReceiver: z.literal(true).optional(),
    /** Exact member names between the root and the method. */
    members: z.array(identifier).optional(),
    /** Alternatives for the final member name, captured as `method`. */
    method: z.array(identifier).min(1).optional(),
  })
  .refine((callee) => [callee.global, callee.module, callee.instanceOf, callee.anyReceiver].filter((root) => root !== undefined).length === 1, "needs exactly one of global, module, instanceOf, or anyReceiver")
  .refine((callee) => !callee.anyReceiver || callee.method !== undefined, "anyReceiver needs a method list");

const matchSchema = z.union([
  z.strictObject({ call: calleeSchema }),
  z.strictObject({ new: calleeSchema }),
  z.strictObject({ tagged: calleeSchema }),
  z.strictObject({ jsx: z.strictObject({ element: z.array(identifier).min(1) }) }),
  z.strictObject({ import: z.strictObject({ module: oneOrMore(moduleName) }) }),
]);

const propertyName = z.string().min(1).max(200);

const captureSchema = z.union([
  /** An argument, optionally followed by a property path into an object literal. */
  z.strictObject({ argument: z.int().min(0).max(20), property: z.array(propertyName).min(1).optional() }),
  /** A JSX attribute's value. */
  z.strictObject({ attribute: z.string().regex(/^[A-Za-z_][A-Za-z0-9_:-]*$/) }),
  /** A tagged template's text. */
  z.strictObject({ template: z.literal(true) }),
  /** An import's module specifier. */
  z.strictObject({ module: z.literal(true) }),
]);

const literal = z.union([z.string(), z.int(), z.boolean()]);
const template = z.string().min(1).max(500);
const json: z.ZodType<unknown> = z.lazy(() => z.union([z.string(), z.int(), z.boolean(), z.null(), z.array(json), z.record(z.string(), json)]));

const emitSchema = z.union([
  z.strictObject({
    fact: z
      .strictObject({
        category: z.string().min(1),
        /** `{capture}` interpolates a literal capture; otherwise the key falls back to the match location. */
        key: template,
        /** A string exactly `$capture` becomes that capture's resolved value. */
        value: json,
        basis: z.enum(["observed", "inferred"]),
        reasoning: z.string().min(1).optional(),
      })
      .refine((fact) => fact.basis === "observed" || fact.reasoning !== undefined, "inferred facts need reasoning"),
  }),
  z.strictObject({
    reference: z.strictObject({
      type: z.enum(REFERENCE_TYPES),
      role: z.enum(REFERENCE_ROLES),
      identifier: z.record(z.string().regex(/^[a-z_]+$/), template),
      basis: z.enum(["observed", "inferred"]),
    }),
  }),
  z.strictObject({
    service: z.strictObject({
      client: z.enum(["fetch", "axios", "websocket", "graphql", "generated", "packaged", "host_adapter"]),
      /** Service facts supplied by captures (by name) or fixed literals. */
      facts: z.partialRecord(z.enum(SERVICE_FACTS), z.union([z.strictObject({ capture: identifier }), z.strictObject({ literal: json })])),
    }),
  }),
  /** A match handed to detector code, for patterns rules alone can't describe. */
  z.strictObject({ signal: z.strictObject({ kind: z.string().regex(/^[a-z][a-z0-9-]*$/, "must be lowercase kebab-case") }) }),
]);

export const ruleSchema = z.strictObject({
  id: ruleId,
  version: z.int().positive(),
  description: z.string().min(1),
  match: matchSchema,
  capture: z.record(identifier, captureSchema).optional(),
  /** Every condition must hold for the match to count. */
  where: z.array(z.strictObject({ capture: identifier, equals: literal })).optional(),
  emit: emitSchema,
});

export const ruleFileSchema = z.strictObject({
  format: z.literal(RULE_FORMAT_VERSION),
  rules: z.array(ruleSchema).min(1),
});

export type Rule = z.output<typeof ruleSchema>;
export type RuleMatchSpec = Rule["match"];
export type CalleeSpec = z.output<typeof calleeSchema>;
export type CaptureSpec = z.output<typeof captureSchema>;
export type RuleEmit = Rule["emit"];
