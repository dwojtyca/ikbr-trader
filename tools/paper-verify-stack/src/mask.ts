/**
 * PR15.1 — masker for account IDs and any string that
 * happens to equal the configured Bearer token. Applied to
 * every user-facing render (table + JSON + error strings).
 */

const ACCOUNT_ID_PATTERN =
  /\b(D[UF]|U|F)(\d{2,})(\d{3})\b/g;

export function maskAccountId(value: string): string {
  return value.replace(
    ACCOUNT_ID_PATTERN,
    (_m, prefix: string, _mid: string, tail: string) =>
      `${prefix}-***${tail}`,
  );
}

/**
 * Return a redactor that scrubs the given secret from any
 * output string. `secret` may be undefined; then no-op.
 */
export function createRedactor(secret: string | undefined) {
  const s = typeof secret === "string" && secret.length > 0 ? secret : null;
  return function redact(value: string): string {
    let out = maskAccountId(value);
    if (s !== null) {
      // Replace every literal occurrence of the secret with
      // a fixed marker; never emit the value itself.
      while (out.includes(s)) {
        out = out.replace(s, "[REDACTED]");
      }
    }
    return out;
  };
}
