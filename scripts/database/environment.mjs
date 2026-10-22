import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";

export const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

export function loadLocalEnvironment() {
  const file = new URL("../../.env", import.meta.url);
  if (existsSync(file)) loadEnvFile(file);
}

export function requireDatabaseUrl(value) {
  try {
    const url = new URL(value);
    if (
      !["postgres:", "postgresql:"].includes(url.protocol) ||
      !url.pathname.slice(1)
    ) {
      throw new Error();
    }
    return url;
  } catch {
    throw new Error(
      "A valid PostgreSQL database URL is required (value redacted)",
    );
  }
}

export function assertTestDatabase(environment = process.env) {
  if (
    environment.NODE_ENV === "production" ||
    environment.APP_ENV === "production"
  ) {
    throw new Error("Test database operations are forbidden in production");
  }
  const test = requireDatabaseUrl(environment.TEST_DATABASE_URL);
  if (
    !["localhost", "127.0.0.1", "[::1]"].includes(test.hostname) ||
    test.pathname !== "/jobflow_test" ||
    test.search ||
    test.hash
  ) {
    throw new Error(
      "TEST_DATABASE_URL must target local jobflow_test with no URL options",
    );
  }
  const development = requireDatabaseUrl(environment.DATABASE_URL);
  // libpq/pg decode database paths and may interpret connection URL options.
  // Refuse options on either URL and malformed/encoded paths conservatively.
  if (
    development.search ||
    development.hash ||
    development.pathname.includes("%")
  ) {
    throw new Error(
      "Development database URL must have an unencoded path and no URL options for test operations",
    );
  }
  const sameHost = (url) =>
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      ? "loopback"
      : url.hostname;
  if (
    sameHost(test) === sameHost(development) &&
    (test.port || "5432") === (development.port || "5432") &&
    test.pathname === development.pathname
  ) {
    throw new Error("Development and test databases must be different");
  }
  return test;
}
