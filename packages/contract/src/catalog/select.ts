import semver from "semver";
import { ENTRY_FORMAT_VERSION, type EntryKind, type ReferenceCatalogEntry } from "./entry.js";

/**
 * Which entry a repository is compared against. Surveyor calls this for each
 * thing a repository uses, and the Frontend Registry calls it again with the
 * same wanted version to decide whether a survey's entries are still the ones
 * a survey would pick now.
 */

export interface WantedVersion {
  kind: EntryKind;
  id: string;
  /**
   * The package whose version is wanted. Entries record the version of each
   * package they were built from, so a repository that resolves only
   * `@salt-ds/theme` is matched by its theme version. Omitted, the thing's
   * own version: the version of each entry's first package.
   */
  package?: string;
  /** The wanted version, or null when the repository names none: then the newest entry. */
  version: string | null;
}

/**
 * The entry for +wanted+: the entry at exactly the wanted version, else the
 * nearest earlier version, else null. Versions compare by semantic-version
 * precedence, so `1.76.0-rc.1` is earlier than `1.76.0`. Only entries of the
 * wanted kind and id, in a format this release reads, and recording a version
 * for the wanted package, are candidates. When several candidates share the
 * chosen version, the one with the higher entry version wins, then the later
 * build, then the lower digest, so the choice never depends on input order.
 */
export function selectEntry<E extends ReferenceCatalogEntry>(entries: readonly E[], wanted: WantedVersion): E | null {
  const wantedVersion = wanted.version === null ? null : semver.valid(wanted.version);
  if (wanted.version !== null && wantedVersion === null) return null;
  const candidates: { entry: E; version: string }[] = [];
  for (const entry of entries) {
    if (entry.kind !== wanted.kind || entry.id !== wanted.id || entry.format_version !== ENTRY_FORMAT_VERSION) continue;
    const recorded = wanted.package === undefined ? entry.version : entry.packages.find((item) => item.name === wanted.package)?.version;
    const version = recorded === undefined ? null : semver.valid(recorded);
    if (version === null) continue;
    if (wantedVersion === null || semver.lte(version, wantedVersion)) candidates.push({ entry, version });
  }
  candidates.sort(
    (a, b) =>
      semver.compare(b.version, a.version) ||
      semver.compare(b.entry.version, a.entry.version) ||
      (a.entry.built_at < b.entry.built_at ? 1 : a.entry.built_at > b.entry.built_at ? -1 : 0) ||
      (a.entry.digest < b.entry.digest ? -1 : a.entry.digest > b.entry.digest ? 1 : 0),
  );
  return candidates[0]?.entry ?? null;
}
