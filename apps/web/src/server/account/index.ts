import {
  getAuth,
  getDatabase,
  getTrustedOrigins,
  isProductionEnvironment,
} from "../auth";
import { dispatchSoon, emailSecret } from "../email";
import { isBreachedPassword } from "../security/pwned";
import { verifyTurnstile } from "../security/turnstile";
import type { AccountDependencies } from "./handlers";

function appUrl(): string {
  const url = process.env.BETTER_AUTH_URL;
  if (!url) throw new Error("BETTER_AUTH_URL is not configured");
  return new URL(url).origin;
}

/** Production wiring for the public account endpoints. */
export const accountDeps: AccountDependencies = {
  db: getDatabase,
  auth: getAuth,
  trustedOrigins: getTrustedOrigins,
  appUrl,
  emailSecret,
  production: () => isProductionEnvironment(process.env),
  dispatch: dispatchSoon,
  isBreached: (password) => isBreachedPassword(password),
  verifyTurnstile: (token, action, ip) =>
    verifyTurnstile(token, action, {
      production: isProductionEnvironment(process.env),
      hostname: new URL(appUrl()).hostname,
      ip,
    }),
};
