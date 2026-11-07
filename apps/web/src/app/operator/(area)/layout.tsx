import type { ReactNode } from "react";
import { OperatorShell } from "@/components/operator/shell";
import { getDatabase } from "@/server/auth";
import { requireOperator } from "@/server/operator";

export const dynamic = "force-dynamic";

/**
 * Every operator page but /operator/mfa (ADR 0004 D2, D5; design §13). Anyone
 * who isn't an operator with TOTP for this session gets the 404, the same as
 * a path that doesn't exist. Each page checks again for itself.
 */
export default async function OperatorLayout({
  children,
}: {
  children: ReactNode;
}) {
  const { userId } = await requireOperator();
  const user = await getDatabase().user.findUniqueOrThrow({
    where: { id: userId },
    select: { email: true },
  });
  return <OperatorShell email={user.email}>{children}</OperatorShell>;
}
