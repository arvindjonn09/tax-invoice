export type TaxCode =
  "TAXABLE_10" | "GST_FREE" | "INPUT_TAXED" | "OUT_OF_SCOPE";

export type QuoteLine = {
  id: string;
  description: string;
  quantity: string;
  unit: string | null;
  unitPriceCents: string;
  taxCode: TaxCode;
  gstRateBasisPoints: number;
  exclusiveCents: string;
  gstCents: string;
  inclusiveCents: string;
  estimatedCostCents: string;
};

/** As returned by /api/quotes/:id; money is integer-cent strings. */
export type Quote = {
  id: string;
  kind: "quote" | "variation";
  status: "draft" | "sent" | "accepted" | "declined" | "superseded";
  state: "draft" | "sent" | "accepted" | "declined" | "superseded" | "expired";
  number: number;
  revision: number;
  reference: string;
  revisesId: string | null;
  customerId: string;
  locationId: string | null;
  jobId: string | null;
  title: string;
  scope: string | null;
  priceEntry: "exclusive" | "inclusive";
  validUntil: string | null;
  notes: string | null;
  gstRegistered: boolean | null;
  exclusiveCents: string;
  gstCents: string;
  inclusiveCents: string;
  estimate: {
    revenueExclusiveCents: string;
    costCents: string;
    profitCents: string;
    marginBasisPoints: string | null;
  };
  sentOn: string | null;
  sentAt: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  createdAt: string;
  lines: QuoteLine[];
};

export const STATE_LABEL: Record<Quote["state"], string> = {
  draft: "Draft · not sent",
  sent: "Sent · awaiting decision",
  accepted: "Accepted",
  declined: "Declined",
  superseded: "Superseded by a revision",
  expired: "Expired · not accepted",
};

export const TAX_CODE_OPTIONS: { value: TaxCode; label: string }[] = [
  { value: "TAXABLE_10", label: "Taxable (GST 10%)" },
  { value: "GST_FREE", label: "GST-free" },
  { value: "INPUT_TAXED", label: "Input taxed" },
  { value: "OUT_OF_SCOPE", label: "Out of scope / no GST" },
];

export const taxLabel = (code: string) =>
  TAX_CODE_OPTIONS.find((option) => option.value === code)?.label ?? code;

/** Basis points → "42.0%". */
export const percent = (basisPoints: string | null) =>
  basisPoints === null ? "N/A" : `${(Number(basisPoints) / 100).toFixed(1)}%`;
