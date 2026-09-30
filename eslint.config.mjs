import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

// Detectors analyze untrusted repositories. Package source may read content
// only through a SourceReader and may never execute, load, or contact
// anything. These rules enforce that for every package; see
// docs/detector-contract.md and the analysis-safety spec.

const executionMessage = "repo-facts never executes, loads, or evaluates data.";
const isolationMessage = "Detectors see repository content only through a SourceReader, with no network, filesystem, process, Git, or database access.";

const nodeModules = (names) => names.flatMap((name) => [name, `node:${name}`]);

// Never importable, not even for types: they exist to run code or start processes.
const executionModules = nodeModules(["vm", "module", "child_process", "worker_threads", "cluster", "inspector"]);
// Ambient capabilities. Type-only imports are erased and allowed.
const capabilityModules = nodeModules(["dns", "http", "http2", "https", "net", "tls", "dgram", "fs", "fs/promises", "readline"]);
// Third-party clients for the same capabilities.
const capabilityPackages = ["axios", "got", "ky", "node-fetch", "undici", "ws", "better-sqlite3", "sqlite3", "pg", "mysql2", "drizzle-orm", "simple-git", "isomorphic-git", "nodegit", "dotenv"];

const restricted = (names, message, allowTypeImports = false) => names.map((name) => ({ name, message, ...(allowTypeImports && { allowTypeImports }) }));

const capabilityGlobals = ["fetch", "WebSocket", "XMLHttpRequest", "EventSource", "process", "require"];

export default tseslint.config(
  {
    // Fixture trees are repository content under test, not repo-facts source.
    ignores: ["**/dist/**", "**/node_modules/**", "coverage/**", "tmp/**", "fixtures/**"],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["scripts/**/*.mjs"],
    languageOptions: { globals: { process: "readonly", console: "readonly", fetch: "readonly", URL: "readonly", setTimeout: "readonly", Buffer: "readonly" } },
  },
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  {
    files: ["packages/*/src/**/*.ts"],
    // Declared so no-implied-eval recognizes string arguments to timers.
    languageOptions: { globals: { setTimeout: "readonly", setInterval: "readonly", setImmediate: "readonly" } },
    rules: {
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-new-func": "error",
      "no-restricted-imports": "off",
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          paths: [
            ...restricted(executionModules, executionMessage),
            ...restricted(capabilityModules, isolationMessage, true),
            ...restricted(capabilityPackages, isolationMessage, true),
          ],
          patterns: [{ group: ["drizzle-orm/*", "dotenv/*", "undici/*"], message: isolationMessage, allowTypeImports: true }],
        },
      ],
      "no-restricted-globals": ["error", ...capabilityGlobals.map((name) => ({ name, message: isolationMessage }))],
      "no-restricted-properties": [
        "error",
        ...capabilityGlobals.flatMap((property) => ["globalThis", "global", "self", "window"].map((object) => ({ object, property, message: isolationMessage }))),
        { object: "Reflect", property: "construct", message: executionMessage },
      ],
      "no-restricted-syntax": [
        "error",
        { selector: "ImportExpression", message: `import() is forbidden in package source. ${executionMessage}` },
        { selector: "NewExpression[callee.name='RegExp'][arguments.0.type!='Literal']", message: `RegExp must be built from a literal pattern, never from data. ${executionMessage}` },
        { selector: "CallExpression[callee.name='RegExp'][arguments.0.type!='Literal']", message: `RegExp must be built from a literal pattern, never from data. ${executionMessage}` },
        { selector: "MemberExpression[object.name='Function'][property.name='constructor']", message: executionMessage },
        { selector: "MemberExpression[property.name='constructor'][parent.type='CallExpression']", message: `Calling a constructor property can reach Function. ${executionMessage}` },
      ],
    },
  },
);
