import { type Page, expect, test } from "@playwright/test";

export type E2eRole =
  "owner" | "manager" | "accountant" | "employee" | "subcontractor";

export type E2eAccounts = {
  password: string;
  emails: Record<E2eRole, string>;
};

/** Set by global-setup.ts for this run only. */
export const E2E_ACCOUNTS_ENV = "JOBFLOW_E2E_ACCOUNTS";

export function e2eAccounts(): E2eAccounts | null {
  const raw = process.env[E2E_ACCOUNTS_ENV];
  return raw ? (JSON.parse(raw) as E2eAccounts) : null;
}

/** Skip the current file's tests when no database is configured. */
export function requireAccounts(): E2eAccounts {
  const accounts = e2eAccounts();
  test.skip(!accounts, "Signed-in tests need DATABASE_URL (see global-setup)");
  return accounts as E2eAccounts;
}

export async function signIn(page: Page, role: E2eRole) {
  const accounts = e2eAccounts();
  if (!accounts) throw new Error("No e2e accounts");
  // Sign-in is throttled to 5 per minute per client IP (#13). Present each
  // test as its own client (TEST-NET-2 addresses) so the suite stays under it.
  await page.setExtraHTTPHeaders({
    "x-forwarded-for": `198.51.100.${Math.floor(Math.random() * 254) + 1}`,
  });
  await page.goto("/login");
  await page.getByLabel("Email").fill(accounts.emails[role]);
  await page.getByLabel("Password").fill(accounts.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  // The first sign-in compiles the landing page in next dev.
  await expect(page).not.toHaveURL(/\/login/, { timeout: 30_000 });
}
