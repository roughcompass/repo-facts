#!/usr/bin/env node
/**
 * Writes the generated sections of packages/design-system/catalogs/salt.yaml
 * from installed Salt packages:
 * - generated_from: the versions of @salt-ds/core and @salt-ds/theme read
 * - the components @salt-ds/core exports, from its type declarations
 * - tokens: every custom property @salt-ds/theme's stylesheets define
 *
 * Curated sections and comments are kept. Nothing reads packages at analysis
 * time; run `npm run rules:compile` afterward to compile the catalog.
 *
 * Usage: node scripts/catalog-salt.mjs <node_modules>
 */
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import YAML from "yaml";

const CATALOG = path.resolve(import.meta.dirname, "../packages/design-system/catalogs/salt.yaml");
const TOKEN_PREFIX = "--salt-";

const [modules] = process.argv.slice(2);
if (!modules) {
  console.error("Usage: node scripts/catalog-salt.mjs <node_modules>");
  process.exit(2);
}

const packageDirectory = (name) => {
  const directory = path.resolve(modules, name);
  if (!fs.existsSync(path.join(directory, "package.json"))) throw new Error(`${name} is not installed under ${modules}`);
  return directory;
};
const manifestOf = (directory) => JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8"));

const core = packageDirectory("@salt-ds/core");
const theme = packageDirectory("@salt-ds/theme");

/** The exported names of a declaration file, following `export *` and `export { } from`, with each export's declaration. */
function exportsOf(file, seen = new Set()) {
  const exports = new Map();
  if (seen.has(file)) return exports;
  seen.add(file);
  const source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const exported = (node) => ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Export;
  for (const statement of source.statements) {
    if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
      if (statement.isTypeOnly) continue;
      const target = resolveDeclarations(path.dirname(file), statement.moduleSpecifier.text);
      if (!target) continue;
      const inner = exportsOf(target, seen);
      if (!statement.exportClause) {
        for (const [name, declaration] of inner) if (name !== "default") exports.set(name, declaration);
      } else if (ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) {
          if (element.isTypeOnly) continue;
          const declaration = inner.get((element.propertyName ?? element.name).text);
          if (declaration) exports.set(element.name.text, declaration);
        }
      }
    } else if (ts.isVariableStatement(statement) && exported(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) exports.set(declaration.name.text, { kind: "const", type: declaration.type, source, aliases: aliasesOf(source) });
      }
    } else if (ts.isFunctionDeclaration(statement) && exported(statement) && statement.name) {
      exports.set(statement.name.text, { kind: "function", type: statement.type, source, aliases: aliasesOf(source) });
    } else if (ts.isClassDeclaration(statement) && exported(statement) && statement.name) {
      exports.set(statement.name.text, { kind: "class", node: statement, source });
    }
  }
  return exports;
}

function resolveDeclarations(directory, specifier) {
  const base = path.resolve(directory, specifier);
  for (const candidate of [`${base}.d.ts`, path.join(base, "index.d.ts")]) if (fs.existsSync(candidate)) return candidate;
  return null;
}

/** Type aliases declared in a file, by name, for `const FlexLayout: FlexLayoutComponent`. */
function aliasesOf(source) {
  const aliases = new Map();
  for (const statement of source.statements) if (ts.isTypeAliasDeclaration(statement)) aliases.set(statement.name.text, statement.type);
  return aliases;
}

const COMPONENT_TYPES = /\b(ForwardRefExoticComponent|NamedExoticComponent|MemoExoticComponent|ExoticComponent|FunctionComponent|FC|ComponentType)\b/;
const RENDERS = /\b(JSX\.Element|ReactElement|ReactNode)\b/;

/** Whether an export's declared type is a React component. */
function isComponent(declaration, exports, depth = 0) {
  if (depth > 4) return false;
  if (declaration.kind === "class") return (declaration.node.heritageClauses ?? []).some((clause) => /\b(Component|PureComponent)\b/.test(clause.getText(declaration.source)));
  const type = declaration.type;
  if (!type) return false;
  const text = type.getText(declaration.source);
  if (declaration.kind === "function") return RENDERS.test(text);
  if (COMPONENT_TYPES.test(text)) return true;
  if (ts.isFunctionTypeNode(type)) return RENDERS.test(type.type.getText(declaration.source));
  if (ts.isTypeQueryNode(type) && ts.isIdentifier(type.exprName)) {
    const target = exports.get(type.exprName.text);
    return target ? isComponent(target, exports, depth + 1) : false;
  }
  if (ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName)) {
    const alias = declaration.aliases.get(type.typeName.text);
    if (alias) return isComponent({ ...declaration, type: alias }, exports, depth + 1);
    return /Component$/.test(type.typeName.text);
  }
  return false;
}

const typesEntry = (directory) => {
  const manifest = manifestOf(directory);
  return path.join(directory, manifest.types ?? manifest.typings ?? "index.d.ts");
};
const coreExports = exportsOf(typesEntry(core));
const components = [...coreExports]
  .filter(([name, declaration]) => /^[A-Z][A-Za-z0-9]*$/.test(name) && isComponent(declaration, coreExports))
  .map(([name]) => name)
  .sort();

/** Every custom property a stylesheet defines, read from its declarations; comments are dropped first. */
function definedProperties(text) {
  const names = new Set();
  const uncommented = text.replace(/\/\*[\s\S]*?\*\//g, " ");
  for (const match of uncommented.matchAll(/(?:^|[{;\s])(--[A-Za-z0-9-]+)\s*:/g)) names.add(match[1]);
  return names;
}

function stylesheetsUnder(directory) {
  const found = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory() && entry.name !== "node_modules") found.push(...stylesheetsUnder(full));
    else if (entry.isFile() && entry.name.endsWith(".css")) found.push(full);
  }
  return found.sort();
}

const tokens = new Set();
for (const file of stylesheetsUnder(theme)) for (const name of definedProperties(fs.readFileSync(file, "utf8"))) if (name.startsWith(TOKEN_PREFIX)) tokens.add(name);

const document = YAML.parseDocument(fs.readFileSync(CATALOG, "utf8"));
const flow = (values) => {
  const node = document.createNode(values);
  node.flow = false;
  return node;
};
document.set("generated_from", document.createNode({ "@salt-ds/core": manifestOf(core).version, "@salt-ds/theme": manifestOf(theme).version }));
const packages = document.get("packages");
const corePackage = packages.items.find((item) => item.get("name") === "@salt-ds/core");
if (!corePackage) throw new Error(`${CATALOG} does not list @salt-ds/core`);
corePackage.set("components", flow(components));
document.set("tokens", flow([...tokens].sort()));
fs.writeFileSync(CATALOG, document.toString({ lineWidth: 0 }));

console.log(`Wrote ${path.relative(process.cwd(), CATALOG)}: @salt-ds/core ${manifestOf(core).version} (${components.length} components), @salt-ds/theme ${manifestOf(theme).version} (${tokens.size} tokens)`);
