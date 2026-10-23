import {
  type Actor,
  type FieldRules,
  companyScope,
  requireSameCompany,
  visibleFields,
} from "@jobflow/authz";
import { z } from "zod";
import type {
  Customer,
  CustomerContact,
  Location,
  Prisma,
  PrismaClient,
} from "../../../../../packages/database/src/generated/prisma/client";
import { withAudit } from "../../../../../packages/database/src/index";
import { type PolicyHandler, privateJson } from "../authz/policy";
import { invalid, jsonOrNull } from "../company/handlers";
import {
  abnField,
  defined,
  emailField,
  optionalText,
  phoneField,
  postcodeField,
  requiredText,
  stateField,
  uuidOrNull,
} from "../http/fields";
import { parsePage } from "../http/guards";

// customer.read = owner, manager, accountant; customer.write = owner, manager.
// Employees and subcontractors see site details only through their own jobs.

const CUSTOMER_FIELDS: FieldRules<Customer> = {
  id: true,
  name: true,
  abn: true,
  billingEmail: true,
  billingPhone: true,
  addressLine1: true,
  addressLine2: true,
  suburb: true,
  state: true,
  postcode: true,
  archivedAt: true,
  createdAt: true,
  updatedAt: true,
};
const CONTACT_FIELDS: FieldRules<CustomerContact> = {
  id: true,
  customerId: true,
  name: true,
  position: true,
  email: true,
  phone: true,
  isPrimary: true,
  archivedAt: true,
};
const LOCATION_FIELDS: FieldRules<Location> = {
  id: true,
  customerId: true,
  label: true,
  addressLine1: true,
  addressLine2: true,
  suburb: true,
  state: true,
  postcode: true,
  accessNotes: true,
  archivedAt: true,
};

const customerFields = {
  name: requiredText(200, "Enter the customer's name"),
  abn: abnField,
  billingEmail: emailField,
  billingPhone: phoneField,
  addressLine1: optionalText(200),
  addressLine2: optionalText(200),
  suburb: optionalText(100),
  state: stateField.nullable(),
  postcode: postcodeField.nullable(),
};
const contactFields = {
  name: requiredText(200, "Enter the contact's name"),
  position: optionalText(100),
  email: emailField,
  phone: phoneField,
  isPrimary: z.boolean(),
};
const locationFields = {
  label: optionalText(100),
  addressLine1: requiredText(200, "Enter the street address"),
  addressLine2: optionalText(200),
  suburb: requiredText(100, "Enter the suburb"),
  state: stateField,
  postcode: postcodeField,
  accessNotes: optionalText(500),
};

const nonEmpty = (value: object) => Object.keys(value).length > 0;
const archive = { archived: z.boolean() };

const CreateCustomer = z
  .object(customerFields)
  .partial()
  .required({ name: true });
const UpdateCustomer = z
  .object({ ...customerFields, ...archive })
  .partial()
  .refine(nonEmpty, "Nothing to update");
const CreateContact = z
  .object(contactFields)
  .partial()
  .required({ name: true });
const UpdateContact = z
  .object({ ...contactFields, ...archive })
  .partial()
  .refine(nonEmpty, "Nothing to update");
const CreateLocation = z
  .object(locationFields)
  .partial()
  .required({ addressLine1: true, suburb: true, state: true, postcode: true });
const UpdateLocation = z
  .object({ ...locationFields, ...archive })
  .partial()
  .refine(nonEmpty, "Nothing to update");

const STATUS = z.enum(["active", "archived", "all"]).catch("active");

type CustomerContext = { params: Promise<{ id: string }> };
type ChildContext = { params: Promise<{ id: string; childId: string }> };

/** `archived: true|false` becomes archivedAt now/null; other keys pass through. */
function withArchive<T extends { archived?: boolean | undefined }>(data: T) {
  const { archived, ...rest } = data;
  return {
    ...defined(rest),
    ...(archived === undefined
      ? {}
      : { archivedAt: archived ? new Date() : null }),
  };
}

/** Audit action for an update: archive/restore when that's all that changed. */
function updateAction(
  entity: string,
  data: { archived?: boolean | undefined },
  keyCount: number,
): string {
  if (data.archived !== undefined && keyCount === 1)
    return `${entity}.${data.archived ? "archived" : "restored"}`;
  return `${entity}.updated`;
}

/** Only keys that changed, for audit before/after (sensitive ones redacted there). */
function pick<T extends object>(record: T, keys: readonly string[]) {
  return Object.fromEntries(
    keys.map((key) => [key, (record as Record<string, unknown>)[key]]),
  );
}

