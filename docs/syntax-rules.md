# Syntax Rules

Architecture, Service Dependency, and access patterns are written as rules: YAML data that says which syntax to match, what to capture, and what to report. One engine in `@repo-facts/syntax` evaluates every rule. Adding support for another client library or composition mechanism means adding a rule and a fixture, not a new detector.

Rules live in `packages/architecture/rules/*.yaml` and `packages/services/rules/*.yaml`. `npm run rules:compile` validates them and writes each package's `src/rules.generated.ts`, which is committed and shipped. `test/rules/rules.test.ts` fails if a generated module drifts from its YAML. The compiled rules' digest is part of the detector configuration, so changing a rule changes the release's configuration digest.

## A worked example

This rule reports single-spa application registrations as composition facts:

<!-- example-rule -->
```yaml
format: 1
rules:
  - id: architecture.single-spa-registration
    version: 1
    description: single-spa applications registered with registerApplication
    match:
      call:
        module: single-spa
        members: [registerApplication]
    capture:
      name: { argument: 0, property: [name] }
    emit:
      fact:
        category: composition
        key: "single-spa:{name}"
        value: { mechanism: single-spa, application: $name }
        basis: observed
```

Given this source file, `src/root-config.ts`:

<!-- example-source: src/root-config.ts -->
```ts
import { registerApplication as register } from "single-spa";

// registerApplication({ name: "@acme/commented-out" });
register({ name: "@acme/orders", app: () => import("./orders"), activeWhen: "/orders" });
register({ name: appName(), app: loadApp, activeWhen: "/dynamic" });
```

the rule reports two facts. The alias `register` still resolves to `single-spa`, and the call inside the comment isn't syntax, so it never matches. The second registration's name is computed, so its value records it as unresolved and its key falls back to the file and line:

<!-- example-facts -->
```json
[
  {
    "key": "single-spa:@acme/orders",
    "value": { "application": { "kind": "literal", "value": "@acme/orders" }, "mechanism": "single-spa" }
  },
  {
    "key": "src/root-config.ts:5",
    "value": {
      "application": { "detail": "The value is computed at runtime", "kind": "unresolved", "reason": "computed" },
      "mechanism": "single-spa"
    }
  }
]
```

`test/docs/docs.test.ts` compiles this rule, runs it over this source, and checks these facts exactly.

## Matching

`match` names exactly one kind of syntax:

| Kind | Matches |
| --- | --- |
| `call` | A call expression whose callee matches |
| `new` | A `new` expression whose constructor matches |
| `tagged` | A tagged template whose tag matches, such as a GraphQL `gql` document |
| `jsx` | A JSX element with one of the listed intrinsic names, such as `iframe` |
| `import` | An import, re-export, `require()`, or literal `import()` of one of the listed modules |

A callee has exactly one root:

- `global` is an identifier not bound in the file. It also matches through `globalThis`, `window`, or `self`.
- `module` is a binding imported from one of the listed modules. Default, namespace, named, and aliased imports all resolve, as do `require()`, destructuring from `require()`, and member chains such as `require("webpack").container`. A named import `x` is treated as the default export's member `x`, the way CommonJS interop presents it.
- `instanceOf` is a `const` bound to a node that another rule matched. For example, `const api = axios.create(...)` makes `api.get(...)` an instance call. A `let` or `var` never resolves, because it can be reassigned.
- `anyReceiver` is any object, together with a `method` list, such as `postMessage` on any window.

`members` lists the exact member names between the root and the call, and `method` lists alternatives for the final member. The matched method is captured as `method`.

Matching is structural and conservative. Comments and string contents are never matched. Bindings are tracked per file, not per scope, so a name bound more than once is never resolved. A global name bound anywhere in the file, even as a parameter, isn't treated as the global. The engine misses those matches rather than guessing.

## Captures and conditions

| Capture | Reads |
| --- | --- |
| `{ argument: N }` | The Nth argument, resolved statically |
| `{ argument: N, property: [a, b] }` | A property path within that argument's object literal |
| `{ attribute: src }` | A JSX attribute's value |
| `{ template: true }` | A tagged template's text |
| `{ module: true }` | An import's module specifier |

Captured values are resolved with the static-value resolver. They're recorded as `literal`, `template`, `configured` (for `process.env` and `import.meta.env` keys), `object`, `array`, `absent`, or `unresolved` with a reason. A spread before an argument's position makes it unresolved. Every captured string is redacted of credentials.

`where` lists conditions that must all hold. A condition either compares a capture to a literal with `equals`, such as an event name equal to `message`, or tests the kind of value it resolved to with `is`: `string`, `number`, `boolean`, `object`, `array`, `template`, `configured`, `unresolved`, or `absent`. For example, `is: object` tells `registerApplication({ name })` apart from `registerApplication("name", app)`.

## Emits

- `fact` reports a fact with a category, a key, a value, and a basis. In the key, `{capture}` interpolates a literal capture; if any interpolated capture isn't a literal, the key becomes the match's file and line. In the value, a string exactly `$capture` is replaced by that capture's resolved value. An `inferred` fact must give its `reasoning`.
- `reference` reports a typed relationship reference. Every identifier field must interpolate to a literal; otherwise the reference isn't reported, and an `unresolved_reference` diagnostic says why.
- `service` and `signal` hand the match to detector code, for Service Dependencies and for patterns that rules alone can't describe. Detector code sees every match, of every emit kind, so it can also draw conclusions across matches, such as recognizing a single-spa root configuration from its registrations and its `start()` call.

Each fact and reference names its rule and cites the matched node's lines as evidence.

## What a rule can't contain

Rules are data. Identifiers must be plain names, module names must be package names or subpaths, and every object is strict, so an unknown key is an error. There are no expressions, regular expressions, selectors, or code fields. A YAML tag such as `!!js/function` loads as plain text and fails identifier validation. Compiled rules are round-tripped through canonical JSON, so they contain only inert data. The compiler reports every problem in every file together:
- unknown match kinds
- malformed identifiers or module names
- two callee roots
- undefined captures in conditions
- duplicate rule ids
- unknown or cyclic `instanceOf` targets
