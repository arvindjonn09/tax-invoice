import { gstStatusOn } from "@jobflow/domain";
import { getDatabase } from "@/server/auth";
import { sydneyToday, toDay } from "@/server/company/gst";

/** Today's Sydney date and whether the company is registered for GST on it. */
export async function quoteDay(companyId: string) {
  const today = sydneyToday();
  const rows = await getDatabase().companyGstRegistration.findMany({
    where: { companyId },
    orderBy: { startsOn: "asc" },
  });
  const status = gstStatusOn(
    rows.map((row) => ({
      startsOn: toDay(row.startsOn),
      endsOn: row.endsOn ? toDay(row.endsOn) : null,
      basis: row.basis,
    })),
    today,
  );
  return { today, registeredToday: status.registered };
}
