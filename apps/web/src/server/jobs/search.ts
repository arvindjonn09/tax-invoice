import { JOB_STATUSES } from "@jobflow/domain";
import { z } from "zod";
import type { Prisma } from "../../../../../packages/database/src/generated/prisma/client";
export function jobSearch(params: URLSearchParams): Prisma.JobWhereInput {
  const status = z
    .enum(JOB_STATUSES)
    .optional()
    .catch(undefined)
    .parse(params.get("status") || undefined);
  const q = params.get("q")?.trim().slice(0, 100);
  return {
    ...(status ? { status } : {}),
    ...(q
      ? {
          OR: [
            { title: { contains: q, mode: "insensitive" } },
            { reference: { contains: q, mode: "insensitive" } },
          ],
        }
      : {}),
  };
}
export function jobOrder(
  params: URLSearchParams,
): Prisma.JobOrderByWithRelationInput[] {
  const sort = z
    .enum(["number", "title", "dueOn", "status"])
    .catch("number")
    .parse(params.get("sort"));
  const direction = z
    .enum(["asc", "desc"])
    .catch("desc")
    .parse(params.get("direction"));
  return [
    sort === "dueOn"
      ? { dueOn: { sort: direction, nulls: "last" } }
      : { [sort]: direction },
    { id: "asc" },
  ];
}
