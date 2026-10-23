export const repositoryRoot: string;
/** Load the repository's private .env into process.env if it exists. */
export function loadLocalEnvironment(): void;
/** Parse a PostgreSQL URL or throw (the value is never echoed). */
export function requireDatabaseUrl(value: string | undefined): URL;
/** Validate the local test database URL; refuses production. */
export function assertTestDatabase(environment?: NodeJS.ProcessEnv): URL;
