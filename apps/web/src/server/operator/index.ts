import { headers } from "next/headers";
import { notFound } from "next/navigation";
import {
  getAuth,
  getDatabase,
  getTrustedOrigins,
  isProductionEnvironment,
} from "../auth";
import { emailSecret } from "../email";
import { isOperator } from "./access";
import { operatorHandlers } from "./handlers";
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
    }))
  ) {
    notFound();
  }
  return { userId: session.user.id };
}

/** Wiring for the operator API routes. */
export const operatorApi = operatorHandlers(() => {
  const url = process.env.BETTER_AUTH_URL;
  if (!url) throw new Error("BETTER_AUTH_URL is not configured");
  return {
    db: getDatabase(),
    emailSecret: emailSecret(),
    appUrl: new URL(url).origin,
  };
});
