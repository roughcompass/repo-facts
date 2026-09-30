/**
 * Committed files that commonly hold credentials or secret values. The
 * read policy never admits their bytes; detectors can see only that they
 * exist, from the tree listing.
 */

export interface SensitiveFormat {
  format: string;
  label: string;
}

const KEY_EXTENSIONS = ["pem", "key", "p12", "pfx", "jks", "keystore"];
const KEY_PREFIXES = ["id_rsa", "id_dsa", "id_ecdsa", "id_ed25519"];

export function sensitiveFormat(path: string): SensitiveFormat | null {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const lower = name.toLowerCase();
  if (lower === ".npmrc") return { format: "npmrc", label: "npm configuration" };
  if (lower === ".yarnrc" || lower === ".yarnrc.yml") return { format: "yarnrc", label: "Yarn configuration" };
  if (lower === ".env" || lower.startsWith(".env.")) return { format: "env-file", label: "Environment file" };
  if (lower === ".netrc" || lower === "_netrc") return { format: "netrc", label: "netrc credentials" };
  if (lower === ".pypirc" || lower === ".git-credentials") return { format: "credentials", label: "Credential file" };
  if (KEY_PREFIXES.some((prefix) => lower.startsWith(prefix)) || KEY_EXTENSIONS.some((extension) => lower.endsWith(`.${extension}`) && lower.length > extension.length + 1)) {
    return { format: "private-key", label: "Key or certificate bundle" };
  }
  return null;
}

export function isSensitivePath(path: string): boolean {
  return sensitiveFormat(path) !== null;
}
