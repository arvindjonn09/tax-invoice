import { randomUUID } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import { test, expect, type Page } from "@playwright/test";
import { requireAccounts, signIn } from "./accounts";
test.setTimeout(120_000);
test.beforeEach(() => {
  requireAccounts();
});
async function write<T>(
  page: Page,
  url: string,
  data: unknown,
  method = "POST",
): Promise<T> {
  const response = await page.request.fetch(url, {
    method,
    headers: { origin: new URL(page.url()).origin },
    data,
  });
  expect(response.ok(), `${method} ${url}: ${response.status()}`).toBe(true);
  return response.json() as Promise<T>;
}
const today = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Sydney" }).format(
    new Date(),
  );
/** A job with the synthetic employee assigned to the whole job (as owner). */
async function fixture(page: Page) {
  const suffix = randomUUID().slice(0, 8);
  const users = (await (
    await page.request.get(
      `/api/users?q=${encodeURIComponent(requireAccounts().emails.employee)}`,
    )
  ).json()) as { members: { userId: string; role: string }[] };
  const userId = users.members.find(
    (member) => member.role === "employee",
  )!.userId;
  type Employee = { id: string; userId: string | null; isActive: boolean };
  const { employees } = (await (
    await page.request.get("/api/employees?status=all&pageSize=100")
  ).json()) as { employees: Employee[] };
  const employee =
    employees.find((row) => row.userId === userId) ??
    (await write<Employee>(page, "/api/employees", {
      name: "Synthetic Timesheet Employee",
      userId,
    }));
  if (!employee.isActive)
    await write(
      page,
      `/api/employees/${employee.id}`,
      { isActive: true },
      "PATCH",
    );
  const customer = await write<{ id: string }>(page, "/api/customers", {
    name: `Synthetic time client ${suffix}`,
  });
  const job = await write<{ id: string; reference: string; title: string }>(
    page,
    "/api/jobs",
    { title: `Synthetic time job ${suffix}`, customerId: customer.id },
  );
  await write(page, `/api/jobs/${job.id}/assignments`, {
    employeeId: employee.id,
  });
  return { job, employee, suffix };
}
test("employee logs time on an assigned job, edits it, and never sees rates or cost", async ({
  page,
}) => {
  await signIn(page, "owner");
  const { job, employee, suffix } = await fixture(page);
  await page.context().clearCookies();
  await signIn(page, "employee");
  await page.goto("/timesheets");
  await expect(
    page.getByRole("heading", { name: "My time", level: 1 }),
  ).toBeVisible({ timeout: 30_000 });
  const form = page.locator("form").first();
  await form
    .getByLabel("Job *")
    .selectOption({ label: `${job.reference} · ${job.title}` });
  await form.getByLabel("Hours").fill("7");
  await form.getByLabel("Minutes").fill("75");
  await form.getByLabel("Note").fill(`Synthetic install ${suffix}`);
  await form.getByRole("button", { name: "Log time" }).click();
  await expect(form.getByText("Minutes must be 0–59")).toBeVisible();
  await expect(form.getByLabel("Note")).toHaveValue(
    `Synthetic install ${suffix}`,
  );
  await form.getByLabel("Minutes").fill("30");
  await expect(form.getByText("Total 7h 30m")).toBeVisible();
  await form.getByRole("button", { name: "Log time" }).click();
  await expect(
    page.getByText("Time logged for approval.", { exact: true }),
  ).toBeVisible();
  const item = page
    .getByRole("listitem")
    .filter({ hasText: `Synthetic install ${suffix}` });
  await expect(item).toContainText("7h 30m");
  await expect(item).toContainText("Awaiting approval");
  await item.getByRole("button", { name: "Edit time" }).click();
  await item.getByLabel("Hours").fill("8");
  await item.getByLabel("Minutes").fill("0");
  await item.getByRole("button", { name: "Save changes" }).click();
  await expect(
    page.getByText("Timesheet updated.", { exact: true }),
  ).toBeVisible();
  await expect(item).toContainText("8h on");
  // No rate, cost or other people's entries for employees.
  const mine = (await (
    await page.request.get("/api/my/timesheets")
  ).json()) as {
    timesheets: Record<string, unknown>[];
  };
  for (const row of mine.timesheets) {
    expect(row).not.toHaveProperty("hourlyCostCents");
    expect(row).not.toHaveProperty("costCents");
    expect(row).not.toHaveProperty("employeeName");
  }
  await expect(page.getByText(/Labour cost|\/h/)).toHaveCount(0);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  expect([403, 404]).toContain(
    (await page.request.get("/api/timesheets")).status(),
  );
  expect([403, 404]).toContain(
    (await page.request.get(`/api/employees/${employee.id}/rates`)).status(),
  );
});

