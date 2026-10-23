import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { requireAccounts, signIn } from "./accounts";

// #26: company and GST settings screens. Runs against the per-run synthetic
// company from global-setup (skipped without a database).
test.describe.configure({ mode: "serial" });

test.beforeEach(() => {
  requireAccounts();
});

/** A checksum-valid synthetic ABN, computed (no real ABNs in the repo). */
function syntheticAbn(): string {
  const weights = [10, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19];
  for (let lead = 10; lead <= 99; lead += 1) {
    const digits = `${lead}000000777`;
    const sum = [...digits].reduce(
      (total, digit, index) =>
        total + (weights[index] ?? 0) * (Number(digit) - (index === 0 ? 1 : 0)),
      0,
    );
    if (sum % 89 === 0) return digits;
  }
  throw new Error("no ABN");
}

test("owner saves company details; a bad ABN shows a field error", async ({
  page,
}) => {
  await signIn(page, "owner");
  await page.goto("/settings");
  await expect(
    page.getByRole("heading", { level: 1, name: "Settings" }),
  ).toBeVisible();

  const abn = page.getByLabel("ABN", { exact: true });
  await abn.fill("12 345 678 900");
  await page.getByRole("button", { name: "Save company details" }).click();
  await expect(page.getByText("Enter a valid 11-digit ABN")).toBeVisible();
  await expect(abn).toHaveAttribute("aria-invalid", "true");

  await abn.fill(syntheticAbn());
  await page.getByLabel("Legal name").fill("Sample Contracting Pty Ltd");
  await page.getByLabel("State").selectOption("NSW");
  await page.getByLabel("Postcode").fill("2000");
  await page.getByRole("button", { name: "Save company details" }).click();
  await expect(page.getByRole("status")).toHaveText("Company details saved.");
  await page.reload();
  await expect(page.getByLabel("Legal name")).toHaveValue(
    "Sample Contracting Pty Ltd",
  );

  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
});

test("accountant adds a GST period after confirming, and an overlap is refused", async ({
  page,
}) => {
  await signIn(page, "accountant");
  await page.goto("/settings");
  // Profile is read-only for the accountant.
  await expect(page.getByLabel("Trading name")).toBeDisabled();
  await expect(
    page.getByText("not registered for GST — invoices will not charge GST"),
  ).toBeVisible();

  await page.getByLabel("First registered day").fill("2020-07-01");
  await page.getByRole("button", { name: "Review period" }).click();
  const confirm = page.getByRole("region", {
    name: "Confirm this tax setting",
  });
  await expect(confirm).toContainText(/Registered for GST from 1 July? 2020/);
  await expect(
    page.getByRole("heading", { name: "Confirm this tax setting" }),
  ).toBeFocused();
  await confirm.getByRole("button", { name: "Confirm change" }).click();
  await expect(page.getByRole("status")).toHaveText("GST settings saved.");
  await expect(page.getByText("registered for GST, cash basis")).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Registration history", exact: true }),
  ).toContainText("Ongoing");

  // Overlapping period → server's 409 message.
  await page.getByLabel("First registered day").fill("2021-01-01");
  await page.getByRole("button", { name: "Review period" }).click();
  await page.getByRole("button", { name: "Confirm change" }).click();
  // (Next.js also renders a route-announcer alert; match ours by text.)
  await expect(
    page.getByRole("alert").filter({
      hasText: "This period overlaps another GST registration period",
    }),
  ).toBeVisible();

  // Cancel leaves nothing changed.
  await page.getByLabel("BAS reporting period").selectOption("monthly");
  await page.getByRole("button", { name: "Review BAS period" }).click();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(
    page.getByRole("region", { name: "Confirm this tax setting" }),
  ).toHaveCount(0);
  // The control shows the saved value again, and Review re-proposes nothing new.
  await expect(page.getByLabel("BAS reporting period")).toHaveValue(
    "quarterly",
  );

  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
});

for (const role of ["manager", "employee", "subcontractor"] as const) {
  test(`${role} cannot open settings (404) or see it in navigation`, async ({
    page,
  }) => {
    await signIn(page, role);
    const response = await page.goto("/settings");
    expect(response?.status()).toBe(404);
    await expect(page.getByRole("link", { name: "Settings" })).toHaveCount(0);
  });
}
