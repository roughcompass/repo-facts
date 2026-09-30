// Lockstep releases of every @repo-facts package.
//
//   node scripts/release.mjs version <version>   set one version everywhere
//   node scripts/release.mjs publish [--dry-run] publish HEAD
//
// `version` rewrites every package manifest and the lockfile; commit the
// result. `publish` refuses a dirty tree, clones HEAD into a temporary
// directory, installs from the lockfile with scripts disabled, runs every
// gate there, records provenance in each package, and publishes packages in
// dependency order to REPO_FACTS_NPM_REGISTRY.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import semver from "semver";
import { ROOT, authConfig } from "./lib/registry.mjs";

const SCOPE = "@repo-facts/";

export function packageDirectories(root) {
  return fs
    .readdirSync(path.join(root, "packages"))
    .map((name) => path.join(root, "packages", name))
    .filter((directory) => fs.existsSync(path.join(directory, "package.json")));
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const writeJson = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);

/** Packages ordered so each follows every internal package it depends on. */
export function publicationOrder(root) {
  const manifests = new Map(packageDirectories(root).map((directory) => [readJson(path.join(directory, "package.json")).name, directory]));
  const ordered = [];
  const visiting = new Set();
  const visit = (name) => {
    if (ordered.includes(name)) return;
    if (visiting.has(name)) throw new Error(`Internal dependency cycle at ${name}`);
    visiting.add(name);
    const manifest = readJson(path.join(manifests.get(name), "package.json"));
    for (const dependency of Object.keys(manifest.dependencies ?? {}).sort()) if (manifests.has(dependency)) visit(dependency);
    visiting.delete(name);
    ordered.push(name);
  };
  for (const name of [...manifests.keys()].sort()) visit(name);
  return ordered.map((name) => ({ name, directory: manifests.get(name) }));
}

const RELEASE_MODULE = path.join("packages", "bundle", "src", "release.ts");
const releaseModule = (version) => `// Written by \`npm run release:version\`; the lockstep check verifies it matches package.json.\nexport const DETECTOR_RELEASE = ${JSON.stringify(version)};\n`;

/** Problems that make a tree unreleasable at +version+: mixed versions or ranged internal dependencies. */
export function lockstepProblems(root, version) {
  const problems = [];
  if (fs.readFileSync(path.join(root, RELEASE_MODULE), "utf8") !== releaseModule(version)) problems.push(`${RELEASE_MODULE} does not declare DETECTOR_RELEASE ${version}`);
  for (const directory of packageDirectories(root)) {
    const manifest = readJson(path.join(directory, "package.json"));
    if (manifest.version !== version) problems.push(`${manifest.name} is at ${manifest.version}, not ${version}`);
    for (const [dependency, range] of Object.entries(manifest.dependencies ?? {})) {
      if (dependency.startsWith(SCOPE) && range !== version) problems.push(`${manifest.name} depends on ${dependency}@${range}, not exactly ${version}`);
    }
  }
  return problems;
}

/** Lockfile entries for @repo-facts packages that record a registry URL. */
export function pinnedRegistryEntries(root) {
  const lock = readJson(path.join(root, "package-lock.json"));
  return Object.entries(lock.packages ?? {})
    .filter(([key, entry]) => key.includes(`node_modules/${SCOPE}`) && !entry.link && typeof entry.resolved === "string")
    .map(([key]) => key);
}

function setVersion(root, version) {
  if (!semver.valid(version)) throw new Error(`${version} is not a semantic version`);
  for (const directory of packageDirectories(root)) {
    const file = path.join(directory, "package.json");
    const manifest = readJson(file);
    manifest.version = version;
    for (const dependency of Object.keys(manifest.dependencies ?? {})) if (dependency.startsWith(SCOPE)) manifest.dependencies[dependency] = version;
    writeJson(file, manifest);
  }
  fs.writeFileSync(path.join(root, RELEASE_MODULE), releaseModule(version));
  run(root, "npm", ["install", "--package-lock-only", "--ignore-scripts"], { timeout: 5 * MINUTE });
}

const MINUTE = 60_000;

