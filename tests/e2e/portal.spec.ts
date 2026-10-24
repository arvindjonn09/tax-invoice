import { randomUUID } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import { test, expect, type Page } from "@playwright/test";
import { requireAccounts, signIn } from "./accounts";
import { syntheticAbn } from "../helpers/abn";
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
  expect(response.ok(), `${url}: ${response.status()}`).toBe(true);
  return response.json() as Promise<T>;
}
async function fixture(page: Page) {
  const suffix = randomUUID().slice(0, 8);
  const users = (await (
    await page.request.get(
      `/api/users?q=${encodeURIComponent(requireAccounts().emails.subcontractor)}`,
    )
  ).json()) as { members: { userId: string; role: string }[] };
  const userId = users.members.find(
    (row) => row.role === "subcontractor",
  )!.userId;
  const directory = (await (
    await page.request.get(
      "/api/contractors?status=all&q=Synthetic%20portal&pageSize=100",
    )
  ).json()) as { contractors: { id: string; userId: string | null }[] };
  let contractor = directory.contractors.find((row) => row.userId === userId);
  if (!contractor)
    contractor = await write(page, "/api/contractors", {
      name: `Synthetic portal contractor ${suffix}`,
      userId,
      abn: syntheticAbn("135792468"),
      gstRegistered: true,
    });
  const customer = await write<{ id: string }>(page, "/api/customers", {
    name: `Synthetic portal customer ${suffix}`,
  });
  const job = await write<{ id: string; reference: string }>(
    page,
    "/api/jobs",
    {
      title: `Synthetic portal work ${suffix}`,
      customerId: customer.id,
      agreedPriceExclusiveCents: "987654321",
    },
  );
  const offer = await write<{ id: string }>(
    page,
    `/api/jobs/${job.id}/offers`,
    {
      contractorId: contractor!.id,
      scope: `Your synthetic scope ${suffix}`,
      rateType: "fixed",
      rateExclusiveCents: "90000",
      taxCode: "TAXABLE_10",
    },
  );
  const rival = await write<{ id: string }>(page, "/api/contractors", {
    name: `Synthetic rival ${suffix}`,
  });
  const hidden = await write<{ id: string }>(
    page,
    `/api/jobs/${job.id}/offers`,
    {
      contractorId: rival.id,
      scope: `Private rival scope ${suffix}`,
      rateType: "fixed",
      rateExclusiveCents: "70000",
      taxCode: "OUT_OF_SCOPE",
    },
  );
  return { job, offer, hidden, suffix };
}
test("subcontractor inspects own terms, confirms acceptance and sees accepted work", async ({
  page,
}) => {
  await signIn(page, "owner");
  const seeded = await fixture(page);
  await signIn(page, "subcontractor");
  await page.goto(`/offers/${seeded.offer.id}`);
  await expect(page.getByRole("heading", { level: 1 })).toContainText(
    seeded.job.reference,
    { timeout: 30_000 },
  );
  await expect(
    page.getByText("$990.00 AUD incl GST", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Bill submission", exact: true }),
  ).toBeVisible();
  page.once("dialog", (dialog) => dialog.dismiss());
  await page
    .getByRole("button", { name: "Send response", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Send response", exact: true }),
  ).toBeVisible();
  await page
    .getByLabel("Response note", { exact: true })
    .fill("Synthetic accepted terms");
  page.once("dialog", (dialog) => dialog.accept());
  await page
    .getByRole("button", { name: "Send response", exact: true })
    .click();
  await expect(
    page.getByText("Offer accepted.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Send response", exact: true }),
  ).toHaveCount(0);
  await page.goto("/jobs");
  await expect(
    page.getByRole("heading", { level: 1, name: "My jobs", exact: true }),
  ).toBeVisible({ timeout: 30_000 });
  await expect(
    page.getByRole("link", { name: new RegExp(seeded.job.reference) }),
  ).toBeVisible({ timeout: 30_000 });
  const response = await page.request.get(`/api/my/offers/${seeded.offer.id}`);
  expect(response.status()).toBe(200);
  const body = await response.json();
  expect(body).toMatchObject({ status: "accepted", inclusiveCents: "99000" });
  expect(JSON.stringify(body)).not.toMatch(
    /agreedPrice|committedCost|companyGstRegistered|margin|profit|987654321|70000/,
  );
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});
test("portal refuses another contractor's offers and office data", async ({
  page,
}) => {
  await signIn(page, "owner");
  const seeded = await fixture(page);
  await signIn(page, "subcontractor");
  const foreign = await page.goto(`/offers/${seeded.hidden.id}`);
  expect(foreign?.status()).toBe(404);
  expect(
    (await page.request.get(`/api/my/offers/${seeded.hidden.id}`)).status(),
  ).toBe(404);
  expect((await page.request.get(`/api/jobs/${seeded.job.id}`)).status()).toBe(
    403,
  );
  for (const path of ["/customers", `/jobs/${seeded.job.id}`, "/contractors"]) {
    const response = await page.goto(path);
    expect(response?.status()).toBe(404);
  }
  await page.goto("/offers");
  await expect(
    page.getByRole("heading", { level: 1, name: "My offers", exact: true }),
  ).toBeVisible({ timeout: 30_000 });
  await expect(
    page.getByText(`Private rival scope ${seeded.suffix}`, { exact: true }),
  ).toHaveCount(0);
  for (const role of ["employee", "accountant", "owner"] as const) {
    await signIn(page, role);
    const response = await page.goto(`/offers/${seeded.offer.id}`);
    expect(response?.status()).toBe(404);
  }
});
test("offers support declined/empty/retry states and responsive accessible themes", async ({
  page,
}, testInfo) => {
  await signIn(page, "owner");
  const seeded = await fixture(page);
  await signIn(page, "subcontractor");
  await page.goto(`/offers/${seeded.offer.id}`);
  await expect(page.getByLabel("Your decision", { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await page
    .getByLabel("Your decision", { exact: true })
    .selectOption("decline");
  await page.route(`**/api/my/offers/${seeded.offer.id}`, async (route) => {
    if (route.request().method() === "POST")
      await route.fulfill({
        status: 409,
        json: { error: "Synthetic response retry" },
      });
    else await route.continue();
  });
  await page
    .getByLabel("Response note", { exact: true })
    .fill("Synthetic retained response");
  page.once("dialog", (dialog) => dialog.accept());
  await page
    .getByRole("button", { name: "Send response", exact: true })
    .click();
  await expect(
    page.getByText("Synthetic response retry", { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Response note", { exact: true })).toHaveValue(
    "Synthetic retained response",
  );
  await page.unroute(`**/api/my/offers/${seeded.offer.id}`);
  page.once("dialog", (dialog) => dialog.accept());
  await page
    .getByRole("button", { name: "Send response", exact: true })
    .click();
  await expect(
    page.getByText("Offer declined.", { exact: true }),
  ).toBeVisible();
  await page.goto("/offers");
  await page
    .getByLabel("Search my offers", { exact: true })
    .fill("no-matching-offer-37");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "No matching offers", exact: true }),
  ).toBeVisible({ timeout: 30_000 });
  await page
    .getByLabel("Search my offers", { exact: true })
    .fill(seeded.suffix);
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(
    page.getByRole("link", { name: new RegExp(seeded.job.reference) }),
  ).toBeVisible();
  for (const theme of ["light", "dark"]) {
    await page.getByLabel("Appearance").selectOption(theme);
    await expect(page.locator("html")).toHaveClass(new RegExp(theme));
    for (const width of [360, 390, 768, 1024, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      if (width === 390 || width === 1440)
        await page.screenshot({
          path: testInfo.outputPath(`portal-${theme}-${width}.png`),
          fullPage: true,
        });
    }
  }
  await page.route("**/api/my/offers?**", (route) => route.abort());
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Try again", exact: true }),
  ).toBeVisible();
  await page.unroute("**/api/my/offers?**");
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(
    page.getByRole("link", { name: new RegExp(seeded.job.reference) }),
  ).toBeVisible();
});

test("evidence UI contract retains a private upload across attachment failure", async ({
  page,
}) => {
  await signIn(page, "owner");
  const seeded = await fixture(page);
  for (const to of ["approved", "assigned", "in_progress"])
    await write(page, `/api/jobs/${seeded.job.id}/status`, { to });
  await signIn(page, "subcontractor");
  await write(page, `/api/my/offers/${seeded.offer.id}`, {
    decision: "accept",
  });
  // Component contract coverage while #42's backend PR is pending. This is
  // intentionally mocked; real storage/attachment integration is a merge gate.
  const documentId = randomUUID();
  let uploads = 0,
    attachments = 0;
  const evidence: {
    id: string;
    kind: string;
    note: string;
    documentId: string;
    createdAt: string;
  }[] = [];
  await page.route("**/api/documents", async (route) => {
    uploads++;
    await route.fulfill({
      status: 201,
      json: { id: documentId, fileName: "synthetic-evidence.png" },
    });
  });
  await page.route(
    `**/api/my/work/${seeded.job.id}/evidence`,
    async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({ json: { evidence } });
        return;
      }
      const body = route.request().postDataJSON() as {
        documentId: string;
        kind: string;
        note: string;
      };
      expect(body.documentId).toBe(documentId);
      attachments++;
      if (attachments === 1) {
        await route.fulfill({
          status: 409,
          json: { error: "Synthetic attachment retry" },
        });
        return;
      }
      evidence.push({
        id: randomUUID(),
        kind: body.kind,
        note: body.note,
        documentId,
        createdAt: new Date().toISOString(),
      });
      await route.fulfill({ status: 201, json: evidence[0] });
    },
  );
  await page.goto(`/offers/${seeded.offer.id}`);
  await expect(page.getByLabel("Evidence type", { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await page.getByLabel("Evidence type", { exact: true }).selectOption("photo");
  await page.getByLabel("Image *", { exact: true }).setInputFiles({
    name: "synthetic-evidence.png",
    mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jXioAAAAASUVORK5CYII=",
      "base64",
    ),
  });
  await page
    .getByLabel("Image description", { exact: true })
    .fill("Synthetic private evidence note");
  await page
    .getByRole("button", { name: "Save evidence", exact: true })
    .click();
  await expect(page.getByText(/Synthetic attachment retry/)).toBeVisible();
  await expect(
    page.getByLabel("Image description", { exact: true }),
  ).toHaveValue("Synthetic private evidence note");
  expect(uploads).toBe(1);
  await page
    .getByRole("button", { name: "Save evidence", exact: true })
    .click();
  await expect(
    page.getByText("Evidence attached to this job.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Synthetic private evidence note", { exact: true }),
  ).toBeVisible();
  expect(uploads).toBe(1);
  expect(attachments).toBe(2);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test("real evidence workflow uploads privately, denies another uploader's file and submits work", async ({
  page,
}) => {
  // Integration gate: requires the reviewed #42 backend and local/CI MinIO.
  // No route mocks or skips: this must pass before #37 is ready to merge.
  await signIn(page, "owner");
  const seeded = await fixture(page);
  for (const to of ["approved", "assigned", "in_progress"])
    await write(page, `/api/jobs/${seeded.job.id}/status`, { to });
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jXioAAAAASUVORK5CYII=",
    "base64",
  );
  const ownerUpload = await page.request.post("/api/documents", {
    headers: { origin: new URL(page.url()).origin },
    multipart: {
      kind: "photo",
      file: {
        name: "synthetic-office-only.png",
        mimeType: "image/png",
        buffer: png,
      },
    },
  });
  expect(ownerUpload.status()).toBe(201);
  const privateDocument = (await ownerUpload.json()) as { id: string };
  await signIn(page, "subcontractor");
  await write(page, `/api/my/offers/${seeded.offer.id}`, {
    decision: "accept",
  });
  const forged = await page.request.post(
    `/api/my/work/${seeded.job.id}/evidence`,
    {
      headers: { origin: new URL(page.url()).origin },
      data: { kind: "photo", documentId: privateDocument.id },
    },
  );
  expect(forged.status()).toBe(400);
  const forbiddenLink = await page.request.post(
    `/api/documents/${privateDocument.id}/link`,
    { headers: { origin: new URL(page.url()).origin }, data: {} },
  );
  expect(forbiddenLink.status()).toBe(404);
  await page.goto(`/offers/${seeded.offer.id}`);
  await expect(page.getByLabel("Evidence type", { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await page
    .getByLabel("Work note *", { exact: true })
    .fill("Synthetic completed work note");
  await page
    .getByRole("button", { name: "Save evidence", exact: true })
    .click();
  await expect(
    page.getByText("Synthetic completed work note", { exact: true }),
  ).toBeVisible();
  await page.getByLabel("Evidence type", { exact: true }).selectOption("photo");
  await page.getByLabel("Image *", { exact: true }).setInputFiles({
    name: "synthetic-my-work.png",
    mimeType: "image/png",
    buffer: png,
  });
  await page
    .getByLabel("Image description", { exact: true })
    .fill("Synthetic private photo");
  await page
    .getByRole("button", { name: "Save evidence", exact: true })
    .click();
  await expect(
    page.getByText("Synthetic private photo", { exact: true }),
  ).toBeVisible({ timeout: 30_000 });
  await page
    .getByRole("button", { name: "Create download link", exact: true })
    .click();
  const download = page.getByRole("link", {
    name: "Download photo",
    exact: true,
  });
  await expect(download).toBeVisible();
  const href = await download.getAttribute("href");
  expect(href).toMatch(/^\/api\/files\//);
  const file = await page.request.get(href!);
  expect(file.status()).toBe(200);
  expect(await file.body()).toEqual(png);
  page.once("dialog", (dialog) => dialog.accept());
  await page
    .getByRole("button", { name: "Submit job for review", exact: true })
    .click();
  await expect(
    page.getByText("Job submitted for review.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Submit job for review", exact: true }),
  ).toHaveCount(0);
  const own = (await (
    await page.request.get(`/api/my/offers/${seeded.offer.id}`)
  ).json()) as { job: { status: string } };
  expect(own.job.status).toBe("awaiting_review");
});

test("switching to a work note after an upload leaves the image unattached (#129)", async ({
  page,
}) => {
  await signIn(page, "owner");
  const seeded = await fixture(page);
  for (const to of ["approved", "assigned", "in_progress"])
    await write(page, `/api/jobs/${seeded.job.id}/status`, { to });
  await signIn(page, "subcontractor");
  await write(page, `/api/my/offers/${seeded.offer.id}`, {
    decision: "accept",
  });
  // Storage and attachment are mocked: this checks the form's contract only.
  let uploads = 0;
  const posted: Record<string, unknown>[] = [];
  await page.route("**/api/documents", async (route) => {
    uploads++;
    await route.fulfill({
      status: 201,
      json: { id: randomUUID(), fileName: "synthetic-switch.png" },
    });
  });
  await page.route(
    `**/api/my/work/${seeded.job.id}/evidence`,
    async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({ json: { evidence: [] } });
        return;
      }
      posted.push(route.request().postDataJSON() as Record<string, unknown>);
      await route.fulfill(
        posted.length === 1
          ? { status: 409, json: { error: "Synthetic attachment failure" } }
          : {
              status: 201,
              json: {
                id: randomUUID(),
                kind: "note",
                note: "Synthetic switched note",
                documentId: null,
                createdAt: new Date().toISOString(),
              },
            },
      );
    },
  );
  await page.goto(`/offers/${seeded.offer.id}`);
  const type = page.getByLabel("Evidence type", { exact: true });
  await expect(type).toBeVisible({ timeout: 30_000 });
  await type.selectOption("photo");
  await page.getByLabel("Image *", { exact: true }).setInputFiles({
    name: "synthetic-switch.png",
    mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jXioAAAAASUVORK5CYII=",
      "base64",
    ),
  });
  await page
    .getByRole("button", { name: "Save evidence", exact: true })
    .click();
  const pending = page.getByText(/Private upload ready: synthetic-switch\.png/);
  await expect(pending).toBeVisible();

  // Declining the warning keeps the photo and its pending upload.
  page.once("dialog", (dialog) => void dialog.dismiss());
  await type.selectOption("note");
  await expect(type).toHaveValue("photo");
  await expect(pending).toBeVisible();

  page.once("dialog", (dialog) => {
    expect(dialog.message()).toContain("uploaded but not attached");
    void dialog.accept();
  });
  await type.selectOption("note");
  await expect(type).toHaveValue("note");
  await expect(pending).toHaveCount(0);
  await expect(
    page.getByText("synthetic-switch.png won't be attached to this job.", {
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByLabel("Work note *", { exact: true })
    .fill("Synthetic switched note");
  await page
    .getByRole("button", { name: "Save evidence", exact: true })
    .click();
  await expect(
    page.getByText("Evidence attached to this job.", { exact: true }),
  ).toBeVisible();
  expect(uploads).toBe(1);
  expect(posted).toHaveLength(2);
  expect(posted[1]).toEqual({ kind: "note", note: "Synthetic switched note" });
});

test("a cancelled job in My jobs shows it needs no further work (#129)", async ({
  page,
}) => {
  await signIn(page, "owner");
  const seeded = await fixture(page);
  await signIn(page, "subcontractor");
  await write(page, `/api/my/offers/${seeded.offer.id}`, {
    decision: "accept",
  });
  await signIn(page, "owner");
  await write(page, `/api/jobs/${seeded.job.id}/status`, { to: "cancelled" });
  await signIn(page, "subcontractor");
  await page.goto("/jobs");
  await page
    .getByLabel("Search my jobs", { exact: true })
    .fill(seeded.job.reference);
  await page.getByRole("button", { name: "Search", exact: true }).click();
  const card = page.getByRole("listitem").filter({
    hasText: seeded.job.reference,
  });
  await expect(card).toHaveCount(1);
  await expect(card).toContainText("Job: Cancelled");
  await expect(card.getByText("Job cancelled", { exact: true })).toBeVisible();
  await expect(card).toContainText("No further work is needed on this job.");
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});
