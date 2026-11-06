import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { getAuth, getDatabase, isProductionEnvironment } from "../auth";
import { getTrustedOrigins } from "../auth";
import { isOperator } from "./access";
import { createWithOperator } from "./policy";

const deps = {
  db: getDatabase,
  auth: getAuth,
  trustedOrigins: getTrustedOrigins,
  env: () => process.env,
  production: () => isProductionEnvironment(process.env),
};

/** For `app/api/operator/**`, and only those routes (route-policy.test.ts). */
export const withOperator = createWithOperator(deps);

/**
 * For operator pages: 404 on any failure. Only /operator/mfa passes
 * `allowUnenrolled`, so it's the one page reachable before TOTP is set up.
 */
export async function requireOperator(
  options: { allowUnenrolled?: boolean } = {},
): Promise<{ userId: string }> {
  const session = await getAuth().api.getSession({
    headers: await headers(),
  });
  if (
    !session ||
    !(await isOperator(getDatabase(), session.user.id, {
      env: process.env,
      production:
        isProductionEnvironment(process.env) && !options.allowUnenrolled,
      sessionId: session.session.id,
    }))
  ) {
    notFound();
  }
  return { userId: session.user.id };
}
