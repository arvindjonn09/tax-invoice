import { hashPassword } from "better-auth/crypto";
import type {
  Prisma,
  PrismaClient,
  User,
} from "../../../../../packages/database/src/generated/prisma/client";
import { MIN_PASSWORD_LENGTH } from "./config";

/**
 * Create a user who signs in with email + password. Public sign-up is disabled,
 * so owners (#27) and the demo seed (#21) create users through this function.
 * The password is hashed (scrypt) by Better Auth and never stored or logged.
 */
export async function createCredentialUser(
  db: PrismaClient | Prisma.TransactionClient,
  input: { email: string; name: string; password: string; createdBy?: string },
): Promise<User> {
  if (
    input.password.length < MIN_PASSWORD_LENGTH ||
    input.password.length > 128
  ) {
    throw new RangeError(
      `Password must be ${MIN_PASSWORD_LENGTH}-128 characters`,
    );
  }
  const email = input.email.trim().toLowerCase();
  const password = await hashPassword(input.password);
  const user = await db.user.create({
    data: {
      email,
      name: input.name,
      ...(input.createdBy ? { createdBy: input.createdBy } : {}),
    },
  });
  await db.authAccount.create({
    data: {
      userId: user.id,
      accountId: user.id,
      providerId: "credential",
      password,
    },
  });
  return user;
}
