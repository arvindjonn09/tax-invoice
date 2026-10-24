export type TaxCode =
  "TAXABLE_10" | "GST_FREE" | "INPUT_TAXED" | "OUT_OF_SCOPE";

export type InvoiceLine = {
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
};

type Party = {
  name?: string | null;
  legalName?: string | null;
  label?: string | null;
  abn?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  suburb?: string | null;
  state?: string | null;
  postcode?: string | null;
} | null;

/** As returned by /api/invoices/:id; all money is integer-cent strings. */
export type Invoice = {
  id: string;
  kind: "invoice" | "credit_note";
  status: "draft" | "issued" | "void";
  customerId: string;
  jobId: string | null;
  locationId: string | null;
  creditsId: string | null;
  priceEntry: "exclusive" | "inclusive";
  customerReference: string | null;
  notes: string | null;
  dueOn: string | null;
  number: number | null;
  reference: string | null;
  issueDate: string | null;
  title: string | null;
  gstRegistered: boolean | null;
  supplier: Party;
  customer: Party;
  site: Party;
  exclusiveCents: string;
  gstCents: string;
  inclusiveCents: string;
  issuedAt: string | null;
  voidReason: string | null;
  voidedAt: string | null;
  lines: InvoiceLine[];
  creditNotes?: {
    id: string;
    status: string;
    reference: string | null;
    inclusiveCents: string;
  }[];
};

export const TAX_CODE_OPTIONS: {
  value: TaxCode;
  label: string;
  help: string;
}[] = [
  {
    value: "TAXABLE_10",
    label: "Taxable (GST 10%)",
    help: "A taxable supply: 10% GST is charged.",
  },
  {
    value: "GST_FREE",
    label: "GST-free",
    help: "No GST is charged, but it's still a supply you report.",
  },
  {
    value: "INPUT_TAXED",
    label: "Input taxed",
    help: "No GST is charged and related purchases carry no GST credit.",
  },
  {
    value: "OUT_OF_SCOPE",
    label: "Out of scope / no GST",
    help: "Not a taxable supply for GST, e.g. when not registered.",
  },
];

export const taxLabel = (code: string) =>
  TAX_CODE_OPTIONS.find((option) => option.value === code)?.label ?? code;

export const documentName = (invoice: Pick<Invoice, "kind">) =>
  invoice.kind === "credit_note" ? "credit note" : "invoice";
