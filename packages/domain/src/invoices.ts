import {
  type GstLine,
  type PriceEntry,
  type TaxCode,
  calculateSupplyLine,
} from "./gst";
import { type Cents, sum } from "./money";

// Customer invoices and credit notes (#47, docs/GST.md#invoice-compliance).
// Pure rules shared by the API, PDF (#48) and tests.

/**
 * A tax invoice of AUD 1,000 or more (GST-inclusive) must also identify the
 * recipient (name or ABN) — ATO tax-invoice requirements.
 */
export const RECIPIENT_IDENTITY_THRESHOLD_CENTS = 100_000n;

export type InvoiceTitle = "Tax Invoice" | "Invoice";

/** Registered for GST on the issue date → "Tax Invoice"; otherwise "Invoice". */
export function invoiceTitle(registeredOnIssueDate: boolean): InvoiceTitle {
  return registeredOnIssueDate ? "Tax Invoice" : "Invoice";
}

export type InvoiceLineInput = {
  description: string;
  /** Decimal string, up to 4 dp, > 0. */
  quantity: string;
  unitPrice: Cents;
  taxCode: TaxCode;
};

/**
 * Lines priced as entered. A company not registered on the issue date can't
 * charge GST: Taxable lines are refused rather than silently zero-rated.
 */
export function invoiceLines(
  lines: readonly InvoiceLineInput[],
  priceEntry: PriceEntry,
  registered: boolean,
): GstLine[] {
  return lines.map((line) =>
    calculateSupplyLine({
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      priceEntry,
      taxCode: line.taxCode,
      supplierRegistered: registered,
    }),
  );
}

export type IssueCheck = {
  registered: boolean;
  supplier: { legalName: string | null; abn: string | null };
  recipient: { name: string | null; abn: string | null };
  lines: readonly (InvoiceLineInput & { description: string })[];
  /** GST-inclusive total, when the lines are valid. */
  inclusive: Cents;
};

export type IssueProblem = { field: string; message: string };

/**
 * Everything that must be true before an invoice is issued (and frozen).
 * An empty list means it can be issued.
 */
export function issueProblems(input: IssueCheck): IssueProblem[] {
  const problems: IssueProblem[] = [];
  if (input.lines.length === 0)
    problems.push({ field: "lines", message: "Add at least one line" });
  input.lines.forEach((line, index) => {
    if (!line.description.trim())
      problems.push({
        field: `lines.${index}.description`,
        message: "Describe what was supplied",
      });
    if (!input.registered && line.taxCode === "TAXABLE_10")
      problems.push({
        field: `lines.${index}.taxCode`,
        message:
          "The company isn't registered for GST on the issue date, so no line can charge GST",
      });
  });
  if (input.registered) {
    if (!input.supplier.legalName?.trim())
      problems.push({
        field: "company.legalName",
        message: "Add the company's legal name in Settings",
      });
    if (!input.supplier.abn)
      problems.push({
        field: "company.abn",
        message: "Add the company's ABN in Settings",
      });
    if (
      input.inclusive >= RECIPIENT_IDENTITY_THRESHOLD_CENTS &&
      !input.recipient.name?.trim() &&
      !input.recipient.abn
    )
      problems.push({
        field: "customer",
        message:
          "A tax invoice of $1,000 or more must identify the customer by name or ABN",
      });
  }
  return problems;
}

/**
 * How much of an invoice can still be credited: its GST-inclusive total
 * minus issued credit notes. A new credit note may not exceed it.
 */
export function creditableRemaining(
  invoiceInclusive: Cents,
  issuedCredits: readonly Cents[],
): Cents {
  const remaining = invoiceInclusive - sum(issuedCredits);
  return remaining < 0n ? 0n : remaining;
}