test("manager approves from the queue with a fixed cost, needs a rate first, and reverses", async ({
  page,
}) => {
  await signIn(page, "owner");
  const { job, employee, suffix } = await fixture(page);
  await page.context().clearCookies();
  await signIn(page, "employee");
  await write(page, "/api/timesheets", {
    jobId: job.id,
    workDate: today(),
    minutes: 450,
    note: `Synthetic rough-in ${suffix}`,
  });
  await page.context().clearCookies();
  await signIn(page, "manager");
  const rates = (await (
    await page.request.get(`/api/employees/${employee.id}/rates`)
  ).json()) as { rates: { effectiveFrom: string }[] };
  await page.goto("/timesheets");
  await expect(page.getByLabel("Show")).toHaveValue("submitted", {
    timeout: 30_000,
  });
  const item = page
    .getByRole("listitem")
    .filter({ hasText: `Synthetic rough-in ${suffix}` })
    .filter({ hasNotText: /· Reversal/ });
  await expect(item).toContainText("7h 30m");
  if (rates.rates.length === 0) {
    // Approval without a cost rate is refused, not guessed.
    await item.getByRole("button", { name: "Approve" }).click();
    await expect(item.getByText(/cost rate for/)).toBeVisible();
    await expect(item).toContainText("Awaiting approval");
    const added = await page.request.post(
      `/api/employees/${employee.id}/rates`,
      {
        headers: { origin: new URL(page.url()).origin },
        data: { effectiveFrom: "2026-01-01", hourlyCostCents: "6000" },
      },
    );
    expect([201, 409]).toContain(added.status());
  }
  await item.getByLabel("Decision note").fill("Checked against the job diary");
  await item.getByRole("button", { name: "Approve" }).click();
  await expect(
    page.getByText("Timesheet approved.", { exact: true }),
  ).toBeVisible();
  await page.getByLabel("Show").selectOption("approved");
  await expect(item).toContainText("Approved");
  await expect(item).toContainText(
    /Labour cost \$[\d,]+\.\d\d AUD at \$[\d,]+\.\d\d\/h/,
  );
  await item.getByRole("button", { name: "Reverse timesheet" }).click();
  await item
    .getByLabel("Reason for reversal *")
    .fill("Logged on the wrong job");
  page.once("dialog", (dialog) => dialog.accept());
  await item.getByRole("button", { name: "Confirm reversal" }).click();
  await expect(
    page.getByText("Timesheet reversed.", { exact: true }),
  ).toBeVisible();
  await expect(item).toContainText("Reversed.");
  await page.getByLabel("Show").selectOption("");
  await expect(
    page.getByRole("listitem").filter({ hasText: "−7h 30m" }).first(),
  ).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test("timesheets show error, retry and empty states, reflow at 390px in both themes, and stay closed to other roles", async ({
  page,
}) => {
  await signIn(page, "manager");
  // Fail every list request until the error is shown (dev mode double-fetches).
  let failing = true;
  await page.route("**/api/timesheets?*", async (route) => {
    if (failing) await route.fulfill({ status: 500, body: "{}" });
    else await route.continue();
  });
  await page.goto("/timesheets");
  await expect(page.getByText(/Couldn't load this information/)).toBeVisible({
    timeout: 30_000,
  });
  failing = false;
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByText(/timesheets? · Page 1/)).toBeVisible();
  await page.getByLabel("Show").selectOption("rejected");
  await expect(page.getByText(/timesheets? · Page 1/)).toBeVisible();
  await page.context().clearCookies();
  await signIn(page, "employee");
  await page.goto("/timesheets");
  await expect(page.getByRole("heading", { name: "Log time" })).toBeVisible({
    timeout: 30_000,
  });
  for (const scheme of ["light", "dark"] as const) {
    await page.getByLabel("Appearance").selectOption(scheme);
    await expect(page.locator("html")).toHaveClass(new RegExp(scheme));
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      await page.screenshot({
        path: `docs/testing/screenshots/timesheets-${scheme}-${width}.png`,
        fullPage: true,
      });
    }
  }
  for (const role of ["accountant", "subcontractor"] as const) {
    await page.context().clearCookies();
    await signIn(page, role);
    expect((await page.goto("/timesheets"))?.status()).toBe(404);
  }
});
