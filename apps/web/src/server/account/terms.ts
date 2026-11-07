import { legalDetailsMissing } from "../../content/legal/details";

/**
 * Versions of the Terms of Service and Privacy Policy users accept at sign-up
 * (S2 AC6). The text is drafted (#212); these stay `placeholder-` until the owner
 * approves it. Production sign-up stays closed until then, and while the
 * business name or ABN is unset (E5, ADR 0004).
 */
export const TERMS_VERSION = "placeholder-2026-11";
export const PRIVACY_VERSION = "placeholder-2026-11";

export function legalTextIsPlaceholder(): boolean {
  return (
    legalDetailsMissing() ||
    [TERMS_VERSION, PRIVACY_VERSION].some((version) =>
      version.startsWith("placeholder-"),
    )
  );
}
