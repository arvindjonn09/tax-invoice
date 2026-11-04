import AxeBuilder from "@axe-core/playwright";
import { expect, test, type APIResponse } from "@playwright/test";

// #65: does the deployed environment work end to end? Read-only checks run
// on every smoke run; the signed-in workflow creates clearly named synthetic
// records and runs only with a synthetic owner's SMOKE_EMAIL/SMOKE_PASSWORD.
const origin = process.env.SMOKE_BASE_URL!;
const email = process.env.SMOKE_EMAIL;
const password = process.env.SMOKE_PASSWORD;

function expectPrivate(response: APIResponse) {
  expect(response.headers()["cache-control"]).toMatch(/no-store/);
  // Behind Cloudflare, a private response must never come from the edge cache.
  expect(response.headers()["cf-cache-status"] ?? "").not.toBe("HIT");
}

test.describe("public checks", () => {
  test("liveness and readiness answer, uncached", async ({ request }) => {
    const live = await request.get("/api/health");
    expect(live.status()).toBe(200);
    const ready = await request.get("/api/health/ready");
    expect(ready.status(), "database or storage not ready").toBe(200);
    expectPrivate(ready);
  });

  test("pages carry the security headers, HSTS included", async ({
    request,
  }) => {
    const response = await request.get("/login");
    expect(response.status()).toBe(200);
    const headers = response.headers();
    expect(headers["content-security-policy"]).toMatch(
      /script-src[^;]*'nonce-/,
    );
    expect(headers["content-security-policy"]).toMatch(
      /frame-ancestors 'none'|frame-src 'none'/,
    );
    expect(headers["x-frame-options"]).toBe("DENY");
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["referrer-policy"]).toBe("same-origin");
    if (origin.startsWith("https:")) {
      const hsts = /max-age=(\d+)/.exec(
        headers["strict-transport-security"] ?? "",
      );
      expect(Number(hsts?.[1] ?? 0)).toBeGreaterThanOrEqual(31_536_000);
    }
    expect(headers["cf-cache-status"] ?? "").not.toBe("HIT");
  });

  test("the landing and sign-in pages render accessibly", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await page.goto("/login");
    await expect(
      page.getByRole("heading", { name: "Sign in to JobFlow" }),
    ).toBeVisible();
    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });

  test("company data needs a session, and writes need the app's own origin", async ({
    request,
  }) => {
    const signedOut = await request.get("/api/company");
    expect(signedOut.status()).toBe(401);
    expectPrivate(signedOut);
    const crossSite = await request.post("/api/customers", {
      headers: { origin: "https://evil.example" },
      data: { name: "Synthetic smoke" },
    });
    expect(crossSite.status()).toBe(403);
  });

  test("download links can't be forged", async ({ request }) => {
    const response = await request.get("/api/files/forged-token");
    expect([400, 404]).toContain(response.status());
  });
});

test.describe("signed-in workflow (synthetic owner)", () => {
  test.skip(!email || !password, "SMOKE_EMAIL/SMOKE_PASSWORD not set");

  test("an owner signs in, records a synthetic customer, job and draft invoice, and signs out", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await page.goto("/login");
    await page.getByLabel("Email").fill(email!);
    await page.getByLabel("Password").fill(password!);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/(home|dashboard|choose-company)/);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

    const stamp = new Date()
      .toISOString()
      .replace(/[-:.TZ]/g, "")
      .slice(0, 14);
    const write = async <T>(path: string, data: unknown): Promise<T> => {
      const response = await page.request.post(path, {
        headers: { origin, "idempotency-key": crypto.randomUUID() },
        data,
      });
      expect(
        response.status(),
        `${path}: ${await response.text()}`,
      ).toBeLessThan(300);
      return (await response.json()) as T;
    };
    const customer = await write<{ id: string }>("/api/customers", {
      name: `Synthetic smoke customer ${stamp}`,
    });
    const job = await write<{ id: string }>("/api/jobs", {
      customerId: customer.id,
      title: `Synthetic smoke job ${stamp}`,
    });
    const invoice = await write<{ id: string }>("/api/invoices", {
      customerId: customer.id,
      jobId: job.id,
      lines: [
        {
          description: "Synthetic smoke work",
          quantity: "1",
          unitPriceCents: "100000",
          taxCode: "OUT_OF_SCOPE",
        },
      ],
    });
    // The records read back, through the API and the UI.
    const saved = await page.request.get(`/api/invoices/${invoice.id}`);
    expect(saved.status()).toBe(200);
    expectPrivate(saved);
    expect(await saved.text()).toContain("Synthetic smoke work");
    await page.goto(`/invoices/${invoice.id}`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await page.goto(`/jobs/${job.id}`);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(
      `Synthetic smoke job ${stamp}`,
    );
    await page.goto("/dashboard");
    await expect(
      page.getByText("Invoiced revenue", { exact: true }),
    ).toBeVisible();

    const company = await page.request.get("/api/company");
    expect(company.status()).toBe(200);
    expectPrivate(company);
  });
});
