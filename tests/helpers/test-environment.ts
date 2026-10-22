/** Reject arbitrary/shared URLs, even when an isolated-database marker is forged. */
export function isolatedTestConnection(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const name = environment.JOBFLOW_ISOLATED_TEST_DATABASE;
  const connection = environment.DATABASE_URL;
  if (
    environment.NODE_ENV === "production" ||
    !name ||
    !/^jobflow_test_[a-f0-9]{32}$/.test(name) ||
    !connection
  ) {
    throw new Error("Use pnpm test:integration for a disposable test database");
  }
  let url: URL;
  try {
    url = new URL(connection);
  } catch {
    throw new Error("Invalid isolated test connection (details redacted)");
  }
  if (
    !/^postgres(?:ql)?:$/.test(url.protocol) ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.pathname !== `/${name}` ||
    url.search ||
    url.hash ||
    environment.TEST_DATABASE_URL !== connection
  ) {
    throw new Error(
      "Test transaction requires the matching loopback isolated database",
    );
  }
  return connection;
}
