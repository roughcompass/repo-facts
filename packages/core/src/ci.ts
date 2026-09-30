import { type BlobContent, type Detector, type DetectorContext, type Evidence, type ParsedFile, type Value, compareCodeUnits, pointerOf, redactCredentials } from "@repo-facts/contract";
import { inventoryOf, readableInputs, unanalyzedInputs } from "./inventory.js";
import { type JsonObject, isObject, manifestsOf, stringEntries } from "./manifests.js";
import { type RuntimeDeclaration, shareRuntimeInputs } from "./runtime.js";
import { nodeImageTag, nodeTagRange } from "./runtime-files.js";

/**
 * CI systems and declared verification commands, read from GitHub Actions
 * workflows, GitLab CI, Jenkinsfiles, Makefiles, the shell scripts those
 * reference, and package scripts. Every command is data: nothing discovered
 * here is ever run. Node.js versions set up by CI are handed to the runtime
 * detector.
 *
 * A search is complete only when every command could be read from syntax. A
 * Jenkinsfile is Groovy code, and GitLab `include`, `extends`, and merge keys
 * pull in configuration from elsewhere, so their presence leaves the command
 * search incomplete rather than claiming nothing else runs.
 */

const RULES = {
  definition: "ci.definition",
  githubRun: "ci.github-actions.run",
  githubSetupNode: "ci.github-actions.setup-node",
  githubContainer: "ci.github-actions.container",
  gitlabScript: "ci.gitlab.script",
  gitlabImage: "ci.gitlab.image",
  jenkinsStep: "ci.jenkins.step",
  jenkinsImage: "ci.jenkins.image",
  makeRecipe: "make.recipe",
  shellLine: "shell.command",
  packageScript: "manifest.verification-script",
} as const;

const CI_FORMATS = ["github-actions", "gitlab-ci", "jenkinsfile"] as const;
const UNSUPPORTED_CI = ["circleci", "azure-pipelines", "travis", "bitbucket-pipelines", "buildkite", "drone"];
const SYSTEMS: Record<(typeof CI_FORMATS)[number], string> = { "github-actions": "github-actions", "gitlab-ci": "gitlab-ci", jenkinsfile: "jenkins" };

/** Script and Make target names that conventionally run verification. */
const VERIFICATION_NAMES = /^(test|tests|lint|typecheck|type-check|check|verify|validate|build|e2e|ci|format:check|test:[\w:-]+|lint:[\w:-]+)$/;

/** Deterministic labels for what a command does, from the tools it names. */
const KINDS: readonly [string, RegExp][] = [
  ["e2e", /\b(playwright|cypress|testcafe|wdio|e2e)\b/],
  ["test", /\b(test|tests|vitest|jest|mocha|ava|tap|karma|jasmine|uvu)\b/],
  ["lint", /\b(lint|eslint|stylelint|biome)\b/],
  ["typecheck", /\b(tsc|typecheck|type-check|vue-tsc)\b/],
  ["build", /\b(build|webpack|rollup|rspack|tsup|esbuild|parcel)\b/],
  ["format", /\b(prettier|format)\b/],
  ["audit", /\b(npm|pnpm|yarn)\s+audit\b/],
];

export function commandKinds(command: string): string[] {
  return KINDS.filter(([, pattern]) => pattern.test(command)).map(([kind]) => kind);
}

interface Command {
  key: string;
  source: string;
  context: Record<string, Value>;
  command: string;
  evidence: Evidence;
  rule: string;
}

interface Search {
  surface: string[];
  skipped: string[];
  complete: boolean;
}

