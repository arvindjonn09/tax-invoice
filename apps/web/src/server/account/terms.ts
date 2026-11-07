import { legalDetailsMissing } from "../../content/legal/details";

/**
 * Versions of the Terms of Service and Privacy Policy users accept at sign-up
 * (S2 AC6). The owner approved this text on 7 November 2026 (#212). Production
 * sign-up stays closed while the business name or ABN is unset, or if a version
 * goes back to `placeholder-` (E5, ADR 0004).
 */
export const TERMS_VERSION = "2026-11-07";
export const PRIVACY_VERSION = "2026-11-07";

export function legalTextIsPlaceholder(): boolean {
  return (
    legalDetailsMissing() ||
    [TERMS_VERSION, PRIVACY_VERSION].some((version) =>
      version.startsWith("placeholder-"),
    )
  );
}