function run(cwd, command, args, { env = process.env, timeout = 10 * MINUTE, capture = false } = {}) {
  const result = spawnSync(command, args, { cwd, env, timeout, encoding: "utf8", stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit" });
  if (result.error?.code === "ETIMEDOUT") throw new Error(`${command} ${args.join(" ")} did not finish within ${timeout / MINUTE} minutes in ${cwd}`);
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed in ${cwd}`);
  return result.stdout;
}

/** Files npm would publish for the package in +directory+; never contacts a registry. */
function packedFiles(directory) {
  const [pack] = JSON.parse(run(directory, "npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { timeout: 2 * MINUTE, capture: true }));
  return pack.files.map((file) => file.path).sort();
}

const PUBLISHABLE = /^(dist\/.+\.(js|d\.ts|js\.map|d\.ts\.map)|package\.json|provenance\.json|README\.md|LICENSE)$/;

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

const SNAPSHOT_IDENTITY = ["-c", "user.name=repo-facts dry run", "-c", "user.email=dry-run@repo-facts.invalid"];

/**
 * A dry run of uncommitted work checks out a snapshot of the working tree
 * (every tracked and unignored file), committed only inside the temporary
 * checkout. Real publication always requires a clean, committed tree.
 */
function snapshotWorkingTree(root, checkout) {
  const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
  execFileSync("git", ["init", "--quiet", "-b", "snapshot", checkout]);
  for (const file of files) {
    const source = path.join(root, file);
    const stat = fs.lstatSync(source, { throwIfNoEntry: false });
    if (!stat) continue;
    fs.mkdirSync(path.dirname(path.join(checkout, file)), { recursive: true });
    // Symbolic links are recreated as links; following one would copy content from outside the repository.
    if (stat.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(source), path.join(checkout, file));
    else fs.copyFileSync(source, path.join(checkout, file));
  }
  execFileSync("git", [...SNAPSHOT_IDENTITY, "add", "--all"], { cwd: checkout });
  execFileSync("git", [...SNAPSHOT_IDENTITY, "commit", "--quiet", "-m", "Working tree snapshot for a release dry run"], { cwd: checkout });
  return git(checkout, "rev-parse", "HEAD");
}

function publish(root, { dryRun }) {
  if (!dryRun && !process.env.REPO_FACTS_NPM_REGISTRY) throw new Error("REPO_FACTS_NPM_REGISTRY is not set");
  const dirty = git(root, "status", "--porcelain", "--untracked-files=normal");
  const hasHead = spawnSync("git", ["rev-parse", "--verify", "--quiet", "HEAD"], { cwd: root }).status === 0;
  if (!dryRun && dirty) throw new Error(`Refusing to release a dirty tree:\n${dirty}`);
  if (!dryRun && !hasHead) throw new Error("Refusing to release a repository with no commits");

  const checkout = fs.mkdtempSync(path.join(os.tmpdir(), "repo-facts-release-"));
  try {
    let commit;
    if (dirty || !hasHead) {
      console.log("Dry run of the uncommitted working tree.");
      commit = snapshotWorkingTree(root, checkout);
    } else {
      commit = git(root, "rev-parse", "HEAD");
      execFileSync("git", ["clone", "--quiet", "--no-hardlinks", root, checkout]);
      git(checkout, "checkout", "--quiet", "--detach", commit);
    }

    const version = readJson(path.join(checkout, "packages", "contract", "package.json")).version;
    const problems = [...lockstepProblems(checkout, version), ...pinnedRegistryEntries(checkout).map((key) => `package-lock.json pins ${key} to a registry URL`)];
    if (problems.length) throw new Error(`Refusing to release:\n- ${problems.join("\n- ")}`);

    if (dryRun) {
      // A dry run reuses installed tooling: it proves the tree builds and packs cleanly.
      fs.symlinkSync(path.join(root, "node_modules"), path.join(checkout, "node_modules"));
    } else {
      // Publication gates run against a fresh install of exactly what HEAD records.
      run(checkout, "npm", ["ci", "--ignore-scripts"]);
      run(checkout, "npm", ["run", "verify"], { timeout: 20 * MINUTE });
    }
    run(checkout, "npm", ["run", "build"]);

    for (const { directory } of publicationOrder(checkout)) {
      const manifest = readJson(path.join(directory, "package.json"));
      writeJson(path.join(directory, "provenance.json"), { package: manifest.name, version, commit });
      manifest.files = [...new Set([...(manifest.files ?? []), "provenance.json"])];
      manifest.repoFacts = { commit, release: version };
      writeJson(path.join(directory, "package.json"), manifest);
    }

    const order = publicationOrder(checkout);
    for (const { name, directory } of order) {
      const unexpected = packedFiles(directory).filter((file) => !PUBLISHABLE.test(file));
      if (unexpected.length) throw new Error(`Refusing to release ${name}; it would publish ${unexpected.join(", ")}`);
    }

    if (dryRun) {
      for (const { name } of order) console.log(`Would publish ${name}@${version} from ${commit}`);
    } else {
      const auth = authConfig();
      try {
        const tag = semver.prerelease(version) ? "next" : "latest";
        for (const { name, directory } of order) {
          console.log(`Publishing ${name}@${version} (${tag}) from ${commit}`);
          run(directory, "npm", ["publish", "--tag", tag, "--userconfig", auth.file], { timeout: 2 * MINUTE });
        }
      } finally {
        auth.cleanup();
      }
    }
    return { version, commit };
  } finally {
    fs.rmSync(checkout, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [command, argument] = process.argv.slice(2);
  try {
    if (command === "version" && argument) setVersion(ROOT, argument);
    else if (command === "publish") {
      const { version, commit } = publish(ROOT, { dryRun: process.argv.includes("--dry-run") });
      console.log(`Released ${version} from ${commit}`);
    } else {
      console.error("Usage: node scripts/release.mjs version <version> | publish [--dry-run]");
      process.exit(2);
    }
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