export const ciDetector: Detector = {
  id: "ci",
  version: "1",
  stage: "parse",
  inputs: [".github/workflows/*", ".gitlab-ci.yml", "**/Jenkinsfile", "**/Makefile", "**/*.sh", "**/package.json"],
  categories: ["ci_systems", "verification_commands"],
  async run(context) {
    const commands: Command[] = [];
    const declarations: RuntimeDeclaration[] = [];
    const definitions = { surface: [] as string[], skipped: unanalyzedInputs(context, ...CI_FORMATS, ...UNSUPPORTED_CI).map((input) => input.path) };
    const search: Search = { surface: [], skipped: [...definitions.skipped], complete: true };

    for (const input of readableInputs(context, ...CI_FORMATS)) {
      definitions.surface.push(input.path);
      search.surface.push(input.path);
      const format = input.format as (typeof CI_FORMATS)[number];
      if (format === "jenkinsfile") {
        const content = await context.text(input.path);
        if (!content) continue;
        jenkinsfile(context, content, commands, declarations);
        search.complete = false;
      } else {
        const parsed = await context.parsed(input.path, "yaml");
        if (!parsed || !isObject(parsed.value)) {
          if (parsed) context.diagnostic(input.path, "unsupported_shape", "The CI definition is not a mapping");
          definitions.skipped.push(input.path);
          search.skipped.push(input.path);
          continue;
        }
        if (format === "github-actions") githubActions(context, parsed, commands, declarations, search);
        else gitlabCi(context, parsed, commands, declarations, search);
      }
      context.fact({ category: "ci_systems", key: input.path, value: { system: SYSTEMS[format], path: input.path }, basis: "observed", evidence: [context.entry(context.reader.entry(input.path)!, RULES.definition)], rule: RULES.definition });
    }

    for (const input of inventoryOf(context).inputs.filter((item) => item.format === "makefile")) {
      const content = await context.text(input.path);
      search.surface.push(input.path);
      if (!content) {
        search.skipped.push(input.path);
        continue;
      }
      makefile(context, content, commands);
    }

    // Scripts can reference each other both ways, so shell scripts are followed before and after package scripts.
    const read = new Set<string>();
    await referencedShellScripts(context, commands, search, read);
    packageScripts(context, commands, search);
    await referencedShellScripts(context, commands, search, read);

    for (const command of commands) {
      context.fact({
        category: "verification_commands",
        key: command.key,
        value: { source: command.source, context: command.context, command: command.command, kinds: commandKinds(command.command) },
        basis: "observed",
        evidence: [command.evidence],
        rule: command.rule,
      });
    }
    const sorted = (paths: string[]) => [...new Set(paths)].sort(compareCodeUnits);
    context.search({ category: "ci_systems", rule: RULES.definition, surface: sorted(definitions.surface), complete: true, skipped: sorted(definitions.skipped) });
    context.search({ category: "verification_commands", rule: "ci.verification-commands", surface: sorted(search.surface), complete: search.complete, skipped: sorted(search.skipped) });
    shareRuntimeInputs(context, { declarations });
  },
};

function githubActions(context: DetectorContext, parsed: ParsedFile, commands: Command[], declarations: RuntimeDeclaration[], search: Search) {
  const path = parsed.content.entry.path;
  const workflow = parsed.value as JsonObject;
  const jobs = isObject(workflow.jobs) ? workflow.jobs : {};
  for (const jobId of Object.keys(jobs).sort(compareCodeUnits)) {
    const job = jobs[jobId];
    if (!isObject(job)) continue;
    // A job that calls a reusable workflow runs steps defined elsewhere.
    if (typeof job.uses === "string") search.complete = false;
    const matrix = isObject(job.strategy) && isObject(job.strategy.matrix) ? job.strategy.matrix : {};
    const image = typeof job.container === "string" ? { image: job.container, pointer: ["jobs", jobId, "container"] } : isObject(job.container) && typeof job.container.image === "string" ? { image: job.container.image, pointer: ["jobs", jobId, "container", "image"] } : null;
    if (image) addImage(context, parsed.content, image.image, "yaml", pointerOf(image.pointer), RULES.githubContainer, declarations);

    const steps = Array.isArray(job.steps) ? job.steps : [];
    steps.forEach((step, index) => {
      if (!isObject(step)) return;
      const label = typeof step.name === "string" ? step.name : String(index);
      if (typeof step.run === "string") {
        commands.push({ key: `${path}#${jobId}/${index}`, source: path, context: { job: jobId, step: label }, command: redactCredentials(step.run.trim()), evidence: context.pointer(parsed.content, RULES.githubRun, "yaml", pointerOf(["jobs", jobId, "steps", index, "run"])), rule: RULES.githubRun });
      }
      if (typeof step.uses === "string" && step.uses.startsWith("actions/setup-node@") && isObject(step.with)) {
        const version = step.with["node-version"];
        if (typeof version !== "string" && typeof version !== "number") return;
        const pointer = pointerOf(["jobs", jobId, "steps", index, "with", "node-version"]);
        const declared = matrixValues(String(version), matrix);
        declarations.push({ runtime: "node", declared: declared.join(" || "), path, evidence: context.pointer(parsed.content, RULES.githubSetupNode, "yaml", pointer), rule: RULES.githubSetupNode });
      }
    });
  }
}

/** Resolves `${{ matrix.key }}` against the job's matrix; a matrix lists alternatives, not requirements. */
function matrixValues(version: string, matrix: JsonObject): string[] {
  const reference = /^\$\{\{\s*matrix\.([A-Za-z0-9_-]+)\s*\}\}$/.exec(version.trim());
  if (!reference) return [version];
  const values = matrix[reference[1]!];
  return Array.isArray(values) && values.length && values.every((value) => typeof value === "string" || typeof value === "number") ? values.map(String) : [version];
}