async function ownCustomer(
  db: PrismaClient | Prisma.TransactionClient,
  actor: Actor,
  id: string,
): Promise<Customer> {
  const safe = uuidOrNull(id);
  return requireSameCompany(
    actor,
    safe ? await db.customer.findUnique({ where: { id: safe } }) : null,
  );
}

/** Serialize directory writes per customer before reading audit preimages. */
async function lockCustomer(
  tx: Prisma.TransactionClient,
  actor: Actor,
  id: string,
): Promise<Customer> {
  const safe = uuidOrNull(id);
  if (safe) {
    await tx.$queryRaw`
      SELECT id FROM customers
      WHERE id = ${safe}::uuid AND company_id = ${actor.companyId}::uuid
      FOR UPDATE
    `;
  }
  return ownCustomer(tx, actor, id);
}

export function customerHandlers(db: () => PrismaClient) {
  /** Search and page customers. Pickers use the default `status=active`. */
  const list: PolicyHandler<unknown> = async ({ actor, request }) => {
    const params = new URL(request.url).searchParams;
    const { page, take, skip } = parsePage(params);
    const status = STATUS.parse(params.get("status") ?? undefined);
    const q = params.get("q")?.trim().slice(0, 100);
    const filter: Prisma.CustomerWhereInput = {
      ...(status === "all"
        ? {}
        : { archivedAt: status === "active" ? null : { not: null } }),
      ...(q
        ? {
            OR: [
              { name: { contains: q, mode: "insensitive" } },
              { billingEmail: { contains: q, mode: "insensitive" } },
              { abn: { contains: q.replaceAll(" ", "") } },
              { suburb: { contains: q, mode: "insensitive" } },
            ],
          }
        : {}),
    };
    const where: Prisma.CustomerWhereInput = companyScope(actor, filter);
    const [rows, total] = await Promise.all([
      db().customer.findMany({
        where,
        orderBy: [{ name: "asc" }, { id: "asc" }],
        take,
        skip,
      }),
      db().customer.count({ where }),
    ]);
    return privateJson({
      page,
      pageSize: take,
      total,
      customers: rows.map((row) => visibleFields(actor, row, CUSTOMER_FIELDS)),
    });
  };

  /** One customer with its contacts and locations (archived ones flagged). */
  const read: PolicyHandler<CustomerContext> = async ({ actor, context }) => {
    const { id } = await context.params;
    const customer = await ownCustomer(db(), actor, id);
    const [contacts, locations] = await Promise.all([
      db().customerContact.findMany({
        where: { companyId: actor.companyId, customerId: customer.id },
        orderBy: [{ isPrimary: "desc" }, { name: "asc" }],
      }),
      db().location.findMany({
        where: { companyId: actor.companyId, customerId: customer.id },
        orderBy: [{ label: "asc" }, { addressLine1: "asc" }],
      }),
    ]);
    return privateJson({
      ...visibleFields(actor, customer, CUSTOMER_FIELDS),
      contacts: contacts.map((row) =>
        visibleFields(actor, row, CONTACT_FIELDS),
      ),
      locations: locations.map((row) =>
        visibleFields(actor, row, LOCATION_FIELDS),
      ),
    });
  };

  const create: PolicyHandler<unknown> = async ({ actor, request }) => {
    const parsed = CreateCustomer.safeParse(await jsonOrNull(request));
    if (!parsed.success) return invalid(parsed.error);
    const data = defined(parsed.data);
    const row = await withAudit(db(), async (tx, audit) => {
      const created = await tx.customer.create({
        data: { ...data, companyId: actor.companyId, createdBy: actor.userId },
      });
      await audit({
        companyId: actor.companyId,
        actorUserId: actor.userId,
        action: "customer.created",
        target: { type: "customer", id: created.id },
        after: pick(created, Object.keys(data)),
      });
      return created;
    });
    return privateJson(visibleFields(actor, row, CUSTOMER_FIELDS), {
      status: 201,
    });
  };

  const update: PolicyHandler<CustomerContext> = async ({
    actor,
    request,
    context,
  }) => {
    const { id } = await context.params;
    const parsed = UpdateCustomer.safeParse(await jsonOrNull(request));
    if (!parsed.success) return invalid(parsed.error);
    const data = withArchive(parsed.data);
    const keys = Object.keys(data);
    const row = await withAudit(db(), async (tx, audit) => {
      const before = await lockCustomer(tx, actor, id);
      const updated = await tx.customer.update({
        where: { id: before.id },
        data,
      });
      await audit({
        companyId: actor.companyId,
        actorUserId: actor.userId,
        action: updateAction("customer", parsed.data, keys.length),
        target: { type: "customer", id: before.id },
        before: pick(before, keys),
        after: pick(updated, keys),
      });
      return updated;
    });
    return privateJson(visibleFields(actor, row, CUSTOMER_FIELDS));
  };

  const addContact: PolicyHandler<CustomerContext> = async ({
    actor,
    request,
    context,
  }) => {
    const { id } = await context.params;
    const parsed = CreateContact.safeParse(await jsonOrNull(request));
    if (!parsed.success) return invalid(parsed.error);
    const data = defined(parsed.data);
    const row = await withAudit(db(), async (tx, audit) => {
      const customer = await lockCustomer(tx, actor, id);
      if (data.isPrimary) await clearPrimary(tx, actor.companyId, customer.id);
      const created = await tx.customerContact.create({
        data: {
          ...data,
          companyId: actor.companyId,
          customerId: customer.id,
          createdBy: actor.userId,
        },
      });
      await audit({
        companyId: actor.companyId,
        actorUserId: actor.userId,
        action: "customer_contact.created",
        target: { type: "customer_contact", id: created.id },
        after: pick(created, Object.keys(data)),
      });
      return created;
    });
    return privateJson(visibleFields(actor, row, CONTACT_FIELDS), {
      status: 201,
    });
  };

  const updateContact: PolicyHandler<ChildContext> = async ({
    actor,
    request,
    context,
  }) => {
    const { id, childId } = await context.params;
    const parsed = UpdateContact.safeParse(await jsonOrNull(request));
    if (!parsed.success) return invalid(parsed.error);
    const data = withArchive(parsed.data);
    const keys = Object.keys(data);
    const row = await withAudit(db(), async (tx, audit) => {
      const customer = await lockCustomer(tx, actor, id);
      const safe = uuidOrNull(childId);
      const before = requireSameCompany(
        actor,
        safe
          ? await tx.customerContact.findFirst({
              where: { id: safe, customerId: customer.id },
            })
          : null,
      );
      if (parsed.data.isPrimary)
        await clearPrimary(tx, actor.companyId, customer.id);
      const updated = await tx.customerContact.update({
        where: { id: before.id },
        data,
      });
      await audit({
        companyId: actor.companyId,
        actorUserId: actor.userId,
        action: updateAction("customer_contact", parsed.data, keys.length),
        target: { type: "customer_contact", id: before.id },
        before: pick(before, keys),
        after: pick(updated, keys),
      });
      return updated;
    });
    return privateJson(visibleFields(actor, row, CONTACT_FIELDS));
  };

  const addLocation: PolicyHandler<CustomerContext> = async ({
    actor,
    request,
    context,
  }) => {
    const { id } = await context.params;
    const parsed = CreateLocation.safeParse(await jsonOrNull(request));
    if (!parsed.success) return invalid(parsed.error);
    const data = defined(parsed.data);
    const row = await withAudit(db(), async (tx, audit) => {
      const customer = await lockCustomer(tx, actor, id);
      const created = await tx.location.create({
        data: {
          ...data,
          companyId: actor.companyId,
          customerId: customer.id,
          createdBy: actor.userId,
        },
      });
      await audit({
        companyId: actor.companyId,
        actorUserId: actor.userId,
        action: "location.created",
        target: { type: "location", id: created.id },
        after: pick(created, Object.keys(data)),
      });
      return created;
    });
    return privateJson(visibleFields(actor, row, LOCATION_FIELDS), {
      status: 201,
    });
  };

  const updateLocation: PolicyHandler<ChildContext> = async ({
    actor,
    request,
    context,
  }) => {
    const { id, childId } = await context.params;
    const parsed = UpdateLocation.safeParse(await jsonOrNull(request));
    if (!parsed.success) return invalid(parsed.error);
    const data = withArchive(parsed.data);
    const keys = Object.keys(data);
    const row = await withAudit(db(), async (tx, audit) => {
      const customer = await lockCustomer(tx, actor, id);
      const safe = uuidOrNull(childId);
      const before = requireSameCompany(
        actor,
        safe
          ? await tx.location.findFirst({
              where: { id: safe, customerId: customer.id },
            })
          : null,
      );
      const updated = await tx.location.update({
        where: { id: before.id },
        data,
      });
      await audit({
        companyId: actor.companyId,
        actorUserId: actor.userId,
        action: updateAction("location", parsed.data, keys.length),
        target: { type: "location", id: before.id },
        before: pick(before, keys),
        after: pick(updated, keys),
      });
      return updated;
    });
    return privateJson(visibleFields(actor, row, LOCATION_FIELDS));
  };

  return {
    list,
    read,
    create,
    update,
    addContact,
    updateContact,
    addLocation,
    updateLocation,
  };
}

/** At most one primary contact per customer. */
async function clearPrimary(
  tx: Prisma.TransactionClient,
  companyId: string,
  customerId: string,
) {
  await tx.customerContact.updateMany({
    where: { companyId, customerId, isPrimary: true },
    data: { isPrimary: false },
  });
}
