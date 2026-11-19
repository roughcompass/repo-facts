import { type DesignSystemContent, type DesignSystemEntry, type EntrySource, type UnsealedEntry, entryProblems, sealEntry } from "@repo-facts/contract";
import semver from "semver";
import { declaredComponents } from "./declarations.js";
import { CatalogBuildError } from "./errors.js";
import { type Packument, type PublishedVersion, type RegistryOptions, fetchPackage, fetchPackument } from "./registry.js";
import { RULE_SECTIONS, parseRules } from "./rules.js";
import { readSaltData } from "./salt-data.js";
import type { PackageFiles } from "./tarball.js";
import type { CatalogThing } from "./thing.js";
import { declaredTokens } from "./tokens.js";

/**
 * Building one entry: a design system at one version, from three sources, in
 * order of precedence:
 * 1. its published packages at that version, read as data: components and
 *    props from its own package's declarations, tokens from the theme
 *    package's stylesheets, and icons from the icons package's exports;
 * 2. its own published data, for patterns, deprecations, and guidance, and
 *    never for anything version-specific;
 * 3. the team's rules.
 * Each section names the source that supplied it. The entry is validated
 * against the contract's schema and sealed with its digest; a build that
 * fails produces no entry.
 */

export interface BuildSources {
  /** The packages to read, by name: the design system's own, and its tokens and icons packages when the thing names them. */
  packages: ReadonlyMap<string, PackageFiles>;
  /** The design system's published data, when the thing names it. */
  data?: PackageFiles;
  /** The text of the team's rules, `catalog-rules/<id>.yaml`. */
  rules: string;
}

export interface BuildOptions {
  /** When the entry was built. It isn't part of the digest. */
  builtAt: string;
}

/** Builds the entry for +thing+ from sources already read, with no network access. Throws a CatalogBuildError when anything is missing or invalid. */
export function buildEntry(thing: CatalogThing, sources: BuildSources, options: BuildOptions): DesignSystemEntry {
  const rulesPath = `catalog-rules/${thing.id}.yaml`;
  const { rules, version: rulesVersion } = parseRules(sources.rules, rulesPath);
  const problems: string[] = [];
  if (rules.id !== thing.id) problems.push(`${rulesPath} describes ${rules.id}, not ${thing.id}`);
  for (const name of [thing.package, thing.tokens, thing.icons]) if (name && !rules.packages.includes(name)) problems.push(`${rulesPath} doesn't list ${name} among ${thing.id}'s packages`);
  const read = (name: string) => {
    const pkg = sources.packages.get(name);
    if (!pkg) problems.push(`${name} wasn't supplied`);
    return pkg;
  };
  const own = read(thing.package);
  const theme = thing.tokens ? read(thing.tokens) : undefined;
  const iconPackage = thing.icons ? read(thing.icons) : undefined;
  if (thing.data && !sources.data) problems.push(`${thing.data.package} wasn't supplied`);
  if (thing.tokens && !rules.token_prefix) problems.push(`${rulesPath} names no token_prefix, so tokens can't be read`);
  if (problems.length || !own) throw new CatalogBuildError("invalid_package", problems.join("; "), problems);

  const supplied = new Map<string, Set<string>>();
  const supply = (name: string, section: string) => supplied.set(name, (supplied.get(name) ?? new Set()).add(section));
  const content: DesignSystemContent = { name: rules.name };
  for (const section of RULE_SECTIONS) {
    if (rules[section] === undefined) continue;
    (content as Record<string, unknown>)[section] = rules[section];
    supply(rulesPath, section);
  }

  const components = declaredComponents(own).map((component) => ({ name: component.name, package: own.name, props: component.props }));
  if (components.length) {
    content.components = components;
    supply(own.name, "components");
  }
  if (theme && rules.token_prefix) {
    content.tokens = declaredTokens(theme, rules.token_prefix);
    supply(theme.name, "tokens");
  }
  if (iconPackage) {
    content.icons = declaredComponents(iconPackage).map((icon) => ({ name: icon.name, package: iconPackage.name }));
    supply(iconPackage.name, "icons");
  }

  const read_ = [own, theme, iconPackage].filter((pkg): pkg is PackageFiles => pkg !== undefined);
  const versions = new Map(read_.map((pkg) => [pkg.name, pkg.version]));
  let snapshotDate: string | null = null;
  if (thing.data && sources.data) {
    const names = new Set([...components.map((component) => component.name), ...(content.icons ?? []).map((icon) => icon.name)]);
    const data = readSaltData(sources.data, names, versions);
    snapshotDate = data.snapshotDate;
    for (const [section, value] of Object.entries(data.sections)) {
      (content as Record<string, unknown>)[section] = value;
      supply(sources.data.name, section);
    }
  }

  const sourceList: EntrySource[] = [
    ...read_.map((pkg) => ({ name: pkg.name, version: pkg.version, sections: [...(supplied.get(pkg.name) ?? [])] })),
    ...(thing.data && sources.data ? [{ name: sources.data.name, version: sources.data.version, ...(snapshotDate && { snapshot_date: snapshotDate }), sections: [...(supplied.get(sources.data.name) ?? [])] }] : []),
    { name: rulesPath, version: rulesVersion, sections: [...(supplied.get(rulesPath) ?? [])] },
  ];
  const unsealed = {
    schema: "reference_catalog.entry",
    format_version: 1,
    kind: "design_system",
    id: thing.id,
    version: own.version,
    packages: [own.name, ...rules.packages.filter((name) => name !== own.name)].map((name) => (versions.has(name) ? { name, version: versions.get(name)! } : { name })),
    built_at: options.builtAt,
    sources: sourceList,
    content,
  } as UnsealedEntry;
  const entry = sealEntry(unsealed) as DesignSystemEntry;
  const invalid = entryProblems(entry);
  if (invalid.length) throw new CatalogBuildError("invalid_entry", `The ${thing.id} ${own.version} entry isn't valid: ${invalid.slice(0, 3).join("; ")}`, invalid);
  return entry;
}

