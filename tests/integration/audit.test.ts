import { afterAll, beforeAll, expect, it } from "vitest";
import type { PrismaClient } from "../../packages/database/src/generated/prisma/client";
import {
  REDACTED,
  listAuditEvents,
  withAudit,
} from "../../packages/database/src/index";
import {
  type CommittedDatabase,
  withCommittedDatabase,
} from "../helpers/committed-database";
import { syntheticFactory } from "../helpers/factories";

// Audited transactions COMMIT, so this file uses its own disposable database.
let database: CommittedDatabase;
let client: PrismaClient;
const factory = syntheticFactory(0x1515);
const tenant = { owner: factory.user(), company: { id: "" } };
const other = { owner: factory.user(), company: { id: "" } };

beforeAll(async () => {
  database = await withCommittedDatabase();
  client = database.client;
  for (const party of [tenant, other]) {
    const company = factory.company(party.owner.id);
    await client.$transaction(async (tx) => {
      await tx.user.create({ data: party.owner });
      await tx.company.create({ data: company });
      await tx.membership.create({
        data: factory.membership(company.id, party.owner.id),
      });
    });
    party.company = { id: company.id };
  }
}, 60_000);
afterAll(() => database?.release());

const renameEvent = (before: string, after: string) => ({
  companyId: tenant.company.id,
  actorUserId: tenant.owner.id,
  action: "company.renamed",
  target: { type: "company", id: tenant.company.id },
  requestId: "req-0001",
  before: { name: before },
  after: { name: after },
});

it("commits the change and its audit event together", async () => {
  const before = "Synthetic Test Company";
  const renamed = await withAudit(client, async (tx, audit) => {
    const company = await tx.company.update({
      where: { id: tenant.company.id },
      data: { name: "Sample Renamed Co" },
    });
    await audit(renameEvent(before, company.name));
    return company;
  });
  expect(renamed.name).toBe("Sample Renamed Co");
  const [event] = await listAuditEvents(client, {
    companyId: tenant.company.id,
    target: { type: "company", id: tenant.company.id },
  });
  expect(event).toMatchObject({
    companyId: tenant.company.id,
    createdBy: tenant.owner.id,
    action: "company.renamed",
    targetType: "company",
    targetId: tenant.company.id,
    metadata: {
      requestId: "req-0001",
      changes: { name: { before, after: "Sample Renamed Co" } },
    },
  });
  expect(event?.createdAt).toBeInstanceOf(Date);
});

it("leaves neither the change nor the event when the transaction fails", async () => {
  const count = await client.auditEvent.count({
    where: { companyId: tenant.company.id },
  });
  await expect(
    withAudit(client, async (tx, audit) => {
      await tx.company.update({
        where: { id: tenant.company.id },
        data: { name: "Sample Never Saved" },
      });
      await audit(renameEvent("x", "Sample Never Saved"));
      throw new Error("later step failed");
    }),
  ).rejects.toThrow("later step failed");
  expect(
    await client.auditEvent.count({ where: { companyId: tenant.company.id } }),
  ).toBe(count);
  expect(
    (
      await client.company.findUniqueOrThrow({
        where: { id: tenant.company.id },
      })
    ).name,
  ).not.toBe("Sample Never Saved");
});

it("rejects and rolls back an audited transaction that records no event", async () => {
  await expect(
    withAudit(client, async (tx) => {
      await tx.company.update({
        where: { id: tenant.company.id },
        data: { name: "Sample Unaudited" },
      });
    }),
  ).rejects.toThrow("recorded no audit event");
  expect(
    (
      await client.company.findUniqueOrThrow({
        where: { id: tenant.company.id },
      })
    ).name,
  ).not.toBe("Sample Unaudited");
});

it("stores redacted values for sensitive fields", async () => {
  await withAudit(client, (_tx, audit) =>
    audit({
      companyId: tenant.company.id,
      actorUserId: tenant.owner.id,
      action: "user.email_changed",
      target: { type: "user", id: tenant.owner.id },
      before: { email: "old@example.test" },
      after: { email: "new@example.test" },
    }),
  );
  const [event] = await listAuditEvents(client, {
    companyId: tenant.company.id,
    target: { type: "user", id: tenant.owner.id },
  });
  expect(event?.metadata).toEqual({
    changes: { email: { before: REDACTED, after: REDACTED } },
  });
  expect(JSON.stringify(event)).not.toContain("example.test");
});

it("refuses an actor from another company", async () => {
  await expect(
    withAudit(client, (_tx, audit) =>
      audit({ ...renameEvent("a", "b"), actorUserId: other.owner.id }),
    ),
  ).rejects.toThrow();
});

it.each([
  { action: "Renamed" },
  { action: "company" },
  { target: { type: "Company", id: "x" } },
  { target: { type: "company", id: " " } },
  { target: { type: "company", id: "x".repeat(201) } },
  { requestId: "bad id with spaces" },
  { after: { name: "x".repeat(20_000) } },
])("validates event input %#", async (override) => {
  await expect(
    withAudit(client, (_tx, audit) =>
      audit({ ...renameEvent("a", "b"), ...override }),
    ),
  ).rejects.toThrow(RangeError);
});

it("offers no way to modify or delete audit history", async () => {
  const [event] = await listAuditEvents(client, {
    companyId: tenant.company.id,
    take: 1,
  });
  expect(event).toBeDefined();
  const id = event?.id ?? "";
  await expect(
    client.auditEvent.update({ where: { id }, data: { action: "x.y" } }),
  ).rejects.toThrow();
  await expect(client.auditEvent.delete({ where: { id } })).rejects.toThrow();
  await expect(client.auditEvent.deleteMany({})).rejects.toThrow();
  expect(await client.auditEvent.findUnique({ where: { id } })).not.toBeNull();
});

it("lists only the requested company's events, newest first, bounded", async () => {
  await withAudit(client, (_tx, audit) =>
    audit({
      companyId: other.company.id,
      actorUserId: other.owner.id,
      action: "company.viewed_settings",
      target: { type: "company", id: other.company.id },
    }),
  );
  const events = await listAuditEvents(client, {
    companyId: tenant.company.id,
  });
  expect(events.length).toBeGreaterThan(0);
  expect(events.every((event) => event.companyId === tenant.company.id)).toBe(
    true,
  );
  const times = events.map((event) => event.createdAt.getTime());
  expect([...times].sort((a, b) => b - a)).toEqual(times);
  for (const take of [0, 101, 1.5]) {
    expect(() =>
      listAuditEvents(client, { companyId: tenant.company.id, take }),
    ).toThrow(RangeError);
  }
});
