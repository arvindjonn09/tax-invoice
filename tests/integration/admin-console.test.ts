import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "../../packages/database/src/generated/prisma/client";
import {
  assignFullLicence,
  extendTrial,
  listOrganisations,
} from "../../apps/web/src/server/admin-console/data";
import {
  type CommittedDatabase,
  withCommittedDatabase,
} from "../helpers/committed-database";
import { syntheticFactory } from "../helpers/factories";

// #252: organisation list and audited licence actions.
let database: CommittedDatabase;
let db: PrismaClient;
const factory = syntheticFactory(0x2520);
const owner = factory.user();
const ids = { trial: "", demo: "" };
const NOW = new Date("2026-11-02T23:00:00Z"); // 3 Nov, Sydney

beforeAll(async () => {
  database = await withCommittedDatabase();
  db = database.client;
  await db.user.create({ data: owner });
  for (const kind of ["trial", "demo"] as const) {
    const company = {
      ...factory.company(owner.id),
      name: `Org ${kind}`,
      isDemo: kind === "demo",
      ...(kind === "trial"
        ? {
            accessMode: "trial" as const,
            trialStartedAt: NOW,
            trialLastDay: new Date("2026-11-10T00:00:00Z"),
          }
        : {}),
    };
    await db.$transaction(async (tx) => {
      await tx.company.create({ data: company });
      await tx.membership.create({
        data: factory.membership(company.id, owner.id),
      });
    });
    ids[kind] = company.id;
  }
}, 60_000);
afterAll(() => database?.release());

describe("admin console organisations", () => {
  it("lists licence, owner and counts", async () => {
    const rows = await listOrganisations(db, NOW);
    const trial = rows.find((row) => row.id === ids.trial);
    expect(trial).toMatchObject({
      licence: "trial",
      trialLastDay: "2026-11-10",
      daysRemaining: 8,
      members: 1,
      jobs: 0,
      owner: { email: owner.email },
    });
    expect(rows.find((row) => row.id === ids.demo)).toMatchObject({
      isDemo: true,
      licence: "full",
    });
  });

  it("extends a trial from its last day and audits it", async () => {
    expect(await extendTrial(db, ids.trial, 14, NOW)).toBe("2026-11-24");
    const company = await db.company.findUniqueOrThrow({
      where: { id: ids.trial },
    });
    expect(company.trialExtensionCount).toBe(1);
    expect(company.readOnlyFrom?.toISOString()).toBe(
      "2026-11-24T13:00:00.000Z",
    );
    // An ended trial restarts from today, not from its old last day.
    expect(
      await extendTrial(db, ids.trial, 1, new Date("2027-01-10T01:00:00Z")),
    ).toBe("2027-01-10");
    await expect(extendTrial(db, ids.trial, 0, NOW)).rejects.toThrow(
      /1 to 365/,
    );
  });

  it("applies overlapping extensions one after the other", async () => {
    const before = await db.company.findUniqueOrThrow({
      where: { id: ids.trial },
    });
    const start = before.trialLastDay?.toISOString().slice(0, 10) ?? "";
    const results = await Promise.all([
      extendTrial(db, ids.trial, 2, NOW),
      extendTrial(db, ids.trial, 2, NOW),
      extendTrial(db, ids.trial, 2, NOW),
    ]);
    expect(new Set(results).size).toBe(3);
    const after = await db.company.findUniqueOrThrow({
      where: { id: ids.trial },
    });
    expect(after.trialExtensionCount).toBe(before.trialExtensionCount + 3);
    const lastDay = after.trialLastDay?.toISOString().slice(0, 10) ?? "";
    expect((Date.parse(lastDay) - Date.parse(start)) / 86_400_000).toBe(6);
  });

  it("assigns a full licence once and refuses demo companies", async () => {
    await assignFullLicence(db, ids.trial);
    await assignFullLicence(db, ids.trial);
    const company = await db.company.findUniqueOrThrow({
      where: { id: ids.trial },
    });
    expect(company).toMatchObject({
      accessMode: "unrestricted",
      trialLastDay: null,
      readOnlyFrom: null,
    });
    const events = await db.auditEvent.findMany({
      where: { companyId: ids.trial },
      orderBy: { createdAt: "asc" },
    });
    expect(
      events.map((event) => [event.action, event.actorKind, event.createdBy]),
    ).toEqual([
      ...Array(5).fill(["trial.extended", "operator", null]),
      ["company.access_mode_changed", "operator", null],
    ]);
    await expect(assignFullLicence(db, ids.demo)).rejects.toThrow(/Demo/);
    await expect(extendTrial(db, ids.trial, 5, NOW)).rejects.toThrow(
      /full licence/,
    );
  });
});
