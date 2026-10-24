import {
  divideRounded,
  gstStatusOn,
  type GstRegistrationPeriod,
  type ReportEvent,
} from "@jobflow/domain";
import type { Prisma } from "../../../../../packages/database/src/generated/prisma/client";
import { toDay } from "../company/gst";

/** Sydney calendar date for immutable UTC audit/decision timestamps. */
export const businessDay = (date: Date) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Sydney" }).format(
    date,
  );
const earliest = (day: string, dates: readonly string[]) =>
  dates.reduce((a, b) => (a < b ? a : b), day);
const signed = (value: bigint, sign: bigint) => value * sign;

/**
 * Project immutable documents and settlement histories into dated facts.
 * Must run inside a repeatable-read transaction so all totals share a snapshot.
 * A void reverses on its business date; earlier reports are never rewritten by
 * filtering out currently void records. GST void adjustments are separate facts.
 */
export async function financialEvents(
  tx: Prisma.TransactionClient,
  companyId: string,
) {
  const [
    jobs,
    registrations,
    invoices,
    bills,
    expenses,
    timesheets,
    receiptAdjustments,
    paymentAdjustments,
    manualAdjustments,
    acceptances,
  ] = await Promise.all([
    tx.job.findMany({
      where: { companyId },
      select: {
        id: true,
        customerId: true,
        reference: true,
        title: true,
        agreedPriceExclusiveCents: true,
        status: true,
      },
    }),
    tx.companyGstRegistration.findMany({ where: { companyId } }),
    tx.invoice.findMany({
      where: { companyId, status: { in: ["issued", "void"] } },
      include: { items: true, allocations: { include: { receipt: true } } },
    }),
    tx.supplierBill.findMany({
      where: { companyId },
      include: { allocations: { include: { payment: true } } },
    }),
    tx.expense.findMany({ where: { companyId, status: "approved" } }),
    tx.timesheet.findMany({ where: { companyId, status: "approved" } }),
    tx.receiptGstAdjustment.findMany({ where: { companyId } }),
    tx.supplierPaymentGstAdjustment.findMany({ where: { companyId } }),
    tx.gstManualAdjustment.findMany({ where: { companyId } }),
    tx.contractorAcceptance.findMany({ where: { companyId } }),
  ]);
  const periods: GstRegistrationPeriod[] = registrations.map((p) => ({
    startsOn: toDay(p.startsOn),
    endsOn: p.endsOn ? toDay(p.endsOn) : null,
    basis: p.basis,
  }));
  const customerByJob = new Map(jobs.map((j) => [j.id, j.customerId]));
  const events: ReportEvent[] = [];
  const emit = (
    id: string,
    sourceId: string,
    date: string,
    jobId: string | null,
    customerId: string | null,
    channel: ReportEvent["channel"],
    amount: bigint,
    salesInclusive?: bigint,
  ) => {
    events.push({
      id,
      sourceId,
      date,
      jobId,
      customerId,
      channel,
      amount,
      ...(salesInclusive === undefined ? {} : { salesInclusive }),
    });
  };
  const registered = (date: string) => gstStatusOn(periods, date).registered;
  for (const row of invoices) {
    if (!row.issueDate) continue;
    const day = toDay(row.issueDate),
      sign = row.kind === "credit_note" ? -1n : 1n;
    const emitInvoice = (suffix: string, date: string, multiplier: bigint) =>
      emit(
        `${row.id}:${suffix}`,
        row.id,
        date,
        row.jobId,
        row.customerId,
        "invoiced",
        signed(row.exclusiveCents, multiplier),
      );
    emitInvoice("issue", day, sign);
    if (row.voidedAt) emitInvoice("void", businessDay(row.voidedAt), -sign);
    const status = gstStatusOn(periods, day);
    const g1 = row.items
      .filter((i) => i.taxCode !== "OUT_OF_SCOPE")
      .reduce((s, i) => s + i.inclusiveCents, 0n);
    const basis = status.basis;
    if (basis === "non_cash") {
      const date = earliest(
        day,
        row.allocations
          .filter((a) => a.receipt.kind === "receipt")
          .map((a) => toDay(a.receipt.receivedOn)),
      );
      if (registered(date))
        emit(
          `${row.id}:gst-issue`,
          row.id,
          date,
          row.jobId,
          row.customerId,
          "gst_sales",
          signed(row.gstCents, sign),
          signed(g1, sign),
        );
      if (row.voidedAt && registered(businessDay(row.voidedAt)))
        emit(
          `${row.id}:gst-void`,
          row.id,
          businessDay(row.voidedAt),
          row.jobId,
          row.customerId,
          "gst_sales",
          signed(row.gstCents, -sign),
          signed(g1, -sign),
        );
    }
    for (const a of row.allocations) {
      const paymentSign = a.receipt.kind === "refund" ? -1n : 1n;
      const date = toDay(a.receipt.receivedOn);
      emit(
        `${a.id}:receive`,
        a.receiptId,
        date,
        row.jobId,
        row.customerId,
        "received",
        signed(a.amountCents, paymentSign),
      );
      if (a.receipt.voidedAt)
        emit(
          `${a.id}:receive-void`,
          a.receiptId,
          businessDay(a.receipt.voidedAt),
          row.jobId,
          row.customerId,
          "received",
          signed(a.amountCents, -paymentSign),
        );
    }
    if (basis === "cash" && row.inclusiveCents > 0n) {
      // G1 needs its own cumulative allocation for mixed out-of-scope lines.
      // Process record/void events in their economic-date order; ids break ties.
      const cash = row.allocations
        .flatMap((a) => [
          {
            id: `${a.id}:gst`,
            source: a.receiptId,
            date: toDay(a.receipt.receivedOn),
            amount: a.amountCents * (a.receipt.kind === "refund" ? -1n : 1n),
            gst: a.gstAttributedCents,
          },
          ...(a.receipt.voidedAt
            ? [
                {
                  id: `${a.id}:gst-void`,
                  source: a.receiptId,
                  date: businessDay(a.receipt.voidedAt),
                  amount:
                    a.amountCents * (a.receipt.kind === "refund" ? 1n : -1n),
                  gst: -a.gstAttributedCents,
                },
              ]
            : []),
        ])
        .sort(
          (a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id),
        );
      let received = 0n;
      for (const c of cash) {
        const before = divideRounded(received * g1, row.inclusiveCents);
        received += c.amount;
        const share = divideRounded(received * g1, row.inclusiveCents) - before;
        if (registered(c.date))
          emit(
            c.id,
            c.source,
            c.date,
            row.jobId,
            row.customerId,
            "gst_sales",
            c.gst,
            share,
          );
      }
      for (const a of receiptAdjustments.filter((a) => a.invoiceId === row.id))
        if (registered(toDay(a.adjustedOn)))
          emit(
            a.id,
            a.receiptId,
            toDay(a.adjustedOn),
            row.jobId,
            row.customerId,
            "gst_sales",
            a.gstCents,
            0n,
          );
    }
  }
  for (const row of bills) {
    const day = toDay(row.issuedOn),
      customerId = row.jobId ? (customerByJob.get(row.jobId) ?? null) : null;
    emit(
      `${row.id}:incur`,
      row.id,
      day,
      row.jobId,
      customerId,
      "incurred",
      row.jobCostCents,
    );
    if (row.voidedAt)
      emit(
        `${row.id}:void`,
        row.id,
        businessDay(row.voidedAt),
        row.jobId,
        customerId,
        "incurred",
        -row.jobCostCents,
      );
    const status = gstStatusOn(periods, day);
    if (status.basis === "non_cash") {
      const date = earliest(
        day,
        row.allocations.map((a) => toDay(a.payment.paidOn)),
      );
      if (registered(date))
        emit(
          `${row.id}:credit`,
          row.id,
          date,
          row.jobId,
          customerId,
          "gst_purchases",
          row.creditableGstCents,
        );
      if (row.voidedAt && registered(businessDay(row.voidedAt)))
        emit(
          `${row.id}:credit-void`,
          row.id,
          businessDay(row.voidedAt),
          row.jobId,
          customerId,
          "gst_purchases",
          -row.creditableGstCents,
        );
    }
    for (const a of row.allocations) {
      const day = toDay(a.payment.paidOn);
      emit(
        `${a.id}:pay`,
        a.paymentId,
        day,
        row.jobId,
        customerId,
        "paid",
        a.amountCents,
      );
      if (status.basis === "cash" && registered(day))
        emit(
          `${a.id}:cash-credit`,
          a.paymentId,
          day,
          row.jobId,
          customerId,
          "gst_purchases",
          a.creditableGstAttributedCents,
        );
      if (a.payment.voidedAt) {
        const voidDay = businessDay(a.payment.voidedAt);
        emit(
          `${a.id}:pay-void`,
          a.paymentId,
          voidDay,
          row.jobId,
          customerId,
          "paid",
          -a.amountCents,
        );
        if (status.basis === "cash" && registered(voidDay))
          emit(
            `${a.id}:cash-credit-void`,
            a.paymentId,
            voidDay,
            row.jobId,
            customerId,
            "gst_purchases",
            -a.creditableGstAttributedCents,
          );
      }
    }
    if (status.basis === "cash")
      for (const a of paymentAdjustments.filter((a) => a.billId === row.id))
        if (registered(toDay(a.adjustedOn)))
          emit(
            a.id,
            a.paymentId,
            toDay(a.adjustedOn),
            row.jobId,
            customerId,
            "gst_purchases",
            a.creditableGstCents,
          );
  }
  const expenseById = new Map(expenses.map((row) => [row.id, row]));
  for (const row of expenses) {
    const day =
      (row.reversesId || row.correctsId) && row.decidedAt
        ? businessDay(row.decidedAt)
        : toDay(row.purchasedOn);
    const customerId = row.jobId
      ? (customerByJob.get(row.jobId) ?? null)
      : null;
    emit(
      `${row.id}:cost`,
      row.id,
      day,
      row.jobId,
      customerId,
      "incurred",
      row.jobCostCents ?? 0n,
    );
    const status = gstStatusOn(periods, toDay(row.purchasedOn));
    const original = row.reversesId
      ? expenseById.get(row.reversesId)
      : row.correctsId
        ? expenseById.get(row.correctsId)
        : undefined;
    const taxDate =
      status.basis === "cash"
        ? row.paidOn
          ? toDay(row.paidOn)
          : original?.paidOn
            ? day
            : null
        : day;
    if (status.registered && taxDate && registered(taxDate))
      emit(
        `${row.id}:gst`,
        row.id,
        taxDate,
        row.jobId,
        customerId,
        "gst_purchases",
        row.creditableGstCents ?? 0n,
      );
    if (row.settlement === "paid_at_purchase" && row.paidOn)
      emit(
        `${row.id}:paid`,
        row.id,
        toDay(row.paidOn),
        row.jobId,
        customerId,
        "paid",
        row.inclusiveCents,
      );
  }
  for (const row of timesheets) {
    const date =
      row.reversesId && row.decidedAt
        ? businessDay(row.decidedAt)
        : toDay(row.workDate);
    emit(
      `${row.id}:labour`,
      row.id,
      date,
      row.jobId,
      customerByJob.get(row.jobId) ?? null,
      "incurred",
      row.costCents ?? 0n,
    );
  }
  for (const a of manualAdjustments) {
    const date = toDay(a.effectiveOn);
    emit(`${a.id}:sales`, a.id, date, null, null, "gst_sales", a.oneA, a.g1);
    emit(`${a.id}:purchase`, a.id, date, null, null, "gst_purchases", a.oneB);
  }
  events.sort(
    (a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id),
  );
  return { events, jobs, periods, bills, acceptances };
}
