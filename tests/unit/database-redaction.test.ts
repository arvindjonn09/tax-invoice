import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";

it("redacts entire diagnostic URLs with quoted or whitespace credentials", () => {
  const source = `
import assert from 'node:assert/strict';
import { redactDatabaseDiagnostics } from './scripts/database/prisma.mjs';
const urls = [
  "postgresql://user:abc'def@host/db",
  'postgres://user:abc"def@host/db',
  'postgresql://user:abc%27def@host/db',
];
for (const url of urls) {
  const result = redactDatabaseDiagnostics('Failure: ' + url + '\\nRetry', {});
  assert.equal(result, 'Failure: [database URL redacted]\\nRetry');
}
const raw = 'postgresql://user:abc def@host/db';
for (const url of [raw, new URL(raw).href]) {
  assert.equal(redactDatabaseDiagnostics('Failure: ' + url + '\\n', { DATABASE_URL: raw }), 'Failure: [database URL redacted]\\n');
}
assert.equal(redactDatabaseDiagnostics('Failure: ' + urls[0], { DATABASE_URL: 'postgresql' }), 'Failure: [database URL redacted]');
assert.equal(redactDatabaseDiagnostics('Failure: ' + raw, { TEST_DATABASE_URL: raw }), 'Failure: [database URL redacted]');
assert.equal(redactDatabaseDiagnostics('Schema is valid.', {}), 'Schema is valid.');
`;
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", source],
    {
      encoding: "utf8",
    },
  );
  expect(result.status, result.stderr).toBe(0);
});
