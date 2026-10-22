/** Provision, migrate, use and drop a uniquely named local test database. */
export function withIsolatedDatabase<T>(
  run: (environment: NodeJS.ProcessEnv) => T | Promise<T>,
  environment?: NodeJS.ProcessEnv,
): Promise<T>;
