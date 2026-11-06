import { formatAudCents } from "@/components/money-display";

/**
 * The GST line of a totals box (#302). It always shows the amount the total
 * includes, so subtotal + GST = total on screen. "No GST charged" appears
 * only when the company isn't registered and the amount is nil; a draft
 * that still carries GST while unregistered says so instead.
 */
export function GstRow({
  gstCents,
  registered,
  action,
}: {
  gstCents: string;
  registered: boolean | null;
  action: "issue" | "send";
}) {
  const gst = BigInt(gstCents);
  const unregistered = registered === false;
  return (
    <>
      <div className="flex justify-between gap-4">
        <dt className="shrink-0">GST</dt>
        <dd className="tabular-nums">
          {unregistered && gst === 0n
            ? "No GST charged"
            : `${formatAudCents(gst)} AUD`}
        </dd>
      </div>
      {unregistered && gst !== 0n ? (
        <p
          role="status"
          className="rounded-sm bg-warning p-3 text-sm text-warning-foreground"
        >
          This total includes GST from Taxable lines, but the company isn&apos;t
          registered for GST on the {action} date. Change those lines, or choose
          a date in a registered period, before you {action}.
        </p>
      ) : null}
    </>
  );
}
