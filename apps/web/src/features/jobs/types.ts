import type { JobStatus } from "@jobflow/domain";
export type Visit = {
  id: string;
  startsAt: string;
  endsAt: string | null;
  status: "scheduled" | "completed" | "cancelled";
  notes?: string | null;
};
export type Assignment = {
  id: string;
  employeeId: string;
  employeeName: string;
  employeeActive: boolean;
  visitId: string | null;
  assignedAt: string;
  endedAt: string | null;
};
export type Job = {
  id: string;
  reference: string;
  title: string;
  status: JobStatus;
  dueOn: string | null;
  description?: string | null;
  customerId?: string;
  customerName?: string;
  locationId?: string | null;
  agreedPriceExclusiveCents?: string | null;
  visits?: Visit[];
  assignments?: Assignment[];
  statusHistory?: {
    id: string;
    fromStatus: JobStatus | null;
    toStatus: JobStatus;
    note: string | null;
    createdAt: string;
    actorName: string;
  }[];
  site?: {
    label: string | null;
    addressLine1: string;
    addressLine2: string | null;
    suburb: string;
    state: string;
    postcode: string;
    accessNotes: string | null;
  } | null;
};
export const statusLabel = (status: string) =>
  status.replaceAll("_", " ").replace(/^./, (value) => value.toUpperCase());
export function day(value: string | null | undefined) {
  return value
    ? new Intl.DateTimeFormat("en-AU", {
        dateStyle: "medium",
        timeZone: "UTC",
      }).format(new Date(`${value}T00:00:00Z`))
    : "Not set";
}
export function time(value: string) {
  return new Intl.DateTimeFormat("en-AU", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}
