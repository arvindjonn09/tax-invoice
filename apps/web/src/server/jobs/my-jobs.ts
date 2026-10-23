import { type Actor, notFound } from "@jobflow/authz";
import type {
  Prisma,
  PrismaClient,
} from "../../../../../packages/database/src/generated/prisma/client";
import { type PolicyHandler, privateJson } from "../authz/policy";
import { toDay } from "../company/gst";
import { uuidOrNull } from "../http/fields";
import { parsePage } from "../http/guards";

// #32. What an employee sees of their own work (job.read_assigned). Built
// from an explicit allowlist — never from the office job record — so the
// agreed price, costs and profit can't leak into these responses.

type JobContext = { params: Promise<{ id: string }> };

/** Live assignments of the actor's own active employee record. */
function assignedTo(actor: Actor): Prisma.JobWhereInput {
  return {
    companyId: actor.companyId,
    assignments: {
      some: {
        endedAt: null,
        employee: {
          companyId: actor.companyId,
          userId: actor.userId,
          isActive: true,
        },
      },
    },
  };
}

const SUMMARY = {
  id: true,
  reference: true,
  title: true,
  status: true,
  dueOn: true,
  customer: { select: { name: true } },
  location: { select: { suburb: true, state: true } },
} as const satisfies Prisma.JobSelect;

const DETAIL = {
  id: true,
  reference: true,
  title: true,
  description: true,
  status: true,
  dueOn: true,
  customer: { select: { name: true } },
  location: {
    select: {
      label: true,
      addressLine1: true,
      addressLine2: true,
      suburb: true,
      state: true,
      postcode: true,
      accessNotes: true,
    },
  },
  visits: {
    select: { id: true, startsAt: true, endsAt: true, status: true },
    orderBy: { startsAt: "asc" },
  },
} as const satisfies Prisma.JobSelect;

export function myJobHandlers(db: () => PrismaClient) {
  const list: PolicyHandler<unknown> = async ({ actor, request }) => {
    const { page, take, skip } = parsePage(new URL(request.url).searchParams);
    const where = assignedTo(actor);
    const [rows, total] = await Promise.all([
      db().job.findMany({
        where,
        select: SUMMARY,
        orderBy: [
          { dueOn: { sort: "asc", nulls: "last" } },
          { number: "desc" },
        ],
        take,
        skip,
      }),
      db().job.count({ where }),
    ]);
    return privateJson({
      page,
      pageSize: take,
      total,
      jobs: rows.map((row) => ({
        id: row.id,
        reference: row.reference,
        title: row.title,
        status: row.status,
        dueOn: row.dueOn ? toDay(row.dueOn) : null,
        customerName: row.customer.name,
        site: row.location
          ? { suburb: row.location.suburb, state: row.location.state }
          : null,
      })),
    });
  };

  /** Another job — someone else's, another company's, or unknown — is a 404. */
  const read: PolicyHandler<JobContext> = async ({ actor, context }) => {
    const id = uuidOrNull((await context.params).id);
    const row = id
      ? await db().job.findFirst({
          where: { id, ...assignedTo(actor) },
          select: DETAIL,
        })
      : null;
    if (!row) throw notFound();
    return privateJson({
      id: row.id,
      reference: row.reference,
      title: row.title,
      description: row.description,
      status: row.status,
      dueOn: row.dueOn ? toDay(row.dueOn) : null,
      customerName: row.customer.name,
      site: row.location,
      visits: row.visits,
    });
  };

  return { list, read };
}
