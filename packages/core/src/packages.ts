import { compareCodeUnits, type Detector, type DetectorContext, type Evidence, pointerOf, redactCredentials } from "@repo-facts/contract";
import { DEPENDENCY_FIELDS } from "./knowledge.js";
import { type Manifest, isObject, manifestsOf, matchesWorkspacePattern, stringEntries } from "./manifests.js";

/**
 * Package identity, scripts, workspaces, and direct dependencies, read from
 * parsed manifests. Scripts and specifiers are reported as committed data and
 * never run or resolved; credentials in specifiers and commands are redacted.
 */

const RULES = {
  identity: "manifest.identity",
  scripts: "manifest.scripts",
  dependencies: "manifest.dependencies",
  npmWorkspaces: "manifest.workspaces",
  pnpmWorkspaces: "pnpm-workspace.packages",
} as const;

export const packageMetadataDetector: Detector = {
  id: "package-metadata",
  version: "1",
  stage: "convention",
  inputs: ["**/package.json", "**/pnpm-workspace.yaml"],
  categories: ["package_identity", "scripts", "dependencies", "workspaces"],
  async run(context) {
    const { manifests, unanalyzed } = manifestsOf(context);
    const surface = manifests.map((manifest) => manifest.path);

    for (const manifest of manifests) {
      reportIdentity(context, manifest);
      reportScripts(context, manifest);
      reportDependencies(context, manifest);
    }
    reportWorkspaces(context);

    const searches = [
      ["package_identity", RULES.identity],
      ["scripts", RULES.scripts],
      ["dependencies", RULES.dependencies],
    ] as const;
    for (const [category, rule] of searches) context.search({ category, rule, surface, complete: true, skipped: unanalyzed });
  },
};

const pointer = (context: DetectorContext, manifest: Manifest, rule: string, ...segments: string[]): Evidence => context.pointer(manifest.content, rule, "json", pointerOf(segments));

function reportIdentity(context: DetectorContext, manifest: Manifest) {
  const { name, version } = manifest.value;
  const evidence = [
    ...(typeof name === "string" ? [pointer(context, manifest, RULES.identity, "name")] : []),
    ...(typeof version === "string" ? [pointer(context, manifest, RULES.identity, "version")] : []),
  ];
  if (evidence.length === 0) return;
  context.fact({
    category: "package_identity",
    key: manifest.path,
    value: { manifest: manifest.path, name: typeof name === "string" ? name : null, version: typeof version === "string" ? version : null, private: manifest.value.private === true },
    basis: "observed",
    evidence,
    rule: RULES.identity,
  });
}

function reportScripts(context: DetectorContext, manifest: Manifest) {
  for (const [name, command] of stringEntries(manifest.value.scripts)) {
    context.fact({
      category: "scripts",
      key: `${manifest.path}#${name}`,
      value: { manifest: manifest.path, name, command: redactCredentials(command) },
      basis: "observed",
      evidence: [pointer(context, manifest, RULES.scripts, "scripts", name)],
      rule: RULES.scripts,
    });
  }
}

function reportDependencies(context: DetectorContext, manifest: Manifest) {
  for (const field of DEPENDENCY_FIELDS) {
    const declared = manifest.value[field];
    if (declared === undefined) continue;
    if (!isObject(declared)) {
      context.diagnostic(manifest.path, "unsupported_shape", `${field} is not an object`);
      continue;
    }
    for (const [name, specifier] of stringEntries(declared)) {
      context.fact({
        category: "dependencies",
        key: `${manifest.path}#${field}/${name}`,
        value: { manifest: manifest.path, field, name, specifier: redactCredentials(specifier) },
        basis: "observed",
        evidence: [pointer(context, manifest, RULES.dependencies, field, name)],
        rule: RULES.dependencies,
      });
    }
  }
}

interface WorkspaceDeclaration {
  directory: string;
  pattern: string;
  negated: boolean;
  evidence: Evidence;
  rule: string;
}

/** Workspace members: manifest directories matched by a workspace root's patterns. */
function reportWorkspaces(context: DetectorContext) {
  const { manifests, pnpmWorkspaces, unanalyzed } = manifestsOf(context);
  const declarations: WorkspaceDeclaration[] = [];

  for (const manifest of manifests) {
    const field = manifest.value.workspaces;
    // npm and Yarn accept a list, and Yarn classic also accepts { packages: [...] }.
    const [patterns, prefix] = Array.isArray(field) ? [field, ["workspaces"]] : isObject(field) && Array.isArray(field.packages) ? [field.packages, ["workspaces", "packages"]] : [null, []];
    if (field !== undefined && patterns === null) context.diagnostic(manifest.path, "unsupported_shape", "workspaces is neither a list nor an object with a packages list");
    (patterns ?? []).forEach((pattern, index) => {
      if (typeof pattern !== "string") return;
      declarations.push(declaration(manifest.directory, pattern, context.pointer(manifest.content, RULES.npmWorkspaces, "json", pointerOf([...prefix, index])), RULES.npmWorkspaces));
    });
  }
  for (const workspace of pnpmWorkspaces) {
    for (const { pattern, index } of workspace.packages) {
      declarations.push(declaration(workspace.directory, pattern, context.pointer(workspace.content, RULES.pnpmWorkspaces, "yaml", pointerOf(["packages", index])), RULES.pnpmWorkspaces));
    }
  }

  const byDirectory = new Map(manifests.map((manifest) => [manifest.directory, manifest]));
  const candidates = context.reader.entries.filter((entry) => entry.path.endsWith("/package.json") && (entry.type === "file" || entry.type === "executable"));
  for (const entry of candidates) {
    const directory = entry.path.slice(0, -"/package.json".length);
    const matching = declarations.filter((item) => isBelow(directory, item.directory) && matchesWorkspacePattern(relativeTo(directory, item.directory), item.pattern));
    const included = matching.filter((item) => !item.negated);
    if (included.length === 0 || matching.some((item) => item.negated)) continue;

    const member = byDirectory.get(directory);
    const name = typeof member?.value.name === "string" ? member.value.name : null;
    for (const item of included) {
      context.fact({
        category: "workspaces",
        key: directory,
        value: { directory, package: name },
        basis: "observed",
        evidence: [item.evidence, member && name !== null ? context.pointer(member.content, item.rule, "json", "/name") : context.entry(entry, item.rule)],
        rule: item.rule,
      });
    }
  }

  const surface = [...manifests.filter((manifest) => manifest.value.workspaces !== undefined).map((manifest) => manifest.path), ...pnpmWorkspaces.map((workspace) => workspace.path)].sort(compareCodeUnits);
  for (const rule of [RULES.npmWorkspaces, RULES.pnpmWorkspaces]) context.search({ category: "workspaces", rule, surface, complete: true, skipped: unanalyzed });
}

function declaration(directory: string, raw: string, evidence: Evidence, rule: string): WorkspaceDeclaration {
  const negated = raw.startsWith("!");
  return { directory, pattern: negated ? raw.slice(1) : raw, negated, evidence, rule };
}

function isBelow(directory: string, root: string): boolean {
  return root === "." ? directory !== "." : directory.startsWith(`${root}/`);
}

function relativeTo(directory: string, root: string): string {
  return root === "." ? directory : directory.slice(root.length + 1);
}
