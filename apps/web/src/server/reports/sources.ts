import type { Prisma } from "../../../../../packages/database/src/generated/prisma/client";

// What each report event came from (#56/#58), in this company only: the
// export's source columns and the report screens' drill-down labels.
export type SourceLabel = { type: string; reference: string; party: string };
/** What each GST event came from, in this company only. */
export async function sourceLabels(
  tx: Prisma.TransactionClient,
  companyId: string,
  ids: readonly string[],
) {
  const unique = [...new Set(ids)];
  const [invoices, bills, credits, expenses, adjustments, timesheets] =
    await Promise.all([
      tx.invoice.findMany({
        where: { companyId, id: { in: unique } },
        select: {
          id: true,
          kind: true,
          reference: true,
          number: true,
          customer: { select: { name: true } },
        },
      }),
      tx.supplierBill.findMany({
        where: { companyId, id: { in: unique } },
        select: { id: true, supplierName: true, supplierReference: true },
      }),
      tx.supplierCredit.findMany({
        where: { companyId, id: { in: unique } },
        select: {
          id: true,
          supplierReference: true,
          bill: { select: { supplierName: true } },
        },
      }),
      tx.expense.findMany({
        where: { companyId, id: { in: unique } },
        select: { id: true, supplierName: true, description: true },
      }),
      tx.gstManualAdjustment.findMany({
        where: { companyId, id: { in: unique } },
        select: { id: true, reason: true },
      }),
      tx.timesheet.findMany({
        where: { companyId, id: { in: unique } },
        select: {
          id: true,
          workDate: true,
          employee: { select: { name: true } },
        },
      }),
    ]);
  const labels = new Map<string, SourceLabel>();
  for (const i of invoices)
    labels.set(i.id, {
      type: i.kind === "credit_note" ? "credit_note" : "invoice",
      reference: i.reference ?? String(i.number ?? ""),
      party: i.customer.name,
    });
  for (const b of bills)
    labels.set(b.id, {
      type: "supplier_bill",
      reference: b.supplierReference ?? "",
      party: b.supplierName,
    });
  for (const c of credits)
    labels.set(c.id, {
      type: "supplier_credit",
      reference: c.supplierReference ?? "",
      party: c.bill.supplierName,
    });
  for (const e of expenses)
    labels.set(e.id, {
      type: "expense",
      reference: e.description,
      party: e.supplierName ?? "",
    });
  for (const a of adjustments)
    labels.set(a.id, {
      type: "gst_adjustment",
      reference: a.reason,
      party: "",
    });
  for (const t of timesheets)
    labels.set(t.id, {
      type: "timesheet",
      reference: t.workDate.toISOString().slice(0, 10),
      party: t.employee.name,
    });
  return labels;
}
