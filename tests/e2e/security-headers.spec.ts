import { expect, test } from "@playwright/test";

// #71: every page and API response carries the security headers, pages run
// under a per-request nonce CSP with no violations, and cross-origin
// mutations are refused before authentication.

for (const path of ["/login", "/api/health", "/design-system/shell"]) {
  test(`${path} sends the security headers`, async ({ request }) => {
    const response = await request.get(path);
    const headers = response.headers();
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["x-frame-options"]).toBe("DENY");
    expect(headers["referrer-policy"]).toBe("same-origin");
    expect(headers["permissions-policy"]).toContain("camera=()");
    expect(headers["content-security-policy"]).toMatch(
      /script-src 'self' 'nonce-[A-Za-z0-9+/=]+' 'strict-dynamic'/,
    );
    expect(headers["content-security-policy"]).toContain(
      "frame-ancestors 'none'",
    );
    expect(headers["x-powered-by"]).toBeUndefined();
  });
}

test("each page view gets a fresh nonce that its scripts carry", async ({
  request,
}) => {
  const nonceOf = async () => {
    const response = await request.get("/login");
    const csp = response.headers()["content-security-policy"] ?? "";
    const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];
    expect(nonce).toBeTruthy();
    const html = await response.text();
    expect(html).toContain(`nonce="${nonce}"`);
    return nonce;
  };
  expect(await nonceOf()).not.toBe(await nonceOf());
});

for (const path of ["/login", "/design-system/shell?role=owner"]) {
  test(`${path} renders and hydrates without CSP violations`, async ({
    page,
  }) => {
    const violations: string[] = [];
    page.on("console", (message) => {
      if (/Content Security Policy|Refused to/i.test(message.text()))
        violations.push(message.text());
    });
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    // Client hydration ran (scripts were allowed): theme provider set a class.
    await expect(page.locator("html")).toHaveClass(/light|dark/);
    expect(violations).toEqual([]);
  });
}

test("a cross-origin mutation is refused before authentication", async ({
  request,
}) => {
  const response = await request.patch("/api/company", {
    headers: { origin: "https://evil.example" },
    data: { name: "Forged" },
  });
  expect(response.status()).toBe(403);
  expect(response.headers()["cache-control"]).toBe("private, no-store");
});
