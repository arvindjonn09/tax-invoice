/** As returned by /api/bills; money is integer-cent strings. */
export type Bill = {
  id: string;
  jobId: string | null;
  contractorId: string | null;
  supplierName: string;
  supplierAbn: string | null;
  supplierGstRegistered: boolean;
  supplierReference: string | null;
  issuedOn: string;
  dueOn: string | null;
  documentId: string | null;
  evidenceVerified: boolean;
  hasEvidence: boolean;
  companyGstRegistered: boolean;
  creditablePercent: string;
  creditableReason: string | null;
  exclusiveCents: string;
  gstCents: string;
  inclusiveCents: string;
  creditableGstCents: string;
  nonCreditableGstCents: string;
  jobCostCents: string;
  paidCents: string;
  outstandingCents: string;
  status: "open" | "paid" | "void";
  note: string | null;
  voidReason: string | null;
  voidedAt: string | null;
  lines: {
    position: number;
    description: string;
    taxCode: string;
    exclusiveCents: string;
    gstCents: string;
    inclusiveCents: string;
  }[];
  payments: {
    paymentId: string;
    paidOn: string;
    amountCents: string;
    void: boolean;
  }[];
};

export type SupplierPayment = {
  id: string;
  contractorId: string | null;
  payeeName: string;
  paidOn: string;
  amountCents: string;
  method: Method;
  reference: string | null;
  voidReason: string | null;
  voidedAt: string | null;
  allocations: {
    billId: string;
    amountCents: string;
    creditableGstAttributedCents: string;
  }[];
};

export type Receipt = {
  id: string;
  customerId: string;
  kind: "receipt" | "refund";
  receivedOn: string;
  amountCents: string;
  method: Method;
  reference: string | null;
  voidReason: string | null;
  voidedAt: string | null;
  allocations: {
    invoiceId: string;
    amountCents: string;
    gstAttributedCents: string;
  }[];
};

/** An issued invoice with its balance (from /api/invoices?status=issued). */
export type OpenInvoice = {
  id: string;
  reference: string | null;
  issueDate: string | null;
  inclusiveCents: string;
  receivedCents?: string;
  outstandingCents?: string;
};

export type Method = "bank_transfer" | "card" | "cash" | "cheque" | "other";

export const METHODS: { value: Method; label: string }[] = [
  { value: "bank_transfer", label: "Bank transfer" },
  { value: "card", label: "Card" },
  { value: "cash", label: "Cash" },
  { value: "cheque", label: "Cheque" },
  { value: "other", label: "Other" },
];

export const methodLabel = (method: string) =>
  METHODS.find((option) => option.value === method)?.label ?? method;

export const BILL_STATUS: Record<Bill["status"], string> = {
  open: "Owing",
  paid: "Paid",
  void: "Void",
};

export const TAX_CODES = [
  { value: "TAXABLE_10", label: "Taxable (GST 10%)" },
  { value: "GST_FREE", label: "GST-free" },
  { value: "INPUT_TAXED", label: "Input taxed" },
  { value: "OUT_OF_SCOPE", label: "Out of scope / no GST" },
] as const;

export const taxLabel = (code: string) =>
  TAX_CODES.find((option) => option.value === code)?.label ?? code;

/** A fresh opaque key for one payment or receipt attempt (kept across retries). */
export const idempotencyKey = () => `ui-${crypto.randomUUID()}`;
