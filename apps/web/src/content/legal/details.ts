/**
 * Business details the owner supplies before launch (#212). While any is
 * missing, the versions in server/account/terms.ts stay `placeholder-`, so
 * production sign-up stays closed.
 */
export const LEGAL_DETAILS = {
  legalName: "[legal business name]",
  abn: "[ABN]",
  state: "[Australian state or territory]",
  hostingLocation: "[country where JobFlow's servers are]",
  effectiveDate: "[date these terms take effect]",
} as const;
