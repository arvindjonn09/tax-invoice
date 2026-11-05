/**
 * Versions of the Terms of Service and Privacy Policy users accept at sign-up
 * (S2 AC6). Placeholders until the owner supplies reviewed text; production
 * sign-up stays closed while either is a placeholder (E5, ADR 0004).
 */
export const TERMS_VERSION = "placeholder-2026-11";
export const PRIVACY_VERSION = "placeholder-2026-11";

export function legalTextIsPlaceholder(): boolean {
  return [TERMS_VERSION, PRIVACY_VERSION].some((version) =>
    version.startsWith("placeholder-"),
  );
}
