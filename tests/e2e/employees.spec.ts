import { randomUUID } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import { test, expect, type Page } from "@playwright/test";
import { requireAccounts, signIn } from "./accounts";
test.setTimeout(120_000);
test.beforeEach(() => {
  requireAccounts();
});

type Employee = {
  id: string;
  name: string;
  userId: string | null;
  isActive: boolean;
};

async function send<T>(
  page: Page,
  url: string,
  data: unknown,
  method = "POST",
): Promise<{ status: number; body: T }> {
  const response = await page.request.fetch(url, {
    method,
    headers: { origin: new URL(page.url()).origin },
    data,
  });
  return { status: response.status(), body: (await response.json()) as T };
}
async function write<T>(
  page: Page,
  url: string,
  data: unknown,
  method = "POST",
): Promise<T> {
  const { status, body } = await send<T>(page, url, data, method);
  expect(status < 300, `${method} ${url}: ${status}`).toBe(true);
  return body;
}

/** The employee record linked to the shared employee login (any name). */
async function linkedEmployee(page: Page): Promise<Employee> {
  const accounts = requireAccounts();
  const users = (await (
    await page.request.get(
      `/api/users?q=${encodeURIComponent(accounts.emails.employee)}`,
    )
  ).json()) as { members: { userId: string; role: string }[] };
  const userId = users.members.find(
    (member) => member.role === "employee",
  )!.userId;
  const { employees } = (await (
    await page.request.get("/api/employees?status=all&pageSize=100")
  ).json()) as { employees: Employee[] };
  let employee = employees.find((row) => row.userId === userId);
  employee ??= await write<Employee>(page, "/api/employees", {
    name: "Synthetic Rate Employee",
    userId,
  });
  if (!employee.isActive)
    employee = await write<Employee>(
      page,
      `/api/employees/${employee.id}`,
      { isActive: true },
      "PATCH",
    );
  return employee;
}

function dayBefore(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) - 86_400_000)
    .toISOString()
    .slice(0, 10);
}

