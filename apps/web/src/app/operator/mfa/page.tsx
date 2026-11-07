import type { Metadata } from "next";
import Link from "next/link";
import { OperatorShell } from "@/components/operator/shell";
import { getDatabase } from "@/server/auth";
import { requireOperator } from "@/server/operator";
import { Enrolment } from "./enrolment";

export const metadata: Metadata = {
  title: "Set up two-factor authentication · Operator",
};
export const dynamic = "force-dynamic";

/**
 * TOTP enrolment (design §13d): the only operator page reachable before
 * TOTP is set up. Everyone who isn't an operator gets the 404.
 */
export default async function OperatorMfaPage() {
  const { userId } = await requireOperator({ allowUnenrolled: true });
  const user = await getDatabase().user.findUniqueOrThrow({
    where: { id: userId },
    select: { email: true, twoFactorEnabled: true },
  });
  return (
    <OperatorShell email={user.email} nav={false}>
      {user.twoFactorEnabled ? (
        <>
          <h1 className="text-3xl font-bold tracking-tight">
            Two-factor authentication is on.
          </h1>
          <p>
            To set it up again on a new device, ask for a new enrolment code on
            the server.
          </p>
          <p>
            <Link
              href="/operator"
              className="inline-flex min-h-11 items-center font-semibold underline"
            >
              Go to the operator area
            </Link>
          </p>
        </>
      ) : (
        <Enrolment />
      )}
    </OperatorShell>
  );
}
