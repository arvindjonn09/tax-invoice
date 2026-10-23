import { randomUUID } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import { type Page, expect, test } from "@playwright/test";
import { requireAccounts, signIn } from "./accounts";
test.setTimeout(90_000);
test.beforeEach(() => {
  requireAccounts();
});
async function write<T>(
  page: Page,
  url: string,
  body: unknown,
  method = "POST",
): Promise<T> {
  const response = await page.request.fetch(url, {
    method,
    headers: { origin: new URL(page.url()).origin },
    data: body,
  });
  expect(response.ok(), `${method} ${url}: ${response.status()}`).toBe(true);
  return response.json() as Promise<T>;
}
async function fixture(page: Page, createJob = true) {
  const suffix = randomUUID().slice(0, 8);
  const accounts = requireAccounts();
  const users = (await (
    await page.request.get(
      `/api/users?q=${encodeURIComponent(accounts.emails.employee)}`,
    )
  ).json()) as { members: { userId: string; role: string }[] };
  const userId = users.members.find(
    (member) => member.role === "employee",
  )!.userId;
  const employees = (await (
    await page.request.get(
      "/api/employees?status=all&q=Synthetic%20Screen%20Employee",
    )
  ).json()) as {
    employees: { id: string; userId: string | null; isActive: boolean }[];
  };
  let employee = employees.employees.find((row) => row.userId === userId);
  if (!employee)
    employee = await write(page, "/api/employees", {
      name: "Synthetic Screen Employee",
      userId,
    });
  if (!employee!.isActive)
    await write(
      page,
      `/api/employees/${employee!.id}`,
      { isActive: true },
      "PATCH",
    );
  const customer = await write<{ id: string }>(page, "/api/customers", {
    name: `Synthetic jobs client ${suffix}`,
  });
  const site = await write<{ id: string }>(
    page,
    `/api/customers/${customer.id}/locations`,
    {
      label: "Synthetic depot",
      addressLine1: "12 Example Street",
      suburb: "Sampleville",
      state: "NSW",
      postcode: "2000",
      accessNotes: "Use side gate",
    },
  );
  const job = createJob
    ? await write<{ id: string; title: string }>(page, "/api/jobs", {
        title: `Synthetic work ${suffix}`,
        customerId: customer.id,
        locationId: site.id,
        agreedPriceExclusiveCents: "250001",
      })
    : null;
  return { customer, site, employee: employee!, job };
}
test("owner creates a job, schedules a visit, assigns and ends work, and changes status", async ({
  page,
}) => {
  await signIn(page, "owner");
  const seeded = await fixture(page, false);
  await page.goto("/jobs");
  await page.getByRole("button", { name: "Create job", exact: true }).click();
  await page
    .getByLabel("Job title *", { exact: true })
    .fill("Synthetic screen job");
  await page
    .getByLabel("Customer *", { exact: true })
    .selectOption(seeded.customer.id);
  await page
    .getByLabel("Job site", { exact: true })
    .selectOption(seeded.site.id);
  await page
    .getByLabel("Agreed price (AUD ex GST)", { exact: true })
    .fill("2500.01");
  await page.getByRole("button", { name: "Save job", exact: true }).click();
  // The detail route compiles on first visit under `next dev` (CI), which can
  // take longer than the default 5 s; wait for it explicitly.
  await page.waitForURL(/\/jobs\/[0-9a-f-]{36}$/, { timeout: 30_000 });
  await expect(page.getByRole("heading", { level: 1 })).toContainText(
    "Synthetic screen job",
    { timeout: 30_000 },
  );
  const id = page.url().split("/").at(-1)!;
  expect(
    (await (await page.request.get(`/api/jobs/${id}`)).json())
      .agreedPriceExclusiveCents,
  ).toBe("250001");
  await page
    .getByLabel("Next status", { exact: true })
    .selectOption("approved");
  await page
    .getByRole("button", { name: "Update status", exact: true })
    .click();
  await expect(page.getByLabel("Next status")).toContainText("Assigned");
  await page.getByRole("tab", { name: "Visits", exact: true }).click();
  await page.getByRole("button", { name: "Add visit", exact: true }).click();
  await page
    .getByLabel("Visit start *", { exact: true })
    .fill("2026-11-09T08:30");
  await page.getByLabel("Visit end", { exact: true }).fill("2026-11-09T10:30");
  await page
    .getByLabel("Internal visit notes")
    .fill("Synthetic internal visit note");
  await page.getByRole("button", { name: "Save visit", exact: true }).click();
  await expect(page.getByText("Visit saved.", { exact: true })).toBeVisible();
  const visits = (await (await page.request.get(`/api/jobs/${id}`)).json())
    .visits as { id: string }[];
  const visitId = visits[0]!.id;
  const preciseStart = "2026-11-08T21:30:12.123Z";
  await write(
    page,
    `/api/jobs/${id}/visits/${visitId}`,
    { startsAt: preciseStart, notes: "First line\nSecond line" },
    "PATCH",
  );
  await page.reload();
  await page.getByRole("tab", { name: "Visits", exact: true }).click();
  await page.getByRole("button", { name: "Edit visit", exact: true }).click();
  await expect(page.getByLabel("Internal visit notes")).toHaveValue(
    "First line\nSecond line",
  );
  await page.getByLabel("Visit status").selectOption("completed");
  await page.getByRole("button", { name: "Save visit", exact: true }).click();
  await expect(page.getByText("Visit saved.", { exact: true })).toBeVisible();
  const updatedVisit = (
    await (await page.request.get(`/api/jobs/${id}`)).json()
  ).visits.find((visit: { id: string }) => visit.id === visitId);
  expect(updatedVisit.startsAt).toBe(preciseStart);
  expect(updatedVisit.notes).toBe("First line\nSecond line");

  await page.getByRole("tab", { name: "Assignments", exact: true }).click();
  await page
    .getByLabel("Employee *", { exact: true })
    .selectOption(seeded.employee.id);
  await page
    .getByRole("button", { name: "Assign employee", exact: true })
    .click();
  await expect(
    page.getByRole("heading", {
      name: "Synthetic Screen Employee",
      exact: true,
    }),
  ).toBeVisible();
  await write(
    page,
    `/api/employees/${seeded.employee.id}`,
    { isActive: false },
    "PATCH",
  );
  await page.reload();
  await page.getByRole("tab", { name: "Assignments", exact: true }).click();
  await expect(page.getByText(/Employee inactive/)).toBeVisible();
  await write(
    page,
    `/api/employees/${seeded.employee.id}`,
    { isActive: true },
    "PATCH",
  );
  await page.getByRole("tab", { name: "Overview", exact: true }).click();
  await page.getByLabel("Next status").selectOption("assigned");
  await page
    .getByRole("button", { name: "Update status", exact: true })
    .click();
  await expect(page.getByLabel("Next status")).not.toContainText("Assigned");
  await page.getByRole("tab", { name: "Timeline", exact: true }).click();
  await expect(
    page.getByText("Approved → Assigned", { exact: true }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "Assignments", exact: true }).click();
  page.once("dialog", (dialog) => dialog.accept());
  await page
    .getByRole("button", { name: "End assignment", exact: true })
    .click();
  await expect(page.getByText(/^Ended · Whole job$/)).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});
