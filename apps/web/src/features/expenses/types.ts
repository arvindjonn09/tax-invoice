import type { TaxCode } from "@jobflow/domain";
export type PaymentMethod = "card" | "cash" | "bank_transfer" | "other";
/** What the submitter entered (GET /api/my/expenses): no cost or credit split. */
export type OwnExpense = {
  id: string;
  jobId: string | null;
  category: string;
  description: string;
  supplierName: string | null;
  purchasedOn: string;
  priceEntry: "exclusive" | "inclusive";
  amountCents: string;
  taxCode: TaxCode;
  exclusiveCents: string;
  gstCents: string;
  inclusiveCents: string;
  creditablePercent: string;
  receiptDocumentId: string | null;
  settlement: "paid_at_purchase" | "on_account";
  paidOn: string | null;
  paymentMethod: PaymentMethod | null;
  status: "submitted" | "approved" | "rejected";
  decisionNote: string | null;
  decidedAt: string | null;
  reversesId: string | null;
  createdAt: string;
};
/** Office view (GET /api/expenses): adds people and the approval snapshot. */
export type OfficeExpense = OwnExpense & {
  submittedBy: string;
  decidedBy: string | null;
  reversedById: string | null;
  correctsId: string | null;
  correctedById: string | null;
  approval: {
    companyGstRegistered: boolean;
    evidenceVerified: boolean;
    hasEvidence: boolean;
    creditableGstCents: string;
    nonCreditableGstCents: string;
    jobCostCents: string;
  } | null;
};
export type JobOption = { id: string; reference: string; title: string };
export const CATEGORY_LABELS: Record<string, string> = {
  materials: "Materials",
  travel: "Travel",
  parking: "Parking",
  equipment: "Equipment",
  misc: "Miscellaneous",
};
/** Design-system TaxCodeSelect labels, mapped to domain codes. */
export const TAX_CODE_LABELS: Record<TaxCode, string> = {
  TAXABLE_10: "Taxable — 10%",
  GST_FREE: "GST-free — 0%",
  INPUT_TAXED: "Input taxed — 0%",
  OUT_OF_SCOPE: "Out of scope — 0%",
};
export const PAYMENT_LABELS: Record<PaymentMethod, string> = {
  card: "Card",
  cash: "Cash",
  bank_transfer: "Bank transfer",
  other: "Other",
};
export const STATUS_LABELS: Record<OwnExpense["status"], string> = {
  submitted: "Awaiting approval",
  approved: "Approved",
  rejected: "Rejected",
};
