import { randomBytes } from "node:crypto";
import { userInfo } from "node:os";
import type { PrismaClient } from "../../../../../packages/database/src/generated/prisma/client";
import { z } from "zod";
import { enrolmentCodeDigest, isOperator, operatorAllowlist } from "./access";
import { extendTrial, setAccessMode } from "./trial-access";

export const ENROLMENT_CODE_TTL_MS = 10 * 60_000;

type Env = Readonly<Record<string, string | undefined>>;
export type CliValues = {
  user?: string | undefined;
  reason?: string | undefined;
  by?: string | undefined;
  as?: string | undefined;
  company?: string | undefined;
  "last-day"?: string | undefined;
  mode?: string | undefined;
  reset?: boolean | undefined;
};

export const USAGE = [
  "Usage: pnpm operator grant --user <uuid> --reason <text> [--by <name>]",
  "       pnpm operator revoke --user <uuid> --reason <text> [--by <name>]",
  "       pnpm operator list",
  "       pnpm operator enrol-code --user <uuid> [--by <name>] [--reset]",
  "       pnpm operator extend --as <operatorUserId> --company <uuid> --last-day <date> --reason <text>",
  "       pnpm operator access --as <operatorUserId> --company <uuid> --mode trial|unrestricted [--last-day <date>] --reason <text>",
].join("\n");

const uuid = (value: string | undefined, flag: string) => {
  if (!z.uuid().safeParse(value).success) {
    throw new Error(`--${flag} must be a UUID\n${USAGE}`);
  }
  return value!;
};
const text = (value: string | undefined, flag: string, max: number) => {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.length > max) {
    throw new Error(`--${flag} must be 1–${max} characters\n${USAGE}`);
  }
  return trimmed;
};

/** Who ran the command: --by if given, otherwise the OS user. */
const byWhom = (values: CliValues) =>
  text(values.by?.trim() || userInfo().username, "by", 100);

async function grant(db: PrismaClient, values: CliValues) {
  const userId = uuid(values.user, "user");
  const reason = text(values.reason, "reason", 500);
  const by = byWhom(values);
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { emailVerified: true },
  });
  if (!user) throw new Error("No user has that ID");
  if (!user.emailVerified) {
    throw new Error("An operator needs a verified email address");
  }
  await db.$transaction(async (tx) => {
    await tx.platformOperator.upsert({
      where: { userId },
      create: { userId, grantedReason: reason, grantedBy: by },
      update: {
        grantedAt: new Date(),
        grantedReason: reason,
        grantedBy: by,
        revokedAt: null,
        revokedReason: null,
      },
    });
    await tx.platformAuditEvent.create({
      data: {
        actorKind: "system",
        userId,
        action: "operator.granted",
        metadata: { by, via: "cli", reason },
      },
    });
  });
  return `Granted. Also add ${userId} to JOBFLOW_OPERATOR_USER_IDS and restart the app.`;
}