const GITLAB_RESERVED = new Set(["stages", "variables", "default", "include", "workflow", "image", "services", "before_script", "after_script", "cache", "spec"]);
const GITLAB_SCRIPTS = ["before_script", "script", "after_script"];

function gitlabCi(context: DetectorContext, parsed: ParsedFile, commands: Command[], declarations: RuntimeDeclaration[], search: Search) {
  const path = parsed.content.entry.path;
  const document = parsed.value as JsonObject;
  if (document.include !== undefined) search.complete = false;
  const image = (value: Value | undefined, pointer: (string | number)[]) => {
    const name = typeof value === "string" ? value : isObject(value) && typeof value.name === "string" ? value.name : null;
    if (name) addImage(context, parsed.content, name, "yaml", pointerOf(typeof value === "string" ? pointer : [...pointer, "name"]), RULES.gitlabImage, declarations);
  };
  image(document.image, ["image"]);
  if (isObject(document.default)) image(document.default.image, ["default", "image"]);

  const scripts = (owner: string, block: JsonObject, prefix: string[]) => {
    for (const field of GITLAB_SCRIPTS) {
      const value = block[field];
      const lines = typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
      lines.forEach((line, index) => {
        if (typeof line !== "string") return;
        const pointer = typeof value === "string" ? [...prefix, field] : [...prefix, field, index];
        commands.push({ key: `${path}#${owner}/${field}/${index}`, source: path, context: { job: owner, section: field }, command: redactCredentials(line.trim()), evidence: context.pointer(parsed.content, RULES.gitlabScript, "yaml", pointerOf(pointer)), rule: RULES.gitlabScript });
      });
    }
  };
  if (isObject(document.default)) scripts("default", document.default, ["default"]);
  for (const name of Object.keys(document).sort(compareCodeUnits)) {
    const job = document[name];
    if (GITLAB_RESERVED.has(name) || !isObject(job)) continue;
    // Inherited configuration comes from elsewhere, so the commands found here may not be all of them.
    if (job.extends !== undefined || "<<" in job) search.complete = false;
    image(job.image, [name, "image"]);
    scripts(name, job, [name]);
  }
}

function addImage(context: DetectorContext, content: BlobContent, image: string, format: "yaml", pointer: string, rule: string, declarations: RuntimeDeclaration[]) {
  const tag = nodeImageTag(image);
  if (tag === null) return;
  const range = nodeTagRange(tag);
  declarations.push({ runtime: "node", declared: tag, ...(range !== null && { range }), path: content.entry.path, evidence: context.pointer(content, rule, format, pointer), rule });
}

/**
 * Jenkinsfile steps written as string literals: `sh 'cmd'`, `sh "cmd"`,
 * `sh(script: 'cmd')`, triple-quoted blocks, and `bat`/`powershell`.
 * Groovy is code, so this is never a complete search.
 */
