import type { PrismaClient } from "../../../../../packages/database/src/generated/prisma/client";
import type { Auth } from "../auth/config";
import { privateJson } from "../authz/policy";
import {
  HttpError,
  MAX_JSON_BYTES,
  requireBodyWithin,
  requireTrustedOrigin,
} from "../http/guards";
import { log, safeError } from "../log";
import { isOperator } from "./access";

export type OperatorDependencies = {
  db: () => PrismaClient;
  auth: () => Pick<Auth, "api">;
  trustedOrigins: () => readonly string[];
  env: () => Readonly<Record<string, string | undefined>>;
  production: () => boolean;
};

export type OperatorHandler<Context> = (input: {
  operatorUserId: string;
  request: Request;
  context: Context;
}) => Promise<Response>;

const notFound = () => privateJson({ error: "Not found" }, { status: 404 });

/**
 * ADR 0004 D2 and D5: origin, body limit and operator check. Every failure
 * returns the same 404, so the area can't be discovered.
 */
export function createWithOperator(deps: OperatorDependencies) {
  return function withOperator<Context = unknown>(
    handler: OperatorHandler<Context>,
  ) {
    return async (request: Request, context: Context): Promise<Response> => {
      try {
        requireTrustedOrigin(request, deps.trustedOrigins());
        requireBodyWithin(request, MAX_JSON_BYTES);
        const session = await deps
          .auth()
          .api.getSession({ headers: request.headers });
        if (
          !session ||
          !(await isOperator(deps.db(), session.user.id, {
            env: deps.env(),
            production: deps.production(),
            sessionId: session.session.id,
          }))
        ) {
          return notFound();
        }
        return await handler({
          operatorUserId: session.user.id,
          request,
          context,
        });
      } catch (error) {
        if (error instanceof HttpError) return notFound();
        const reference = crypto.randomUUID();
        log("error", "operator.unhandled", {
          reference,
          method: request.method,
          path: new URL(request.url).pathname,
          error: safeError(error),
        });
        return privateJson(
          { error: "Something went wrong. Try again.", reference },
          { status: 500 },
        );
      }
    };
  };
}
