import {
  settlementHistoryProblem,
  type DatedSettlement,
} from "@jobflow/domain";
import type { Prisma } from "../../../../../packages/database/src/generated/prisma/client";
import { sydneyToday, toDay } from "../company/gst";

type ReceiptAllocation = {
  amountCents: bigint;
  receipt: {
    id: string;
    kind: "receipt" | "refund";
    receivedOn: Date;
    createdAt: Date;
    voidedAt: Date | null;
  };
};
type PaymentAllocation = {
  amountCents: bigint;
  payment: { id: string; paidOn: Date; createdAt: Date; voidedAt: Date | null };
};
export function receiptHistory(
  rows: readonly ReceiptAllocation[],
): DatedSettlement[] {
  return rows.flatMap(({ amountCents, receipt: r }) => {
    const amount = r.kind === "refund" ? -amountCents : amountCents;
    return [
      {
        id: `${r.id}:record`,
        date: toDay(r.receivedOn),
        recordedAt: r.createdAt.toISOString(),
        amount,
      },
      ...(r.voidedAt
        ? [
            {
              id: `${r.id}:void`,
              date: sydneyToday(r.voidedAt),
              recordedAt: r.voidedAt.toISOString(),
              amount: -amount,
            },
          ]
        : []),
    ];
  });
}
export function supplierPaymentHistory(
  rows: readonly PaymentAllocation[],
): DatedSettlement[] {
  return rows.flatMap(({ amountCents, payment: p }) => [
    {
      id: `${p.id}:record`,
      date: toDay(p.paidOn),
      recordedAt: p.createdAt.toISOString(),
      amount: amountCents,
    },
    ...(p.voidedAt
      ? [
          {
            id: `${p.id}:void`,
            date: sydneyToday(p.voidedAt),
            recordedAt: p.voidedAt.toISOString(),
            amount: -amountCents,
          },
        ]
      : []),
  ]);
}
/** Call only while holding the invoice/bill locks used for money allocation. */
export async function receiptDateProblem(
  tx: Prisma.TransactionClient,
  companyId: string,
  invoiceId: string,
  total: bigint,
  candidate: DatedSettlement,
) {
  const rows = await tx.receiptAllocation.findMany({
    where: { companyId, invoiceId },
    include: { receipt: true },
  });
  return settlementHistoryProblem(total, [...receiptHistory(rows), candidate]);
}
export async function supplierPaymentDateProblem(
  tx: Prisma.TransactionClient,
  companyId: string,
  billId: string,
  total: bigint,
  candidate: DatedSettlement,
) {
  const rows = await tx.supplierPaymentAllocation.findMany({
    where: { companyId, billId },
    include: { payment: true },
  });
  return settlementHistoryProblem(total, [
    ...supplierPaymentHistory(rows),
    candidate,
  ]);
}
export const chronologyMessage =
  "This settlement date would create a negative running balance or an overpayment in the document history. Choose a valid date or correct the earlier records.";
