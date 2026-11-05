/**
 * Does `error` carry a PostgreSQL error with this SQLSTATE and marker text,
 * directly or wrapped by Prisma's driver adapter (`meta`, `cause`,
 * `driverAdapterError`)? At most five wrapper edges and no cycles, so a deep
 * or circular chain can't overflow the stack inside a route's error handler.
 */
export function hasDatabaseError(
  error: unknown,
  sqlstate: string,
  marker: string,
): boolean {
  const visited = new WeakSet<object>();
  const inspect = (value: unknown, depth: number): boolean => {
    if (!value || typeof value !== "object" || visited.has(value)) return false;
    visited.add(value);
    const row = value as Record<string, unknown>;
    const state = row.code ?? row.originalCode;
    if (
      state === sqlstate &&
      [row.message, row.originalMessage].some(
        (message) => typeof message === "string" && message.includes(marker),
      )
    )
      return true;
    if (depth === 5) return false;
    return [row.meta, row.cause, row.driverAdapterError].some((child) =>
      inspect(child, depth + 1),
    );
  };
  return inspect(error, 0);
}
