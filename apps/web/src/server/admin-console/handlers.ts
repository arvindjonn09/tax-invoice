import type { PrismaClient } from "../../../../../packages/database/src/generated/prisma/client";
import { privateJson } from "../authz/policy";
import {
  HttpError,
  readJson,
  requireBodyWithin,
  requireTrustedOrigin,
} from "../http/guards";
import { clientIp, hit } from "../http/throttle";
import { log, safeError } from "../log";
import {
  ADMIN_COOKIE,
  type AdminConfig,
  clearedCookie,
  createSessionToken,
  credentialsMatch,
  readCookie,
  sessionCookie,
  verifySessionToken,
} from "./auth";
import { AdminActionError, assignFullLicence, extendTrial } from "./data";

export type AdminDependencies = {
  db: () => PrismaClient;
  config: () => AdminConfig | null;
  trustedOrigins: () => readonly string[];
  secureCookies: () => boolean;
};

const notFound = () => new Response("Not found", { status: 404 });

/** Origin + size guards; 404 when the console is off; errors never leak. */
function route(
  deps: AdminDependencies,
  handler: (request: Request, config: AdminConfig) => Promise<Response>,
) {
  return async (request: Request): Promise<Response> => {
    const config = deps.config();
    if (!config) return notFound();
    try {
      requireTrustedOrigin(request, deps.trustedOrigins());
      requireBodyWithin(request, 2048);
      return await handler(request, config);
    } catch (error) {
      if (error instanceof HttpError) {
        return privateJson({ error: error.message }, { status: error.status });
      }
      if (error instanceof AdminActionError) {
        return privateJson({ error: error.message }, { status: 400 });
      }
      const reference = crypto.randomUUID();
      log("error", "admin_console.unhandled", {
        reference,
        error: safeError(error),
      });
      return privateJson(
        { error: "Something went wrong.", reference },
        { status: 500 },
      );
    }
  };
}

export function isAdminRequest(config: AdminConfig, headers: Headers): boolean {
  return verifySessionToken(
    config,
    readCookie(headers.get("cookie"), ADMIN_COOKIE),
  );
}

function requireAdmin(config: AdminConfig, request: Request): void {
  if (!isAdminRequest(config, request.headers)) {
    throw new HttpError(401, "Sign in to the admin console");
  }
}

async function body(request: Request): Promise<Record<string, unknown>> {
  const value = await readJson(request, 2048).catch(() => null);
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

/** POST /api/admin-console/login: 5 attempts per 15 minutes per IP. */
export function adminLogin(deps: AdminDependencies) {
  return route(deps, async (request, config) => {
    const ip = clientIp(request.headers) ?? "unknown";
    if (
      (await hit(deps.db(), `admin-console:login:${ip}`, {
        windowSeconds: 900,
        max: 5,
      })) > 5
    ) {
      throw new HttpError(429, "Too many attempts. Wait 15 minutes.");
    }
    const input = await body(request);
    const ok = await credentialsMatch(
      config,
      String(input.username ?? "").slice(0, 200),
      String(input.password ?? "").slice(0, 200),
    );
    log(ok ? "info" : "warn", "admin_console.login", { ok, ip });
    if (!ok) throw new HttpError(401, "Username or password is incorrect");
    return privateJson(
      { ok: true },
      {
        headers: {
          "set-cookie": sessionCookie(
            createSessionToken(config),
            deps.secureCookies(),
          ),
        },
      },
    );
  });
}

export function adminLogout(deps: AdminDependencies) {
  return route(deps, async () =>
    privateJson(
      { ok: true },
      { headers: { "set-cookie": clearedCookie(deps.secureCookies()) } },
    ),
  );
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** POST /api/admin-console/organisations: `{ companyId, action, days? }`. */
export function adminOrganisationAction(deps: AdminDependencies) {
  return route(deps, async (request, config) => {
    requireAdmin(config, request);
    const input = await body(request);
    const companyId = String(input.companyId ?? "");
    if (!UUID.test(companyId)) throw new HttpError(400, "Unknown organisation");
    if (input.action === "assign_full_licence") {
      await assignFullLicence(deps.db(), companyId);
      log("info", "admin_console.licence_assigned", { companyId });
      return privateJson({ ok: true });
    }
    if (input.action === "extend_trial") {
      const lastDay = await extendTrial(
        deps.db(),
        companyId,
        Number(input.days),
      );
      log("info", "admin_console.trial_extended", { companyId, lastDay });
      return privateJson({ ok: true, lastDay });
    }
    throw new HttpError(400, "Unknown action");
  });
}