export interface RegistryBuildOptions extends RegistryOptions {
  /** The text of the team's rules for the thing. */
  rules: string;
  /** Exact versions to read for the tokens, icons, or data packages, by name, in place of the ones chosen for the release. */
  versions?: Readonly<Record<string, string>>;
  /** The time the build is recorded at. Defaults to now. */
  now?: () => Date;
}

/**
 * Builds the entry for +thing+ at +version+ from the configured registry:
 * its own package at exactly that version, and its tokens and icons packages
 * at the versions released with it (see companionVersion), and the newest of
 * its published data. Nothing in a package is run.
 */
export async function buildFromRegistry(thing: CatalogThing, version: string, options: RegistryBuildOptions): Promise<DesignSystemEntry> {
  const ownPackument = await fetchPackument(thing.package, options);
  const own = await fetchPackage(ownPackument, version, options);
  const packages = new Map<string, PackageFiles>([[own.name, own]]);
  for (const name of [thing.tokens, thing.icons]) {
    if (!name || packages.has(name)) continue;
    const packument = await fetchPackument(name, options);
    packages.set(name, await fetchPackage(packument, options.versions?.[name] ?? companionVersion(ownPackument.versions.get(version)!, packument), options));
  }
  let data: PackageFiles | undefined;
  if (thing.data) {
    const packument = await fetchPackument(thing.data.package, options);
    data = await fetchPackage(packument, options.versions?.[thing.data.package] ?? newestVersion(packument), options);
  }
  return buildEntry(thing, { packages, ...(data && { data }), rules: options.rules }, { builtAt: (options.now?.() ?? new Date()).toISOString() });
}

/**
 * The version of a companion package, such as the theme or icons, released
 * with +release+: the lowest published version in the range +release+
 * declares for it as a dependency or peer dependency, or, when it declares
 * none, the highest release published no later than +release+.
 */
export function companionVersion(release: PublishedVersion, companion: Packument): string {
  const published = [...companion.versions.values()];
  const range = companion.name in release.dependencies ? release.dependencies[companion.name] : release.peerDependencies[companion.name];
  const valid = range !== undefined ? semver.validRange(range) : null;
  const releases = published.filter((item) => semver.prerelease(item.version) === null);
  const chosen = valid
    ? semver.minSatisfying(releases.map((item) => item.version), valid)
    : semver.maxSatisfying(releases.filter((item) => item.time !== null && release.time !== null && item.time <= release.time).map((item) => item.version), "*");
  if (!chosen) throw new CatalogBuildError("not_found", `No version of ${companion.name} was released with ${release.version}`);
  return chosen;
}

/** The most recently published version, or the highest when the registry records no times. */
export function newestVersion(packument: Packument): string {
  const published = [...packument.versions.values()];
  if (!published.length) throw new CatalogBuildError("not_found", `${packument.name} has no published versions`);
  const timed = published.filter((item) => item.time !== null).sort((a, b) => (a.time! < b.time! ? 1 : a.time! > b.time! ? -1 : semver.rcompare(a.version, b.version)));
  return timed[0]?.version ?? [...published].sort((a, b) => semver.rcompare(a.version, b.version))[0]!.version;
}
