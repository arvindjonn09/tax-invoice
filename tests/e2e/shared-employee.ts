import { type Page, expect } from "@playwright/test";
import { requireAccounts } from "./accounts";

export type SharedEmployee = {
  id: string;
  name: string;
  userId: string | null;
  isActive: boolean;
};

/**
 * The employee record linked to the shared e2e employee login, created on
 * first use. Specs run in parallel workers and a login links to only one
 * record, so a create that loses the race (400 "already linked") re-reads
 * instead of failing. Specs must not deactivate this record: use a
 * throwaway employee for that.
 */
export async function sharedEmployee(
  page: Page,
  name = "Synthetic Shared Employee",
): Promise<SharedEmployee> {
  const accounts = requireAccounts();
  const users = (await (
    await page.request.get(
      `/api/users?q=${encodeURIComponent(accounts.emails.employee)}`,
    )
  ).json()) as { members: { userId: string; role: string }[] };
  const userId = users.members.find(
    (member) => member.role === "employee",
  )!.userId;
  const origin = { origin: new URL(page.url()).origin };
  for (let attempt = 0; attempt < 3; attempt++) {
    const { employees } = (await (
      await page.request.get("/api/employees?status=all&pageSize=100")
    ).json()) as { employees: SharedEmployee[] };
    const found = employees.find((row) => row.userId === userId);
    if (found) {
      if (found.isActive) return found;
      const reactivated = await page.request.fetch(
        `/api/employees/${found.id}`,
        { method: "PATCH", headers: origin, data: { isActive: true } },
      );
      expect(reactivated.ok()).toBe(true);
      return (await reactivated.json()) as SharedEmployee;
    }
    const created = await page.request.fetch("/api/employees", {
      method: "POST",
      headers: origin,
      data: { name, userId },
    });
    if (created.ok()) return (await created.json()) as SharedEmployee;
    // Another worker linked it first: read it on the next pass.
    expect(created.status()).toBe(400);
  }
  throw new Error("Couldn't find or create the shared e2e employee");
}
