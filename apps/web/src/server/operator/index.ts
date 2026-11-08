import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import {
  getAuth,
  getDatabase,
  getTrustedOrigins,
  isProductionEnvironment,
} from "../auth";
import { emailSecret } from "../email";
import { isOperator } from "./access";
import { PATH_HEADER } from "../routes/public";
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

export type OperatorPageOutcome = "ok" | "reauth" | "enrol" | "not-found";

/**
 * What an operator page does (design §13d, §13e). `strict` is the full check
 * for this page; `relaxed` is the same check without this session's TOTP. An
 * operator whose session lacks a recent TOTP signs in again, or enrols if
 * they haven't; everyone else gets the 404, as if the page didn't exist.
 */
export function operatorPageOutcome({
  strict,
  relaxed,
  twoFactorEnabled,
}: {
  strict: boolean;
  relaxed: boolean;
  twoFactorEnabled: boolean;
}): OperatorPageOutcome {
  if (strict) return "ok";
  if (!relaxed) return "not-found";
  return twoFactorEnabled ? "reauth" : "enrol";
}

/**
 * For operator pages: 404 for anyone who isn't an operator. Only
 * /operator/mfa passes `allowUnenrolled`, so it's the one page reachable
 * before TOTP is set up.
 */
export async function requireOperator(
  options: { allowUnenrolled?: boolean } = {},
): Promise<{ userId: string }> {
  const requestHeaders = await headers();
  const session = await getAuth().api.getSession({ headers: requestHeaders });
  if (!session) notFound();
  const db = getDatabase();
  const production = isProductionEnvironment(process.env);
  const check = (strictMfa: boolean) =>
    isOperator(db, session.user.id, {
      env: process.env,
      production: strictMfa,
      sessionId: session.session.id,
    });
  const strict = await check(production && !options.allowUnenrolled);
  const outcome = operatorPageOutcome({
    strict,
    relaxed: strict || (await check(false)),
    twoFactorEnabled: session.user.twoFactorEnabled === true,
  });
  if (outcome === "reauth") {
    const path = requestHeaders.get(PATH_HEADER) ?? "/operator";
    redirect(
      `/login?reason=operator-code&next=${encodeURIComponent(path.startsWith("/operator") ? path : "/operator")}`,
    );
  }
  if (outcome === "enrol") redirect("/operator/mfa");
  if (outcome === "not-found") notFound();
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
