import { randomUUID } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";
import { requireAccounts, signIn } from "./accounts";
import { syntheticAbn } from "../helpers/abn";
test.setTimeout(150_000);
test.beforeEach(() => {
  requireAccounts();
});

// #43 security review (threat model T02/T03): plant distinctive office-only
// values, then read everything a worker role can reach — server-rendered
// HTML (including the RSC payload) and JSON — and prove none of it leaks.
const AGREED_PRICE = "98765431"; // job's customer price, cents
const RIVAL_RATE = "76543219"; // another contractor's offered rate, cents
const EMPLOYEE_RATE = "87654321"; // employee hourly cost, cents
const MARKERS = [AGREED_PRICE, RIVAL_RATE, EMPLOYEE_RATE, "987,654.31"];
const OFFICE_KEYS =
  /agreedPrice|hourlyCost|costCents|committedCost|profit|margin|companyGstRegistered|contractorName|"abn"/i;

async function write<T>(
  page: Page,
  url: string,
  data: unknown,
  method = "POST",
  allow: number[] = [],
): Promise<T> {
  const response = await page.request.fetch(url, {
    method,
    headers: { origin: new URL(page.url()).origin },
    data,
  });
  expect(
    response.ok() || allow.includes(response.status()),
    `${method} ${url}: ${response.status()}`,
  ).toBe(true);
  return response.json() as Promise<T>;
}

async function memberId(page: Page, email: string, role: string) {
  const users = (await (
    await page.request.get(`/api/users?q=${encodeURIComponent(email)}`)
  ).json()) as { members: { userId: string; role: string }[] };
  return users.members.find((member) => member.role === role)!.userId;
}

async function seed(page: Page) {
  const accounts = requireAccounts();
  const suffix = randomUUID().slice(0, 8);
  const employeeUser = await memberId(
    page,
    accounts.emails.employee,
    "employee",
  );
  const { employees } = (await (
    await page.request.get("/api/employees?status=all&pageSize=100")
  ).json()) as {
    employees: { id: string; userId: string | null; isActive: boolean }[];
  };
  let employee = employees.find((row) => row.userId === employeeUser);
  employee ??= await write<{
    id: string;
    userId: string | null;
    isActive: boolean;
  }>(page, "/api/employees", {
    name: "Synthetic Exposure Employee",
    userId: employeeUser,
  });
  if (!employee.isActive)
    await write(
      page,
      `/api/employees/${employee.id}`,
      { isActive: true },
      "PATCH",
    );
  // Fixed start date: a rerun finds the same marker rate already there (409).
  await write(
    page,
    `/api/employees/${employee.id}/rates`,
    { effectiveFrom: "2001-02-03", hourlyCostCents: EMPLOYEE_RATE },
    "POST",
    [409],
  );

  const subUser = await memberId(
    page,
    accounts.emails.subcontractor,
    "subcontractor",
  );
  const { contractors } = (await (
    await page.request.get("/api/contractors?status=all&pageSize=100")
  ).json()) as { contractors: { id: string; userId: string | null }[] };
  let contractor = contractors.find((row) => row.userId === subUser);
  contractor ??= await write<{ id: string; userId: string | null }>(
    page,
    "/api/contractors",
    {
      name: `Synthetic exposure contractor ${suffix}`,
      userId: subUser,
      abn: syntheticAbn("246813579"),
      gstRegistered: true,
    },
  );
  const rival = await write<{ id: string }>(page, "/api/contractors", {
    name: `Synthetic exposure rival ${suffix}`,
  });

  const customer = await write<{ id: string }>(page, "/api/customers", {
    name: `Synthetic exposure customer ${suffix}`,
  });
  const job = await write<{ id: string; reference: string }>(
    page,
    "/api/jobs",
    {
      title: `Synthetic exposure work ${suffix}`,
      customerId: customer.id,
      agreedPriceExclusiveCents: AGREED_PRICE,
    },
  );
  await write(page, `/api/jobs/${job.id}/assignments`, {
    employeeId: employee.id,
  });
  const offer = await write<{ id: string }>(
    page,
    `/api/jobs/${job.id}/offers`,
    {
      contractorId: contractor.id,
      scope: `Exposure scope ${suffix}`,
      rateType: "fixed",
      rateExclusiveCents: "45600",
      taxCode: "TAXABLE_10",
    },
  );
  await write(page, `/api/jobs/${job.id}/offers`, {
    contractorId: rival.id,
    scope: `Rival scope ${suffix}`,
    rateType: "fixed",
    rateExclusiveCents: RIVAL_RATE,
    taxCode: "OUT_OF_SCOPE",
  });
  return { job, offer, employee, rival, suffix };
}

