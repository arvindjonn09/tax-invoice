import { createHash, randomBytes } from "node:crypto";
import { type Actor, forbidden, notFound } from "@jobflow/authz";
import { z } from "zod";
import type {
  Prisma,
  PrismaClient,
} from "../../../../../packages/database/src/generated/prisma/client";
import { withAudit } from "../../../../../packages/database/src/index";
import type { Auth } from "../auth/config";
import { createCredentialUser } from "../auth/credentials";
import { privateJson, type PolicyHandler } from "../authz/policy";
import { invalid, jsonOrNull } from "../company/handlers";
import {
  HttpError,
  parsePage,
  readJson,
  requireBodyWithin,
  requireTrustedOrigin,
} from "../http/guards";
import { clientIp, hit } from "../http/throttle";
import { log } from "../log";

const Role = z.enum([
  "owner",
  "manager",
  "accountant",
  "employee",
  "subcontractor",
]);
const Invite = z.object({
  email: z
    .email()
    .max(320)
    .transform((s) => s.toLowerCase()),
  role: Role,
});
const Update = z
  .object({ role: Role.optional(), isActive: z.boolean().optional() })
  .refine(
    (data) => data.role !== undefined || data.isActive !== undefined,
    "Nothing to update",
  );
const Accept = z.object({
  token: z.string().regex(/^[0-9a-f]{64}$/),
  name: z.string().trim().min(1).max(200).optional(),
  password: z.string().min(12).max(128).optional(),
});
const uuid = z.uuid();
export const INVITATION_TTL_MS = 48 * 60 * 60 * 1000;
const digest = (token: string) =>
  createHash("sha256").update(token).digest("hex");
const MEMBER_SELECT = {
  id: true,
  role: true,
  isActive: true,
  userId: true,
  user: { select: { name: true, email: true } },
} as const;
const INVITATION_SELECT = {
  id: true,
  email: true,
  role: true,
  expiresAt: true,
  acceptedAt: true,
  revokedAt: true,
} as const;
// Roll back the read-only transaction without weakening withAudit's guarantee
// that every committed mutation records an event (same pattern as employees).
class UnchangedAccess extends Error {
  constructor(
    readonly member: Prisma.MembershipGetPayload<{
      select: typeof MEMBER_SELECT;
    }>,
  ) {
    super("Membership access is unchanged");
  }
}

type Context = { params: Promise<{ id: string }> };

/** Serialize membership/invitation mutations, then re-check the current owner. */
async function ownerLock(tx: Prisma.TransactionClient, actor: Actor) {
  await tx.$queryRaw`SELECT id FROM companies WHERE id = ${actor.companyId}::uuid FOR UPDATE`;
  const owner = await tx.membership.findUnique({
    where: {
      companyId_userId: { companyId: actor.companyId, userId: actor.userId },
    },
  });
  if (!owner?.isActive || owner.role !== "owner") throw forbidden();
}

