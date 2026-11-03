import {
  getDatabase,
  getTrustedOrigins,
  isProductionEnvironment,
} from "../auth";
import { loadAdminConfig } from "./auth";
import type { AdminDependencies } from "./handlers";

/** Production wiring; `.env-admin` is re-read on every request. */
export const adminDeps: AdminDependencies = {
  db: getDatabase,
  config: () => loadAdminConfig(),
  trustedOrigins: getTrustedOrigins,
  secureCookies: () =>
    isProductionEnvironment(process.env) ||
    (process.env.BETTER_AUTH_URL ?? "").startsWith("https:"),
};
