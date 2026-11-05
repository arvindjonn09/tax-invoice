// The addresses users see (ADR 0004 D7). No next/server imports, so pure
// modules and tests can use it. A blank value falls back to the default.
export const DEFAULT_SUPPORT_EMAIL = "admin@shivomsangha.com";

/** Support and reply address shown to users. */
export function supportEmail(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  return env.SUPPORT_EMAIL?.trim() || DEFAULT_SUPPORT_EMAIL;
}