async function revoke(db: PrismaClient, values: CliValues) {
  const userId = uuid(values.user, "user");
  const reason = text(values.reason, "reason", 500);
  const by = byWhom(values);
  await db.$transaction(async (tx) => {
    const { count } = await tx.platformOperator.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
    if (count !== 1) throw new Error("That user isn't an active operator");
    // Refuse a code issued earlier, which would otherwise outlive the role.
    await tx.operatorEnrolmentCode.updateMany({
      where: { userId, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    await tx.platformAuditEvent.create({
      data: {
        actorKind: "system",
        userId,
        action: "operator.revoked",
        metadata: { by, via: "cli", reason },
      },
    });
  });
  return "Revoked. It takes effect on the next request.";
}

async function list(db: PrismaClient, env: Env) {
  const allowlist = operatorAllowlist(env);
  const rows = await db.platformOperator.findMany({
    where: { revokedAt: null },
    orderBy: { grantedAt: "asc" },
    select: {
      userId: true,
      grantedAt: true,
      user: { select: { twoFactorEnabled: true } },
    },
  });
  if (rows.length === 0) return "No active operators.";
  return rows
    .map(
      (row) =>
        `${row.userId} granted ${row.grantedAt.toISOString()} allowlisted=${allowlist.has(row.userId)} mfa=${row.user.twoFactorEnabled}`,
    )
    .join("\n");
}

/** Prints a one-time code. `--reset` also removes a lost device's TOTP. */
async function enrolCode(db: PrismaClient, values: CliValues) {
  const userId = uuid(values.user, "user");
  const by = byWhom(values);
  const code = randomBytes(24).toString("base64url");
  await db.$transaction(async (tx) => {
    const operator = await tx.platformOperator.findUnique({
      where: { userId },
      select: { revokedAt: true },
    });
    if (!operator || operator.revokedAt) {
      throw new Error("That user isn't an active operator");
    }
    await tx.operatorEnrolmentCode.updateMany({
      where: { userId, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    await tx.operatorEnrolmentCode.create({
      data: {
        userId,
        codeHash: enrolmentCodeDigest(code),
        expiresAt: new Date(Date.now() + ENROLMENT_CODE_TTL_MS),
      },
    });
    let sessionsDeleted = 0;
    if (values.reset) {
      await tx.twoFactor.deleteMany({ where: { userId } });
      await tx.user.update({
        where: { id: userId },
        data: { twoFactorEnabled: false },
      });
      ({ count: sessionsDeleted } = await tx.authSession.deleteMany({
        where: { userId },
      }));
    }
    await tx.platformAuditEvent.create({
      data: {
        actorKind: "system",
        userId,
        action: "operator.enrolment_code_issued",
        metadata: {
          by,
          via: "cli",
          reset: Boolean(values.reset),
          sessionsDeleted,
        },
      },
    });
  });
  return `Enrolment code, valid for 10 minutes and one use:\n${code}`;
}

/** D5: --as must pass the two-key check; shell access stands in for TOTP. */
async function requireActing(
  db: PrismaClient,
  command: string,
  values: CliValues,
  env: Env,
) {
  const operatorUserId = uuid(values.as, "as");
  if (!(await isOperator(db, operatorUserId, { env, production: false }))) {
    throw new Error("--as must be an active, allowlisted operator");
  }
  await db.platformAuditEvent.create({
    data: {
      actorKind: "system",
      userId: operatorUserId,
      action: "operator.cli_command",
      metadata: { by: byWhom(values), via: "cli", command },
    },
  });
  return operatorUserId;
}

function trialDeps(db: PrismaClient, env: Env) {
  const emailSecret = env.EMAIL_OUTBOX_KEY;
  const appUrl = env.BETTER_AUTH_URL;
  if (!emailSecret || !appUrl) {
    throw new Error("EMAIL_OUTBOX_KEY and BETTER_AUTH_URL must be set");
  }
  return { db, emailSecret, appUrl: new URL(appUrl).origin };
}

export async function runOperatorCommand(
  db: PrismaClient,
  command: string | undefined,
  values: CliValues,
  env: Env,
): Promise<string> {
  if (!env.APP_ENV) throw new Error("Set APP_ENV before running this command");
  switch (command) {
    case "grant":
      return grant(db, values);
    case "revoke":
      return revoke(db, values);
    case "list":
      return list(db, env);
    case "enrol-code":
      return enrolCode(db, values);
    case "extend": {
      const operatorUserId = await requireActing(db, command, values, env);
      const { lastDay } = await extendTrial(trialDeps(db, env), {
        operatorUserId,
        companyId: uuid(values.company, "company"),
        lastDay: text(values["last-day"], "last-day", 10),
        reason: text(values.reason, "reason", 500),
      });
      return `Extended. The last trial day is now ${lastDay}.`;
    }
    case "access": {
      const operatorUserId = await requireActing(db, command, values, env);
      const base = {
        operatorUserId,
        companyId: uuid(values.company, "company"),
        reason: text(values.reason, "reason", 500),
      };
      if (values.mode === "unrestricted") {
        await setAccessMode(trialDeps(db, env), {
          ...base,
          mode: "unrestricted",
        });
      } else if (values.mode === "trial") {
        await setAccessMode(trialDeps(db, env), {
          ...base,
          mode: "trial",
          lastDay: text(values["last-day"], "last-day", 10),
        });
      } else {
        throw new Error(`--mode must be trial or unrestricted\n${USAGE}`);
      }
      return `Access mode is now ${values.mode}.`;
    }
    default:
      throw new Error(USAGE);
  }
}
