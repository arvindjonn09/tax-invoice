import { appendFileSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import {
  expect,
  test,
  type APIRequestContext,
  type APIResponse,
} from "@playwright/test";

// #65: does the deployed environment work end to end? Read-only checks run
// on every smoke run; the signed-in workflow creates clearly named synthetic
// records and runs only with a synthetic owner's SMOKE_EMAIL/SMOKE_PASSWORD.
const origin = process.env.SMOKE_BASE_URL!;
const email = process.env.SMOKE_EMAIL;
const password = process.env.SMOKE_PASSWORD;
const smokeCompanyId = process.env.SMOKE_COMPANY_ID || undefined;
const requireSignedIn = process.env.SMOKE_REQUIRE_SIGNED_IN === "1";
const behindCloudflare = origin.startsWith("https:");

/** A line in the GitHub job summary, so a skip can't pass for a real run. */
function summary(line: string) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (file) appendFileSync(file, `${line}\n`);
}

function expectPrivate(response: APIResponse) {
  expect(response.headers()["cache-control"]).toMatch(/no-store/);
}

/**
 * Behind Cloudflare, a private response must never come from the edge cache.
 * The first request could be a MISS that fills the cache, so the second one
 * is the test; the header must be present, or this checks nothing.
 */
async function expectNotEdgeCached(request: APIRequestContext, path: string) {
  await request.get(path);
  const second = await request.get(path);
  const status = second.headers()["cf-cache-status"];
  if (behindCloudflare)
    expect(status, `${path}: no cf-cache-status header`).toBeTruthy();
  expect(status ?? "").not.toBe("HIT");
  return second;
}

test.describe("public checks", () => {
  test("liveness and readiness answer, uncached", async ({ request }) => {
    const live = await request.get("/api/health");
    expect(live.status()).toBe(200);
    const ready = await request.get("/api/health/ready");
    expect(ready.status(), "database or storage not ready").toBe(200);
    expectPrivate(ready);
    await expectNotEdgeCached(request, "/api/health/ready");
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
    await expectNotEdgeCached(request, "/login");
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
    await expectNotEdgeCached(request, "/api/company");
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
  test("an owner signs in, records a synthetic customer, job and draft invoice, and signs out", async ({
    page,
  }) => {
    if (!email || !password) {
      summary(
        "Signed-in workflow: **SKIPPED** (SMOKE_EMAIL/SMOKE_PASSWORD not set)",
      );
      expect(
        requireSignedIn,
        "SMOKE_REQUIRE_SIGNED_IN=1 but SMOKE_EMAIL/SMOKE_PASSWORD are not set",
      ).toBe(false);
      test.skip(true, "SMOKE_EMAIL/SMOKE_PASSWORD not set");
      return;
    }
    test.setTimeout(120_000);
    await page.goto("/login");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL((url) =>
      ["/home", "/dashboard", "/choose-company"].includes(url.pathname),
    );
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

    // Only a demo-flagged company (or the one named by SMOKE_COMPANY_ID) may
    // receive smoke records: they burn a job number and can only be archived.
    const companyResponse = await page.request.get("/api/company");
    expect(companyResponse.status()).toBe(200);
    expectPrivate(companyResponse);
    const company = (await companyResponse.json()) as {
      id: string;
      isDemo: boolean;
    };
    expect(
      company.isDemo === true ||
        (smokeCompanyId !== undefined && company.id === smokeCompanyId),
      "refusing to write: the smoke account's company is not demo-flagged and is not SMOKE_COMPANY_ID",
    ).toBe(true);

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
        `${path}: HTTP ${response.status()}`,
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
    let invoiceId: string | undefined;
    try {
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
      invoiceId = invoice.id;
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
    } finally {
      // The draft is discarded (drafts may be deleted; issued documents never).
      if (invoiceId) {
        const discarded = await page.request.delete(
          `/api/invoices/${invoiceId}`,
          {
            headers: { origin },
          },
        );
        expect(discarded.status(), "discarding the smoke draft").toBeLessThan(
          300,
        );
      }
    }

    // Sign out, and the session no longer reads company data.
    const signOut = await page.request.post("/api/auth/sign-out", {
      headers: { origin },
      data: {},
    });
    expect(signOut.status()).toBeLessThan(300);
    expect((await page.request.get("/api/company")).status()).toBe(401);
    summary("Signed-in workflow: **RAN**");
  });
});