test("manager adds a cost rate, then approves a timesheet refused for lacking one", async ({
  page,
  browser,
}) => {
  // The owner reads user accounts to find the shared employee login.
  await signIn(page, "owner");
  const employee = await linkedEmployee(page);
  const suffix = randomUUID().slice(0, 8);
  const customer = await write<{ id: string }>(page, "/api/customers", {
    name: `Synthetic rates client ${suffix}`,
  });
  const job = await write<{ id: string }>(page, "/api/jobs", {
    title: `Synthetic rated work ${suffix}`,
    customerId: customer.id,
  });
  await write(page, `/api/jobs/${job.id}/assignments`, {
    employeeId: employee.id,
  });
  // Work on a date no existing rate covers, so approval must be refused.
  const { rates } = (await (
    await page.request.get(`/api/employees/${employee.id}/rates`)
  ).json()) as { rates: { effectiveFrom: string }[] };
  const earliest = rates.map((rate) => rate.effectiveFrom).sort()[0];
  const workDate = dayBefore(earliest ?? "2026-01-01");

  const worker = await (await browser.newContext()).newPage();
  await signIn(worker, "employee");
  const timesheet = await write<{ id: string }>(worker, "/api/timesheets", {
    jobId: job.id,
    workDate,
    minutes: 90,
  });
  await worker.context().close();

  await page.context().clearCookies();
  await signIn(page, "manager");
  const refused = await send<{ error: string }>(
    page,
    `/api/timesheets/${timesheet.id}/decision`,
    { decision: "approve" },
  );
  expect(refused.status).toBe(409);
  expect(refused.body.error).toContain("cost rate");

  await page.goto(`/employees/${employee.id}`);
  await expect(
    page.getByRole("heading", { name: "Cost rate history", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Add rate", exact: true }).click();
  await page.getByLabel("Starts on *", { exact: true }).fill(workDate);
  await page.getByLabel("Hourly cost (AUD) *", { exact: true }).fill("48.5x");
  await page.getByRole("button", { name: "Save rate", exact: true }).click();
  await expect(
    page.getByText("Enter a non-negative AUD amount", { exact: false }),
  ).toBeVisible();
  await page.getByLabel("Hourly cost (AUD) *", { exact: true }).fill("48.50");
  await page.getByRole("button", { name: "Save rate", exact: true }).click();
  await expect(
    page.getByText("Cost rate added.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(`From ${workDate}`, { exact: false }),
  ).toBeVisible();
  await expect(page.getByText("$48.50 AUD an hour").first()).toBeVisible();

  // The same start date twice is refused, and nothing is overwritten.
  await page.getByRole("button", { name: "Add rate", exact: true }).click();
  await page.getByLabel("Starts on *", { exact: true }).fill(workDate);
  await page.getByLabel("Hourly cost (AUD) *", { exact: true }).fill("99.00");
  await page.getByRole("button", { name: "Save rate", exact: true }).click();
  await expect(
    page.getByLabel("Starts on *", { exact: true }),
  ).toHaveAccessibleDescription(/A rate already starts on that date/);

  const approved = await write<{ status: string; costCents: string }>(
    page,
    `/api/timesheets/${timesheet.id}/decision`,
    { decision: "approve" },
  );
  expect(approved.status).toBe("approved");
  // 90 minutes at $48.50 an hour = $72.75.
  expect(approved.costCents).toBe("7275");
});

test("office manages employees; accountant reads without rates; workers can't open them", async ({
  page,
}, testInfo) => {
  await signIn(page, "manager");
  const name = `Synthetic staff ${randomUUID().slice(0, 8)}`;
  await page.goto("/employees");
  await page.getByRole("button", { name: "Add employee", exact: true }).click();
  await expect(page.getByLabel("Linked login", { exact: true })).toBeEnabled();
  await page.getByLabel("Employee name *", { exact: true }).fill(name);
  await page.getByLabel("Email", { exact: true }).fill("staff@example.invalid");
  await page
    .getByRole("button", { name: "Save employee", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name, exact: true, level: 1 }),
  ).toBeVisible();
  const id = page.url().split("/").pop()!;
  await expect(page.getByText("No cost rate yet.")).toBeVisible();

  await page
    .getByRole("button", { name: "Edit employee", exact: true })
    .click();
  await page.getByLabel("Phone", { exact: true }).fill("0400 000 000");
  await page
    .getByRole("button", { name: "Save employee", exact: true })
    .click();
  await expect(
    page.getByText("Employee saved.", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("0400 000 000")).toBeVisible();

  page.once("dialog", (dialog) => void dialog.accept());
  await page
    .getByRole("button", { name: "Deactivate employee", exact: true })
    .click();
  await expect(
    page.getByText("Employee deactivated.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Reactivate employee", exact: true }),
  ).toBeVisible();

  await page.goto("/employees");
  await page.getByLabel("Search employees", { exact: true }).fill(name);
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "No matching employees", exact: true }),
  ).toBeVisible();
  await page.getByLabel("Status", { exact: true }).selectOption("inactive");
  await expect(page.getByRole("link", { name, exact: true })).toBeVisible();
  for (const theme of ["light", "dark"]) {
    await page.getByLabel("Appearance").selectOption(theme);
    await expect(page.locator("html")).toHaveClass(new RegExp(theme));
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      await page.screenshot({
        path: testInfo.outputPath(`employees-${theme}-${width}.png`),
        fullPage: true,
      });
    }
  }
  await page.goto(`/employees/${id}`);
  await page.setViewportSize({ width: 390, height: 900 });
  await expect(
    page.getByRole("heading", { name: "Cost rate history", exact: true }),
  ).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

  await page.route("**/api/employees?**", (route) => route.abort());
  await page.goto("/employees");
  await expect(
    page.getByRole("button", { name: "Try again", exact: true }),
  ).toBeVisible();
  await page.unroute("**/api/employees?**");

  await page.context().clearCookies();
  await signIn(page, "accountant");
  await page.goto(`/employees/${id}`);
  await expect(
    page.getByRole("heading", { name, exact: true, level: 1 }),
  ).toBeVisible();
  for (const control of ["Edit employee", "Reactivate employee", "Add rate"])
    await expect(
      page.getByRole("button", { name: control, exact: true }),
    ).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Cost rate history", exact: true }),
  ).toHaveCount(0);
  expect((await page.request.get(`/api/employees/${id}/rates`)).status()).toBe(
    403,
  );
  await page.goto("/employees");
  await expect(
    page.getByRole("button", { name: "Add employee", exact: true }),
  ).toHaveCount(0);

  for (const role of ["employee", "subcontractor"] as const) {
    await page.context().clearCookies();
    await signIn(page, role);
    expect((await page.goto(`/employees/${id}`))?.status()).toBe(404);
    expect((await page.goto("/employees"))?.status()).toBe(404);
    expect((await page.request.get(`/api/employees/${id}`)).status()).toBe(403);
  }
});