export function userHandlers(db: () => PrismaClient) {
  const list: PolicyHandler<unknown> = async ({ actor, request }) => {
    const params = new URL(request.url).searchParams;
    const { page, take, skip } = parsePage(params);
    const invitationPaging = parsePage(
      new URLSearchParams({
        page: params.get("invitationPage") ?? "1",
        pageSize: "100",
      }),
    );
    const invitationWhere = {
      companyId: actor.companyId,
      acceptedAt: null,
      revokedAt: null,
    };
    const q = params.get("q")?.trim().slice(0, 100);
    const where: Prisma.MembershipWhereInput = {
      companyId: actor.companyId,
      ...(q
        ? {
            user: {
              OR: [
                { name: { contains: q, mode: "insensitive" } },
                { email: { contains: q, mode: "insensitive" } },
              ],
            },
          }
        : {}),
    };
    const [members, total, invitations, invitationsTotal] = await Promise.all([
      db().membership.findMany({
        where,
        select: MEMBER_SELECT,
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take,
        skip,
      }),
      db().membership.count({ where }),
      db().userInvitation.findMany({
        where: invitationWhere,
        select: INVITATION_SELECT,
        orderBy: [{ createdAt: "desc" }, { id: "asc" }],
        take: invitationPaging.take,
        skip: invitationPaging.skip,
      }),
      db().userInvitation.count({ where: invitationWhere }),
    ]);
    return privateJson({
      members,
      total,
      page,
      pageSize: take,
      invitations,
      invitationsTotal,
      invitationPage: invitationPaging.page,
      invitationPageSize: invitationPaging.take,
    });
  };

  const update: PolicyHandler<Context> = async ({
    actor,
    request,
    context,
  }) => {
    const { id } = await context.params;
    if (!uuid.safeParse(id).success) throw notFound();
    const parsed = Update.safeParse(await jsonOrNull(request));
    if (!parsed.success) return invalid(parsed.error);
    const row = await withAudit(db(), async (tx, audit) => {
      await ownerLock(tx, actor);
      const before = await tx.membership.findFirst({
        where: { id, companyId: actor.companyId },
        select: MEMBER_SELECT,
      });
      if (!before) throw notFound();
      const role = parsed.data.role ?? before.role;
      const isActive = parsed.data.isActive ?? before.isActive;
      if (role === before.role && isActive === before.isActive)
        throw new UnchangedAccess(before);
      if (
        before.role === "owner" &&
        before.isActive &&
        (role !== "owner" || !isActive)
      ) {
        const owners = await tx.membership.count({
          where: { companyId: actor.companyId, role: "owner", isActive: true },
        });
        if (owners <= 1)
          throw new HttpError(
            409,
            "The last active owner cannot be deactivated or demoted.",
          );
      }
      const member = await tx.membership.update({
        where: { id },
        data: { role, isActive },
        select: MEMBER_SELECT,
      });
      if (before.isActive && !isActive) {
        const remaining = await tx.membership.count({
          where: { userId: before.userId, isActive: true },
        });
        await tx.authSession.deleteMany({
          where: {
            userId: before.userId,
            ...(remaining > 0
              ? {
                  OR: [
                    { activeCompanyId: actor.companyId },
                    { activeCompanyId: null },
                  ],
                }
              : {}),
          },
        });
      }
      await audit({
        companyId: actor.companyId,
        actorUserId: actor.userId,
        action: "membership.access_updated",
        target: { type: "membership", id },
        before: { role: before.role, isActive: before.isActive },
        after: { role, isActive },
      });
      return member;
    }).catch((error: unknown) => {
      if (error instanceof UnchangedAccess) return error.member;
      throw error;
    });
    return privateJson(row);
  };

  const invite: PolicyHandler<unknown> = async ({ actor, request }) => {
    const parsed = Invite.safeParse(await jsonOrNull(request));
    if (!parsed.success) return invalid(parsed.error);
    if (
      (await hit(db(), `invite:user:${actor.userId}`, {
        windowSeconds: 60,
        max: 20,
      })) > 20
    )
      throw new HttpError(
        429,
        "Too many invitations. Wait a minute and try again.",
      );
    const token = randomBytes(32).toString("hex");
    const row = await withAudit(db(), async (tx, audit) => {
      await ownerLock(tx, actor);
      const { email, role } = parsed.data;
      const existing = await tx.membership.findFirst({
        where: { companyId: actor.companyId, user: { email } },
      });
      if (existing)
        throw new HttpError(
          409,
          "This person already has a membership. Edit their access instead.",
        );
      const pending = await tx.userInvitation.findFirst({
        where: {
          companyId: actor.companyId,
          email,
          acceptedAt: null,
          revokedAt: null,
        },
      });
      if (pending) {
        if (pending.expiresAt > new Date())
          throw new HttpError(
            409,
            "A pending invitation already exists. Revoke it before inviting again.",
          );
        await tx.userInvitation.update({
          where: { id: pending.id },
          data: { revokedAt: new Date() },
        });
        await audit({
          companyId: actor.companyId,
          actorUserId: actor.userId,
          action: "invitation.revoked",
          target: { type: "user_invitation", id: pending.id },
          after: { reason: "expired" },
        });
      }
      const created = await tx.userInvitation.create({
        data: {
          companyId: actor.companyId,
          createdBy: actor.userId,
          email,
          role,
          tokenHash: digest(token),
          expiresAt: new Date(Date.now() + INVITATION_TTL_MS),
        },
        select: INVITATION_SELECT,
      });
      await audit({
        companyId: actor.companyId,
        actorUserId: actor.userId,
        action: "invitation.created",
        target: { type: "user_invitation", id: created.id },
        after: { email, role, expiresAt: created.expiresAt },
      });
      return created;
    });
    // Fragment keeps the bearer secret out of access logs, Referer and server renders.
    return privateJson(
      { invitation: row, invitationPath: `/invite#${token}` },
      { status: 201 },
    );
  };

  const revoke: PolicyHandler<Context> = async ({ actor, context }) => {
    const { id } = await context.params;
    if (!uuid.safeParse(id).success) throw notFound();
    await withAudit(db(), async (tx, audit) => {
      await ownerLock(tx, actor);
      const invitation = await tx.userInvitation.findFirst({
        where: { id, companyId: actor.companyId },
      });
      if (!invitation) throw notFound();
      if (invitation.acceptedAt || invitation.revokedAt)
        throw new HttpError(409, "This invitation is no longer pending.");
      await tx.userInvitation.update({
        where: { id },
        data: { revokedAt: new Date() },
      });
      await audit({
        companyId: actor.companyId,
        actorUserId: actor.userId,
        action: "invitation.revoked",
        target: { type: "user_invitation", id },
        after: { revoked: true },
      });
    });
    return privateJson({ revoked: true });
  };
  return { list, update, invite, revoke };
}

