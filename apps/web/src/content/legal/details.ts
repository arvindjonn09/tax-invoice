type Env = Readonly<Record<string, string | undefined>>;

/**
 * The business behind JobFlow, for /terms and /privacy (#212). The name and ABN
 * come from the environment: the repository is public and never holds a real ABN.
 */
export function legalDetails(env: Env = process.env) {
  return {
    legalName: env.LEGAL_BUSINESS_NAME?.trim() || "[legal business name]",
    abn: env.LEGAL_ABN?.trim() || "[ABN]",
    state: "New South Wales",
    hostingLocation: "Australia",
    effectiveDate: "[date these terms take effect]",
  };
}

/** Production sign-up stays closed until the business is named (#212). */
export function legalDetailsMissing(env: Env = process.env): boolean {
  return !env.LEGAL_BUSINESS_NAME?.trim() || !env.LEGAL_ABN?.trim();
}