async function body(page: Page, url: string) {
  const response = await page.request.get(url);
  return { status: response.status(), text: await response.text() };
}

function expectClean(url: string, text: string) {
  for (const marker of MARKERS)
    expect(text.includes(marker), `${url} leaks ${marker}`).toBe(false);
}

test("workers' pages and JSON never carry prices, other rates or costs", async ({
  page,
}) => {
  await signIn(page, "owner");
  const seeded = await seed(page);
  // Positive control: the markers really are in office responses, so a clean
  // worker sweep below can't be a false negative.
  expect((await body(page, `/api/jobs/${seeded.job.id}`)).text).toContain(
    AGREED_PRICE,
  );
  expect(
    (await body(page, `/api/jobs/${seeded.job.id}/offers`)).text,
  ).toContain(RIVAL_RATE);
  expect(
    (await body(page, `/api/employees/${seeded.employee.id}/rates`)).text,
  ).toContain(EMPLOYEE_RATE);
  const office = [
    `/api/jobs/${seeded.job.id}`,
    `/api/jobs/${seeded.job.id}/offers`,
    `/api/jobs/${seeded.job.id}/evidence`,
    `/api/employees/${seeded.employee.id}`,
    `/api/employees/${seeded.employee.id}/rates`,
    `/api/contractors/${seeded.rival.id}`,
    "/api/timesheets",
    "/api/expenses",
    "/api/customers",
  ];

  await signIn(page, "subcontractor");
  await write(page, `/api/my/offers/${seeded.offer.id}`, {
    decision: "accept",
  });
  for (const url of [
    "/offers",
    `/offers/${seeded.offer.id}`,
    "/jobs",
    "/api/my/offers",
    `/api/my/offers/${seeded.offer.id}`,
    "/api/my/offers?view=jobs",
    "/api/company",
  ]) {
    const { status, text } = await body(page, url);
    expect(status, url).toBe(200);
    expectClean(url, text);
    if (url.startsWith("/api/"))
      expect(text, `${url} has office-only keys`).not.toMatch(OFFICE_KEYS);
  }
  // Their own agreed rate is theirs to see; the rival's never is.
  expect((await body(page, "/api/my/offers")).text).toContain("45600");
  for (const url of [...office, `/api/my/jobs/${seeded.job.id}`])
    expect([403, 404], `${url} should refuse a subcontractor`).toContain(
      (await body(page, url)).status,
    );

  await page.context().clearCookies();
  await signIn(page, "employee");
  for (const url of [
    "/jobs",
    `/jobs/${seeded.job.id}`,
    "/api/my/jobs",
    `/api/my/jobs/${seeded.job.id}`,
    "/api/my/timesheets",
    "/api/my/expenses",
    `/api/my/work/${seeded.job.id}/evidence`,
    "/api/company",
  ]) {
    const { status, text } = await body(page, url);
    expect(status, url).toBe(200);
    expectClean(url, text);
    if (url.startsWith("/api/"))
      expect(text, `${url} has office-only keys`).not.toMatch(OFFICE_KEYS);
  }
  for (const url of [...office, `/api/my/offers/${seeded.offer.id}`])
    expect([403, 404], `${url} should refuse an employee`).toContain(
      (await body(page, url)).status,
    );
  // Office pages for these records are 404s, not empty shells.
  for (const url of [
    `/employees/${seeded.employee.id}`,
    `/contractors/${seeded.rival.id}`,
    `/offers/${seeded.offer.id}`,
  ])
    expect((await body(page, url)).status, url).toBe(404);
});
