import {
  adjustedCashShare,
  compareSettlementDates,
  settlementHistoryProblem,
  gstStatusOn,
  type GstRegistrationPeriod,
  type ReportEvent,
} from "@jobflow/domain";
import type { Prisma } from "../../../../../packages/database/src/generated/prisma/client";
import { receiptHistory, supplierPaymentHistory } from "../payments/chronology";
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
  /**
   * Bounded reads (#157): only documents with any activity on or after
   * `since` (a date, settlement, credit, void, correction or GST posting)
   * are loaded, with their whole history. A document with nothing on or
   * after `since` can't produce an event dated then, so every report
   * starting at `since` is unchanged; tests prove it against a full load.
   */
  window?: { since: string },
) {
  const scope = window
    ? await relevantSources(tx, companyId, window.since)
    : null;
  const only = (ids: string[] | undefined) =>
    ids === undefined ? {} : { id: { in: ids } };
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
    postings,
    quotes,
    creditAdjustments,
    supplierCreditAdjustments,
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
      where: {
        companyId,
        status: { in: ["issued", "void"] },
        ...only(scope?.invoices),
      },
      include: { items: true, allocations: { include: { receipt: true } } },
    }),
    tx.supplierBill.findMany({
      where: { companyId, ...only(scope?.bills) },
      include: { allocations: { include: { payment: true } }, credits: true },
    }),
    tx.expense.findMany({
      where: { companyId, status: "approved", ...only(scope?.expenses) },
      include: {
        supplierPaymentAllocations: { include: { payment: true } },
        supplierPaymentGstAdjustments: true,
      },
    }),
    tx.timesheet.findMany({
      where: {
        companyId,
        status: "approved",
        ...(scope
          ? {
              OR: [
                { workDate: { gte: scope.sinceDay } },
                { decidedAt: { gte: scope.sinceInstant } },
              ],
            }
          : {}),
      },
    }),
    tx.receiptGstAdjustment.findMany({
      where: {
        companyId,
        ...(scope ? { invoiceId: { in: scope.invoices } } : {}),
      },
    }),
    tx.supplierPaymentGstAdjustment.findMany({
      where: { companyId, ...(scope ? { billId: { in: scope.bills } } : {}) },
    }),
    tx.gstManualAdjustment.findMany({
      where: {
        companyId,
        ...(scope ? { effectiveOn: { gte: scope.sinceDay } } : {}),
      },
    }),
    tx.contractorAcceptance.findMany({ where: { companyId } }),
    scope
      ? tx.$queryRaw<
          { source_id: string; original_on: Date; effective_on: Date }[]
        >`
      SELECT source_id,original_on,effective_on FROM gst_source_postings
      WHERE company_id=${companyId}::uuid AND source_id = ANY(${scope.postingSources}::uuid[])`
      : tx.$queryRaw<
          { source_id: string; original_on: Date; effective_on: Date }[]
        >`
      SELECT source_id,original_on,effective_on FROM gst_source_postings WHERE company_id=${companyId}::uuid`,
    tx.quote.findMany({
      where: { companyId, status: "accepted" },
      select: {
        id: true,
        jobId: true,
        decidedAt: true,
        exclusiveCents: true,
        estimatedCostCents: true,
      },
    }),
    tx.creditCashAdjustment.findMany({
      where: {
        companyId,
        ...(scope ? { invoiceId: { in: scope.invoices } } : {}),
      },
    }),
    tx.supplierCreditGstAdjustment.findMany({
      where: { companyId, ...(scope ? { billId: { in: scope.bills } } : {}) },
    }),
  ]);
  const periods: GstRegistrationPeriod[] = registrations.map((p) => ({
    startsOn: toDay(p.startsOn),
    endsOn: p.endsOn ? toDay(p.endsOn) : null,
    basis: p.basis,
  }));
  const customerByJob = new Map(jobs.map((j) => [j.id, j.customerId]));
  const events: ReportEvent[] = [];
  const warnings: {
    code: "INVALID_SETTLEMENT_HISTORY" | "INVALID_GST_REPLAY";
    sourceType: "invoice" | "supplier_bill";
    sourceId: string;
    jobId: string | null;
    customerId: string | null;
    omittedGst: boolean;
    message: string;
  }[] = [];
  const postingDates = new Map(
    postings.map((p) => [
      `${p.source_id}:${toDay(p.original_on)}`,
      toDay(p.effective_on),
    ]),
  );
  const taxDay = (source: string, day: string) =>
    postingDates.get(`${source}:${day}`) ?? day;
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
      date:
        channel === "gst_sales" || channel === "gst_purchases"
          ? taxDay(sourceId, date)
          : date,
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
    const historyProblem = settlementHistoryProblem(
      row.inclusiveCents,
      receiptHistory(row.allocations),
    );
    if (historyProblem)
      warnings.push({
        code: "INVALID_SETTLEMENT_HISTORY",
        sourceType: "invoice",
        sourceId: row.id,
        jobId: row.jobId,
        customerId: row.customerId,
        omittedGst: basis === "cash",
        message:
          "This invoice has an invalid date-ordered settlement history. Review its records; cash GST for this source is excluded when using the cash basis.",
      });
    if (basis === "non_cash") {
      const date = earliest(
        taxDay(row.id, day),
        row.allocations
          .filter((a) => a.receipt.kind === "receipt" && !a.receipt.voidedAt)
          .map((a) => taxDay(a.receiptId, toDay(a.receipt.receivedOn))),
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
    if (basis === "cash" && row.inclusiveCents > 0n && !historyProblem) {
      const gstStart = events.length;
      try {
        // G1 needs its own cumulative allocation for mixed out-of-scope lines.
        // Process record/void events in their economic-date order; ids break ties.
        const cash = row.allocations
          .flatMap((a) => [
            {
              id: `${a.id}:gst`,
              orderId: `${a.receiptId}:record`,
              source: a.receiptId,
              date: toDay(a.receipt.receivedOn),
              amount: a.amountCents * (a.receipt.kind === "refund" ? -1n : 1n),
              gst: a.gstAttributedCents,
              recorded: a.receipt.createdAt.toISOString(),
            },
            ...(a.receipt.voidedAt
              ? [
                  {
                    id: `${a.id}:gst-void`,
                    orderId: `${a.receiptId}:void`,
                    source: a.receiptId,
                    date: businessDay(a.receipt.voidedAt),
                    amount:
                      a.amountCents * (a.receipt.kind === "refund" ? 1n : -1n),
                    gst: -a.gstAttributedCents,
                    recorded: a.receipt.voidedAt.toISOString(),
                  },
                ]
              : []),
          ])
          .map((c) => ({
            ...c,
            date: taxDay(c.source, c.date),
            creditAmount: 0n,
            creditG1: 0n,
          }))
          .concat(
            invoices
              .filter(
                (credit) => credit.creditsId === row.id && credit.issueDate,
              )
              .flatMap((credit) => {
                const eligible = credit.items
                  .filter((item) => item.taxCode !== "OUT_OF_SCOPE")
                  .reduce((sum, item) => sum + item.inclusiveCents, 0n);
                const make = (
                  suffix: string,
                  date: string,
                  recorded: string,
                  sign: bigint,
                ) => ({
                  id: `${credit.id}:cash-credit-${suffix}`,
                  orderId: `${credit.id}:credit-${suffix}`,
                  source: credit.id,
                  date: taxDay(credit.id, date),
                  recorded,
                  amount: 0n,
                  gst: 0n,
                  creditAmount: sign * credit.inclusiveCents,
                  creditG1: sign * eligible,
                });
                return [
                  make(
                    "issue",
                    toDay(credit.issueDate!),
                    credit.issuedAt!.toISOString(),
                    1n,
                  ),
                  ...(credit.voidedAt
                    ? [
                        make(
                          "void",
                          businessDay(credit.voidedAt),
                          credit.voidedAt.toISOString(),
                          -1n,
                        ),
                      ]
                    : []),
                ];
              }),
          )
          .sort((a, b) =>
            compareSettlementDates(
              { id: a.orderId, date: a.date, recordedAt: a.recorded },
              { id: b.orderId, date: b.date, recordedAt: b.recorded },
            ),
          );
        let received = 0n,
          credited = 0n,
          creditedEligible = 0n;
        const target = () =>
          adjustedCashShare({
            total: row.inclusiveCents,
            eligible: g1,
            credited,
            creditedEligible,
            received,
          });
        for (const c of cash) {
          const before = target();
          received += c.amount;
          credited += c.creditAmount;
          creditedEligible += c.creditG1;
          const share = target() - before;
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
        for (const a of creditAdjustments.filter((a) => a.invoiceId === row.id))
          if (registered(toDay(a.adjustedOn)))
            emit(
              a.id,
              a.creditId,
              toDay(a.adjustedOn),
              row.jobId,
              row.customerId,
              "gst_sales",
              a.gstCents,
              0n,
            );
        for (const a of receiptAdjustments.filter(
          (a) => a.invoiceId === row.id,
        ))
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
      } catch (error) {
        if (!(error instanceof RangeError)) throw error;
        events.length = gstStart;
        warnings.push({
          code: "INVALID_GST_REPLAY",
          sourceType: "invoice",
          sourceId: row.id,
          jobId: row.jobId,
          customerId: row.customerId,
          omittedGst: true,
          message:
            "Cash GST could not be reconstructed for this invoice. Its GST is excluded from these incomplete totals; review the source records.",
        });
      }
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
    const historyProblem = settlementHistoryProblem(
      row.inclusiveCents,
      supplierPaymentHistory(row.allocations),
    );
    if (historyProblem)
      warnings.push({
        code: "INVALID_SETTLEMENT_HISTORY",
        sourceType: "supplier_bill",
        sourceId: row.id,
        jobId: row.jobId,
        customerId,
        omittedGst: status.basis === "cash",
        message:
          "This bill has an invalid date-ordered payment history. Review its records; cash GST for this source is excluded when using the cash basis.",
      });
    if (status.basis === "non_cash") {
      const date = earliest(
        taxDay(row.id, day),
        row.allocations
          .filter((a) => !a.payment.voidedAt)
          .map((a) => taxDay(a.paymentId, toDay(a.payment.paidOn))),
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
      if (status.basis === "cash" && !historyProblem && registered(day))
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
        if (status.basis === "cash" && !historyProblem && registered(voidDay))
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
    // Supplier credits (#140): lower the job cost on the date the note was
    // received; the purchaser's creditable GST comes back (an increasing
    // adjustment) on that date on the non-cash basis, or through the
    // recorded cash corrections on the cash basis. A void reverses on its day.
    for (const credit of row.credits) {
      const creditDay = toDay(credit.receivedOn);
      const voidDay = credit.voidedAt ? businessDay(credit.voidedAt) : null;
      emit(
        `${credit.id}:credit-cost`,
        credit.id,
        creditDay,
        row.jobId,
        customerId,
        "incurred",
        -credit.jobCostCents,
      );
      if (voidDay)
        emit(
          `${credit.id}:credit-cost-void`,
          credit.id,
          voidDay,
          row.jobId,
          customerId,
          "incurred",
          credit.jobCostCents,
        );
      if (status.basis !== "non_cash") continue;
      if (registered(taxDay(credit.id, creditDay)))
        emit(
          `${credit.id}:credit-gst`,
          credit.id,
          creditDay,
          row.jobId,
          customerId,
          "gst_purchases",
          -credit.creditableGstCents,
        );
      if (voidDay && registered(taxDay(credit.id, voidDay)))
        emit(
          `${credit.id}:credit-gst-void`,
          credit.id,
          voidDay,
          row.jobId,
          customerId,
          "gst_purchases",
          credit.creditableGstCents,
        );
    }
    if (status.basis === "cash" && !historyProblem)
      for (const a of supplierCreditAdjustments.filter(
        (a) => a.billId === row.id,
      ))
        if (registered(taxDay(a.creditId, toDay(a.adjustedOn))))
          emit(
            a.id,
            a.creditId,
            toDay(a.adjustedOn),
            row.jobId,
            customerId,
            "gst_purchases",
            a.creditableGstCents,
          );
    if (status.basis === "cash" && !historyProblem)
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
  /** Follow reverses/corrects links to the original purchase (cycle-safe). */
  const rootExpense = (row: (typeof expenses)[number]) => {
    let current = row;
    for (let hops = 0; hops < 10; hops += 1) {
      const parentId = current.reversesId ?? current.correctsId;
      const parent = parentId ? expenseById.get(parentId) : undefined;
      if (!parent) break;
      current = parent;
    }
    return current;
  };
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
    // The chain's root purchase (#169): a reversal of a correction must
    // follow the correction back to the paid original, or on the cash
    // basis the correction's claim is never reversed.
    const root = rootExpense(row);
    const taxDate =
      status.basis === "cash"
        ? row.paidOn
          ? toDay(row.paidOn)
          : root !== row && root.paidOn
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
    // On-account expenses paid later with a supplier payment (#141): the
    // cash and, on the cash basis, the attributed input tax credit move on
    // the payment date; a payment void and its correction on their own days.
    for (const a of row.supplierPaymentAllocations) {
      const payDay = toDay(a.payment.paidOn);
      emit(
        `${a.id}:pay`,
        a.paymentId,
        payDay,
        row.jobId,
        customerId,
        "paid",
        a.amountCents,
      );
      if (status.basis === "cash" && registered(payDay))
        emit(
          `${a.id}:cash-credit`,
          a.paymentId,
          payDay,
          row.jobId,
          customerId,
          "gst_purchases",
          a.creditableGstAttributedCents,
        );
      if (!a.payment.voidedAt) continue;
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
    if (status.basis === "cash")
      for (const a of row.supplierPaymentGstAdjustments)
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
  return {
    events,
    jobs,
    periods,
    bills,
    acceptances,
    quotes,
    warnings,
    /** What was read: proves bounded loading in tests and logs. */
    loaded: {
      invoices: invoices.length,
      bills: bills.length,
      expenses: expenses.length,
      timesheets: timesheets.length,
    },
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The ids of every document with any activity on or after `since`
 * (#157), closed under the links the replay needs: an invoice's credit
 * notes and the invoice a credit note credits; an expense's whole
 * reversal/correction chain. Timestamps (voids, decisions) are compared a
 * day early, so a Sydney business date is never missed across UTC.
 */
async function relevantSources(
  tx: Prisma.TransactionClient,
  companyId: string,
  since: string,
) {
  const sinceDay = new Date(`${since}T00:00:00Z`);
  const sinceInstant = new Date(sinceDay.getTime() - DAY_MS);
  const posted = (
    await tx.$queryRaw<{ source_id: string }[]>`
      SELECT DISTINCT source_id FROM gst_source_postings
      WHERE company_id=${companyId}::uuid AND effective_on >= ${sinceDay}::date`
  ).map((row) => row.source_id);
  const late = { gte: sinceInstant };
  const recent = { gte: sinceDay };
  const [invoiceRows, billRows, expenseRows] = await Promise.all([
    tx.invoice.findMany({
      where: {
        companyId,
        status: { in: ["issued", "void"] },
        OR: [
          { issueDate: recent },
          { voidedAt: late },
          { id: { in: posted } },
          {
            allocations: {
              some: {
                OR: [
                  { receipt: { receivedOn: recent } },
                  { receipt: { voidedAt: late } },
                  { receiptId: { in: posted } },
                ],
              },
            },
          },
          { gstAdjustments: { some: { adjustedOn: recent } } },
          { cashAdjustments: { some: { adjustedOn: recent } } },
          {
            creditNotes: {
              some: {
                OR: [
                  { issueDate: recent },
                  { voidedAt: late },
                  { id: { in: posted } },
                ],
              },
            },
          },
        ],
      },
      select: { id: true, creditsId: true },
    }),
    tx.supplierBill.findMany({
      where: {
        companyId,
        OR: [
          { issuedOn: recent },
          { voidedAt: late },
          { id: { in: posted } },
          {
            allocations: {
              some: {
                OR: [
                  { payment: { paidOn: recent } },
                  { payment: { voidedAt: late } },
                  { paymentId: { in: posted } },
                ],
              },
            },
          },
          {
            credits: {
              some: {
                OR: [
                  { receivedOn: recent },
                  { issuedOn: recent },
                  { voidedAt: late },
                  { id: { in: posted } },
                ],
              },
            },
          },
          { gstAdjustments: { some: { adjustedOn: recent } } },
          { creditGstAdjustments: { some: { adjustedOn: recent } } },
        ],
      },
      select: {
        id: true,
        allocations: { select: { paymentId: true } },
        credits: { select: { id: true } },
      },
    }),
    tx.expense.findMany({
      where: {
        companyId,
        status: "approved",
        OR: [
          { purchasedOn: recent },
          { paidOn: recent },
          { decidedAt: late },
          { id: { in: posted } },
          {
            supplierPaymentAllocations: {
              some: {
                OR: [
                  { payment: { paidOn: recent } },
                  { payment: { voidedAt: late } },
                  { paymentId: { in: posted } },
                ],
              },
            },
          },
          { supplierPaymentGstAdjustments: { some: { adjustedOn: recent } } },
        ],
      },
      select: { id: true, reversesId: true, correctsId: true },
    }),
  ]);
  // Invoices: add the credited invoice of each credit note and every credit
  // note of each invoice (the cash replay reads both).
  const invoices = new Set(invoiceRows.map((row) => row.id));
  for (const row of invoiceRows) if (row.creditsId) invoices.add(row.creditsId);
  for (const credit of await tx.invoice.findMany({
    where: {
      companyId,
      status: { in: ["issued", "void"] },
      creditsId: { in: [...invoices] },
    },
    select: { id: true },
  }))
    invoices.add(credit.id);
  // Expenses: the whole chain, both directions (reversals and corrections
  // read their original; an original's reversal changes its cash date).
  const expenses = new Set(expenseRows.map((row) => row.id));
  let frontier = expenseRows.flatMap((row) =>
    [row.reversesId, row.correctsId].filter((id): id is string => !!id),
  );
  for (let hops = 0; hops < 10 && frontier.length; hops += 1) {
    const next = await tx.expense.findMany({
      where: {
        companyId,
        status: "approved",
        OR: [
          { id: { in: frontier } },
          { reversesId: { in: [...expenses, ...frontier] } },
          { correctsId: { in: [...expenses, ...frontier] } },
        ],
      },
      select: { id: true, reversesId: true, correctsId: true },
    });
    frontier = [];
    for (const row of next)
      if (!expenses.has(row.id)) {
        expenses.add(row.id);
        for (const id of [row.reversesId, row.correctsId])
          if (id && !expenses.has(id)) frontier.push(id);
      }
  }
  const invoiceIds = [...invoices];
  // Every settlement and credit of a loaded document, for exact replay order.
  const settlements = await tx.receiptAllocation.findMany({
    where: { companyId, invoiceId: { in: invoiceIds } },
    select: { receiptId: true },
  });
  const expenseIds = [...expenses];
  const expensePayments = await tx.supplierPaymentExpenseAllocation.findMany({
    where: { companyId, expenseId: { in: expenseIds } },
    select: { paymentId: true },
  });
  const postingSources = [
    ...new Set([
      ...invoiceIds,
      ...settlements.map((row) => row.receiptId),
      ...billRows.flatMap((row) => [
        row.id,
        ...row.allocations.map((a) => a.paymentId),
        ...row.credits.map((c) => c.id),
      ]),
      ...expenseIds,
      ...expensePayments.map((row) => row.paymentId),
      ...posted,
    ]),
  ];
  return {
    sinceDay,
    sinceInstant,
    invoices: invoiceIds,
    bills: billRows.map((row) => row.id),
    expenses: expenseIds,
    postingSources,
  };
}