function keys(value: unknown): string[] {
  return Array.isArray(value)
    ? value.flatMap(keys)
    : value && typeof value === "object"
      ? Object.entries(value).flatMap(([key, child]) => [key, ...keys(child)])
      : [];
}
test("employee sees only assigned visits and no price; accountant is read-only", async ({
  page,
}) => {
  await signIn(page, "owner");
  const seeded = await fixture(page);
  const job = seeded.job!;
  const mine = await write<{ id: string }>(page, `/api/jobs/${job.id}/visits`, {
    startsAt: "2026-11-10T08:00:00+11:00",
    notes: "Internal assigned note",
  });
  const other = await write<{ id: string }>(
    page,
    `/api/jobs/${job.id}/visits`,
    {
      startsAt: "2026-11-11T08:00:00+11:00",
      notes: "Other worker private note",
    },
  );
  await write(page, `/api/jobs/${job.id}/assignments`, {
    employeeId: seeded.employee.id,
    visitId: mine.id,
  });
  const hidden = await write<{ id: string }>(page, "/api/jobs", {
    customerId: seeded.customer.id,
    title: "Unassigned secret work",
  });
  await page.context().clearCookies();
  await signIn(page, "employee");
  await page.goto(`/jobs/${job.id}`);
  await expect(page.getByRole("heading", { level: 1 })).toContainText(
    job.title,
  );
  await expect(page.getByText(/Agreed price|\$2,500/)).toHaveCount(0);
  await expect(
    page.getByRole("tab", { name: "Assignments", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Edit job", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("tab", { name: "Visits", exact: true }).click();
  await expect(
    page.getByText(/Internal assigned note|Other worker private note/),
  ).toHaveCount(0);
  const data = await (await page.request.get(`/api/my/jobs/${job.id}`)).json();
  expect(data.visits.map((row: { id: string }) => row.id)).toEqual([mine.id]);
  expect(data.visits.some((row: { id: string }) => row.id === other.id)).toBe(
    false,
  );
  expect(
    keys(data).filter((key) => /price|cost|cents|profit|margin/i.test(key)),
  ).toEqual([]);
  expect((await page.request.get(`/api/my/jobs/${hidden.id}`)).status()).toBe(
    404,
  );
  await page.goto(`/jobs/${hidden.id}`);
  await expect(page.getByRole("heading", { level: 1 })).not.toContainText(
    "Unassigned secret work",
  );
  await page.context().clearCookies();
  await signIn(page, "accountant");
  await page.goto(`/jobs/${job.id}`);
  await expect(page.getByRole("heading", { level: 1 })).toContainText(
    job.title,
  );
  await expect(
    page.getByRole("button", { name: "Edit job", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByLabel("Next status")).toHaveCount(0);
  await page.getByRole("tab", { name: "Assignments", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Assign employee", exact: true }),
  ).toHaveCount(0);
  expect(
    (
      await page.request.post(`/api/jobs/${job.id}/status`, {
        headers: { origin: new URL(page.url()).origin },
        data: { to: "approved" },
      })
    ).status(),
  ).toBe(403);
});
test("job forms preserve edits on failed saves and cancelled section changes", async ({
  page,
}) => {
  await signIn(page, "owner");
  const seeded = await fixture(page);
  const job = seeded.job!;
  await page.goto(`/jobs/${job.id}`);
  await page.getByRole("button", { name: "Edit job", exact: true }).click();
  await page
    .getByLabel("Job title *", { exact: true })
    .fill("Unsaved edited job");
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("tab", { name: "Visits", exact: true }).click();
  await expect(page.getByLabel("Job title *", { exact: true })).toHaveValue(
    "Unsaved edited job",
  );
  await page.route("**/api/jobs/*", (route) =>
    route.request().method() === "PATCH"
      ? route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ error: "Synthetic save failure" }),
        })
      : route.continue(),
  );
  await page.getByRole("button", { name: "Save job", exact: true }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "Synthetic save failure" }),
  ).toBeVisible();
  await expect(page.getByLabel("Job title *", { exact: true })).toHaveValue(
    "Unsaved edited job",
  );
  await page.unroute("**/api/jobs/*");
  await page.getByRole("button", { name: "Save job", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText(
    "Unsaved edited job",
  );
  await page.route("**/api/jobs/*", (route) =>
    route.request().method() === "GET"
      ? route.fulfill({
          status: 500,
          contentType: "application/json",
          body: "{}",
        })
      : route.continue(),
  );
  await page.getByLabel("Next status").selectOption("approved");
  await page
    .getByRole("button", { name: "Update status", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Try again", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toContainText(
    "Unsaved edited job",
  );
  await page.unroute("**/api/jobs/*");
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(page.getByLabel("Next status")).toContainText("Assigned");
  await page.route("**/api/jobs/*", (route) =>
    route.request().method() === "GET"
      ? route.fulfill({
          status: 403,
          contentType: "application/json",
          body: "{}",
        })
      : route.continue(),
  );
  await page.getByLabel("Next status").selectOption("in_progress");
  await page
    .getByRole("button", { name: "Update status", exact: true })
    .click();
  await expect(
    page.getByRole("alert").filter({ hasText: "no longer available" }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).not.toContainText(
    "Unsaved edited job",
  );
});
test("directory supports search, retry, keyboard, mobile and both themes", async ({
  page,
}, testInfo) => {
  await signIn(page, "owner");
  const seeded = await fixture(page);
  const job = seeded.job!;
  await write(page, `/api/jobs/${job.id}`, { title: "Q".repeat(200) }, "PATCH");
  await page.goto("/jobs");
  await page.getByLabel("Search jobs").fill("no-matching-job-33");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "No matching jobs", exact: true }),
  ).toBeVisible();
  await page.getByLabel("Search jobs").fill("");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page.getByLabel("Sort by").selectOption("title:asc");
  await expect(
    page.getByRole("button", { name: "Next", exact: true }),
  ).toBeVisible();
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
        path: testInfo.outputPath(`jobs-${theme}-${width}.png`),
        fullPage: true,
      });
    }
  }
  await page.goto(`/jobs/${job.id}`);
  await expect(
    page.getByRole("tab", { name: "Overview", exact: true }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "Overview", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(
    page.getByRole("tab", { name: "Assignments", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("tab", { name: "Assignments", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.goto("/jobs");
  await page.route("**/api/jobs?**", (route) => route.abort());
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Try again", exact: true }),
  ).toBeVisible();
  await page.unroute("**/api/jobs?**");
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Next", exact: true }),
  ).toBeVisible();
});
