import { formatAudCents } from "@/components/money-display";
import { type Invoice, taxLabel } from "./types";

/** A document's saved lines with the server's per-line amounts. */
export function InvoiceLines({
  invoice,
}: {
  invoice: Pick<Invoice, "lines" | "priceEntry">;
}) {
  return (
    <ol className="space-y-3">
      {invoice.lines.map((line, index) => (
        <li
          key={line.id}
          className="rounded-lg border p-4 [overflow-wrap:anywhere]"
        >
          <p className="font-semibold">
            {index + 1}. {line.description}
          </p>
          <p className="text-sm tabular-nums">
            {line.quantity}
            {line.unit ? ` ${line.unit}` : ""} ×{" "}
            {formatAudCents(BigInt(line.unitPriceCents))} (
            {invoice.priceEntry === "exclusive" ? "ex" : "incl"} GST) ·{" "}
            {taxLabel(line.taxCode)}
          </p>
          <p className="text-sm tabular-nums">
            {formatAudCents(BigInt(line.exclusiveCents))} ex GST ·{" "}
            {formatAudCents(BigInt(line.gstCents))} GST ·{" "}
            {formatAudCents(BigInt(line.inclusiveCents))} incl GST
          </p>
        </li>
      ))}
    </ol>
  );
}
