import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { requireAccounts, signIn } from "./accounts";
test.setTimeout(90_000);
test.beforeEach(() => {
  requireAccounts();
});
test("owner creates and maintains a customer, contact and site", async ({
  page,
}) => {
  await signIn(page, "owner");
  await page.goto("/customers");
  await page.getByRole("button", { name: "Add customer", exact: true }).click();
  await page
    .getByLabel("Customer name *", { exact: true })
    .fill("Synthetic screen customer");
  await page.getByLabel("ABN").fill("123");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByLabel("ABN")).toBeFocused();
  await expect(page.getByText("Enter a valid 11-digit ABN")).toBeVisible();
  await page.getByLabel("ABN").fill("");
  await page.getByLabel("Billing email").fill("billing@example.test");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Synthetic screen customer",
    { timeout: 30000 },
  );
  await page.getByRole("button", { name: "Add contact", exact: true }).click();
  await page.getByLabel("Contact name *").fill("Synthetic Contact");
  await page.getByLabel("Primary contact").check();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Synthetic Contact", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Add site", exact: true }).click();
  await page
    .getByLabel("Street address *", { exact: true })
    .fill("42 Synthetic Street");
  await page.getByLabel("Suburb *", { exact: true }).fill("Sampleville");
  await page.getByLabel("State *", { exact: true }).selectOption("NSW");
  await page.getByLabel("Postcode *", { exact: true }).fill("2000");
  await page.getByLabel("Access notes").fill("S".repeat(500));
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "42 Synthetic Street" }),
  ).toBeVisible();
  await expect(
    page.getByText(`Access: ${"S".repeat(500)}`, { exact: true }),
  ).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  page.on("dialog", (dialog) => dialog.accept());
  const contacts = page.getByRole("region", { name: "Contacts", exact: true });
  await contacts.getByRole("button", { name: "Archive", exact: true }).click();
  await expect(
    contacts.getByRole("button", { name: "Restore", exact: true }),
  ).toBeVisible();
  await contacts.getByRole("button", { name: "Restore", exact: true }).click();
  await expect(
    contacts.getByRole("button", { name: "Archive", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Edit customer", exact: true })
    .click();
  await page.getByLabel("Billing phone").fill("0400 000 123");
  await page.route("**/api/customers/*", async (route) => {
    if (route.request().method() === "PATCH")
      return route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "Synthetic service unavailable" }),
      });
    await route.continue();
  });
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "Synthetic service unavailable" }),
  ).toContainText("Synthetic service unavailable");
  await expect(page.getByLabel("Billing phone")).toHaveValue("0400 000 123");
  await page.unroute("**/api/customers/*");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("0400 000 123", { exact: true })).toBeVisible();
  await page
    .getByRole("button", { name: "Archive customer", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Restore customer", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Restore customer", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Archive customer", exact: true }),
  ).toBeVisible();
});
test("directory search, empty, retry and responsive accessibility", async ({
  page,
}, testInfo) => {
  await signIn(page, "manager");
  await page.goto("/customers");
  await expect(
    page.getByRole("button", { name: "Add customer", exact: true }),
  ).toBeVisible();
  await page.getByLabel("Search customers").fill("does-not-exist-29");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "No matching customers" }),
  ).toBeVisible();
  await page.getByLabel("Search customers").fill("");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page.getByLabel("Sort by").selectOption("name:desc");
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
        path: testInfo.outputPath(`customers-${theme}-${width}.png`),
        fullPage: true,
      });
    }
  }
  await page.route("**/api/customers?**", (route) => route.abort());
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Try again", exact: true }),
  ).toBeVisible();
  await page.unroute("**/api/customers?**");
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Next", exact: true }),
  ).toBeVisible();
});
test("accountant reads without controls; worker roles cannot open directory", async ({
  page,
}) => {
  await signIn(page, "accountant");
  await page.goto("/customers");
  await expect(
    page.getByRole("heading", { level: 1, name: "Customers" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Add customer", exact: true }),
  ).toHaveCount(0);
  const response = await page.request.get("/api/customers");
  const body = (await response.json()) as { customers: { id: string }[] };
  if (body.customers[0]) {
    await page.goto(`/customers/${body.customers[0].id}`);
    await expect(
      page.getByRole("button", { name: "Edit customer" }),
    ).toHaveCount(0);
  }
  for (const role of ["employee", "subcontractor"] as const) {
    await page.context().clearCookies();
    await signIn(page, role);
    await page.goto("/customers");
    await expect(
      page.getByRole("heading", { level: 1, name: "Customers", exact: true }),
    ).toHaveCount(0);
    expect((await page.request.get("/api/customers")).status()).toBe(403);
  }
});

test("history Back and Forward warn before discarding edits", async ({
  page,
}) => {
  const traverse = (direction: "back" | "forward") =>
    page.evaluate(async (direction) => {
      const nav = (
        window as unknown as {
          navigation: Record<
            "back" | "forward",
            () => { committed: Promise<unknown>; finished: Promise<unknown> }
          >;
        }
      ).navigation;
      const result = nav[direction]();
      // Cancelling a traversal rejects both promises. Wait for settlement before
      // issuing another browser-history request, rather than racing its rollback.
      await Promise.allSettled([result.committed, result.finished]);
    }, direction);
  await signIn(page, "owner");
  await page.goto("/customers");
  const id = await page.evaluate(async () => {
    const response = await fetch("/api/customers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Synthetic history customer" }),
    });
    if (!response.ok) throw new Error("Couldn't create history fixture");
    return ((await response.json()) as { id: string }).id;
  });
  await page.reload();
  await page.locator(`a[href="/customers/${id}"]`).first().click();
  await page
    .getByRole("button", { name: "Edit customer", exact: true })
    .click();
  await page
    .getByLabel("Customer name *", { exact: true })
    .fill("Unsaved synthetic edit");
  await Promise.all([
    page
      .waitForEvent("dialog", { timeout: 10000 })
      .then((dialog) => dialog.dismiss()),
    traverse("back"),
  ]);
  await expect(page.getByLabel("Customer name *", { exact: true })).toHaveValue(
    "Unsaved synthetic edit",
  );
  await Promise.all([
    page
      .waitForEvent("dialog", { timeout: 10000 })
      .then((dialog) => dialog.accept()),
    traverse("back"),
  ]);
  await expect(page).toHaveURL(/\/customers$/);
  await page.getByRole("button", { name: "Add customer", exact: true }).click();
  await page
    .getByLabel("Customer name *", { exact: true })
    .fill("Unsaved new customer");
  await Promise.all([
    page
      .waitForEvent("dialog", { timeout: 10000 })
      .then((dialog) => dialog.dismiss()),
    traverse("forward"),
  ]);
  await expect(page.getByLabel("Customer name *", { exact: true })).toHaveValue(
    "Unsaved new customer",
  );
  await page.getByLabel("Customer name *", { exact: true }).click();
  await Promise.all([
    page
      .waitForEvent("dialog", { timeout: 10000 })
      .then((dialog) => dialog.accept()),
    traverse("forward"),
  ]);
  await expect(page).toHaveURL(new RegExp(`/customers/${id}$`));
});