function jenkinsfile(context: DetectorContext, content: BlobContent, commands: Command[], declarations: RuntimeDeclaration[]) {
  const path = content.entry.path;
  const lines = content.text!.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const image = /\bimage\s+['"]([^'"]+)['"]/.exec(line);
    if (image) {
      const tag = nodeImageTag(image[1]!);
      const range = tag === null ? null : nodeTagRange(tag);
      if (tag !== null) declarations.push({ runtime: "node", declared: tag, ...(range !== null && { range }), path, evidence: context.lines(content, RULES.jenkinsImage, index + 1), rule: RULES.jenkinsImage });
    }
    const triple = /\b(sh|bat|powershell)\s*\(?\s*(?:script\s*:\s*)?('''|""")(.*)$/.exec(line);
    if (triple) {
      const quote = triple[2]!;
      const body: string[] = [];
      let end = index;
      let rest = triple[3]!;
      while (!rest.includes(quote) && end + 1 < lines.length) {
        body.push(rest);
        rest = lines[++end]!;
      }
      body.push(rest.slice(0, rest.indexOf(quote) === -1 ? rest.length : rest.indexOf(quote)));
      const command = body.join("\n").trim();
      if (command) commands.push({ key: `${path}#${index + 1}`, source: path, context: { step: triple[1]! }, command: redactCredentials(command), evidence: context.lines(content, RULES.jenkinsStep, index + 1, end + 1), rule: RULES.jenkinsStep });
      index = end;
      continue;
    }
    const single = /\b(sh|bat|powershell)\s*\(?\s*(?:script\s*:\s*)?(['"])((?:\\.|(?!\2).)*)\2/.exec(line);
    if (single) commands.push({ key: `${path}#${index + 1}`, source: path, context: { step: single[1]! }, command: redactCredentials(single[3]!), evidence: context.lines(content, RULES.jenkinsStep, index + 1), rule: RULES.jenkinsStep });
  }
}

/** Recipes of Make targets that run verification, joined across line continuations. */
function makefile(context: DetectorContext, content: BlobContent, commands: Command[]) {
  const path = content.entry.path;
  const lines = content.text!.split("\n");
  let target: string | null = null;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const header = /^([A-Za-z0-9_./-]+)\s*:(?!=)/.exec(line);
    if (header) {
      target = header[1]!;
      continue;
    }
    if (!line.startsWith("\t") || target === null) {
      if (line.trim() !== "" && !line.startsWith("\t") && !line.startsWith("#")) target = null;
      continue;
    }
    const start = index;
    let recipe = line.trim();
    while (recipe.endsWith("\\") && index + 1 < lines.length) recipe = `${recipe.slice(0, -1).trim()} ${lines[++index]!.trim()}`;
    recipe = recipe.replace(/^[@+-]+/, "").trim();
    if (!recipe || (!VERIFICATION_NAMES.test(target) && commandKinds(recipe).length === 0)) continue;
    commands.push({ key: `${path}#${target}/${start + 1}`, source: path, context: { target }, command: redactCredentials(recipe), evidence: context.lines(content, RULES.makeRecipe, start + 1, index + 1), rule: RULES.makeRecipe });
  }
}

/** Shell scripts the commands found so far invoke, such as `./scripts/verify.sh`, read line by line. */
async function referencedShellScripts(context: DetectorContext, commands: Command[], search: Search, read: Set<string>) {
  const shells = new Set(inventoryOf(context).inputs.filter((input) => input.format === "shell").map((input) => input.path));
  const referenced = new Map<string, string[]>();
  for (const command of commands) {
    for (const match of command.command.matchAll(/(?:^|[\s;&|(])(?:bash\s+|sh\s+)?(?:\.\/)?([\w.-]+(?:\/[\w.-]+)*\.(?:sh|bash))\b/g)) {
      const path = match[1]!;
      if (shells.has(path) && !read.has(path)) referenced.set(path, [...(referenced.get(path) ?? []), command.key]);
    }
  }
  for (const [path, via] of [...referenced.entries()].sort(([a], [b]) => compareCodeUnits(a, b))) {
    read.add(path);
    search.surface.push(path);
    const content = await context.text(path);
    if (!content) {
      search.skipped.push(path);
      continue;
    }
    content.text!.split("\n").forEach((line, index) => {
      const command = line.trim();
      if (!command || command.startsWith("#") || /^set\s+-/.test(command)) return;
      commands.push({ key: `${path}#${index + 1}`, source: path, context: { script: path, via: [...new Set(via)].sort(compareCodeUnits) }, command: redactCredentials(command), evidence: context.lines(content, RULES.shellLine, index + 1), rule: RULES.shellLine });
    });
  }
}

/** Package scripts named for verification, or run by a command found so far (`npm test`, `pnpm run lint`). */
function packageScripts(context: DetectorContext, commands: Command[], search: Search) {
  if (commands.some((command) => command.rule === RULES.packageScript)) return;
  const { manifests, unanalyzed } = manifestsOf(context);
  const root = manifests.find((manifest) => manifest.path === "package.json");
  const invoked = new Map<string, string[]>();
  for (const command of commands) {
    for (const match of command.command.matchAll(/(?:^|[\s;&|(])(?:npm|pnpm|yarn)\s+(?:run(?:-script)?\s+)?([\w:.-]+)/g)) {
      const name = match[1]!;
      invoked.set(name, [...(invoked.get(name) ?? []), command.key]);
    }
  }
  const aliases: Record<string, string> = { t: "test", tst: "test" };
  search.surface.push(...manifests.map((manifest) => manifest.path));
  search.skipped.push(...unanalyzed);
  for (const manifest of manifests) {
    for (const [name, script] of stringEntries(manifest.value.scripts)) {
      const via = manifest === root ? [...(invoked.get(name) ?? []), ...Object.entries(aliases).flatMap(([alias, target]) => (target === name ? (invoked.get(alias) ?? []) : []))] : [];
      if (!VERIFICATION_NAMES.test(name) && via.length === 0) continue;
      commands.push({
        key: `${manifest.path}#scripts/${name}`,
        source: manifest.path,
        context: { script: name, via: [...new Set(via)].sort(compareCodeUnits) },
        command: redactCredentials(script),
        evidence: context.pointer(manifest.content, RULES.packageScript, "json", pointerOf(["scripts", name])),
        rule: RULES.packageScript,
      });
    }
  }
}