/** Public only for invitation redemption; explicit CSRF, body and rate guards. */
export function acceptInvitation(deps: {
  db: () => PrismaClient;
  auth: () => Auth;
  trustedOrigins: () => readonly string[];
}) {
  return async (request: Request): Promise<Response> => {
    try {
      requireTrustedOrigin(request, deps.trustedOrigins());
      requireBodyWithin(request, 4096);
      const db = deps.db();
      if (
        (await hit(
          db,
          `invite:accept:${clientIp(request.headers) ?? "unknown"}`,
          { windowSeconds: 60, max: 20 },
        )) > 20
      )
        throw new HttpError(
          429,
          "Too many attempts. Wait a minute and try again.",
        );
      const parsed = Accept.safeParse(await readJson(request, 4096));
      if (!parsed.success) return invalid(parsed.error);
      const tokenHash = digest(parsed.data.token);
      const candidate = await db.userInvitation.findUnique({
        where: { tokenHash },
      });
      if (!candidate)
        throw new HttpError(
          400,
          "This invitation is invalid or no longer available.",
        );
      const session = await deps
        .auth()
        .api.getSession({ headers: request.headers });
      await withAudit(db, async (tx, audit) => {
        // Same lock order as issue/revoke/access updates; token consumed atomically.
        await tx.$queryRaw`SELECT id FROM companies WHERE id = ${candidate.companyId}::uuid FOR UPDATE`;
        const invitation = await tx.userInvitation.findUniqueOrThrow({
          where: { id: candidate.id },
        });
        if (
          invitation.acceptedAt ||
          invitation.revokedAt ||
          invitation.expiresAt <= new Date()
        )
          throw new HttpError(
            400,
            "This invitation is invalid or no longer available.",
          );
        const inviter = await tx.membership.findUnique({
          where: {
            companyId_userId: {
              companyId: invitation.companyId,
              userId: invitation.createdBy,
            },
          },
        });
        if (!inviter?.isActive || inviter.role !== "owner")
          throw new HttpError(
            400,
            "This invitation is invalid or no longer available.",
          );
        let user = await tx.user.findUnique({
          where: { email: invitation.email },
        });
        if (user) {
          if (session?.user.id !== user.id)
            throw new HttpError(
              401,
              "Sign in with the invited email address, then return to this invitation.",
            );
          if (
            await tx.membership.findUnique({
              where: {
                companyId_userId: {
                  companyId: invitation.companyId,
                  userId: user.id,
                },
              },
            })
          )
            throw new HttpError(
              409,
              "A membership already exists. Ask the owner to edit your access.",
            );
        } else {
          if (session)
            throw new HttpError(
              403,
              "Sign out before setting up a different account.",
            );
          const { name, password } = parsed.data;
          if (!name || !password)
            throw new HttpError(
              400,
              "Enter your name and a password of 12–128 characters for a new account.",
            );
          user = await createCredentialUser(tx, {
            email: invitation.email,
            name,
            password,
            createdBy: invitation.createdBy,
          });
        }
        const member = await tx.membership.create({
          data: {
            companyId: invitation.companyId,
            userId: user.id,
            role: invitation.role,
            createdBy: invitation.createdBy,
          },
        });
        await tx.userInvitation.update({
          where: { id: invitation.id },
          data: { acceptedAt: new Date() },
        });
        // The inviter authorized this grant; recipient identity is also captured.
        await audit({
          companyId: invitation.companyId,
          actorUserId: invitation.createdBy,
          action: "invitation.accepted",
          target: { type: "user_invitation", id: invitation.id },
          after: {
            membershipId: member.id,
            recipientUserId: user.id,
            role: invitation.role,
          },
        });
      });
      return privateJson({ accepted: true });
    } catch (error) {
      if (error instanceof HttpError)
        return privateJson({ error: error.message }, { status: error.status });
      // Cross-company concurrent invitations may race creating the global user.
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "P2002"
      )
        return privateJson(
          {
            error:
              "An account now exists. Sign in with the invited email and retry.",
          },
          { status: 409 },
        );
      const reference = crypto.randomUUID();
      log("error", "invitation.accept_failed", { reference });
      return privateJson(
        { error: "Unable to accept invitation. Try again.", reference },
        { status: 500 },
      );
    }
  };
}
