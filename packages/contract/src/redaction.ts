/**
 * Removes credentials from a dependency specifier or command, such as
 * `git+https://user:token@host/repo.git`. Fact documents never contain credentials.
 */
export function redactCredentials(text: string): string {
  return text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, "$1[redacted]@");
}
