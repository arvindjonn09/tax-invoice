import { expect, it } from "vitest";
import { syntheticFactory } from "../helpers/factories";
import { isolatedTestConnection } from "../helpers/test-environment";

it("repeats synthetic fixture sequences without sharing global counters", () => {
  const first = syntheticFactory(11);
  const second = syntheticFactory(11);
  const user = first.user();
  expect(user).toEqual(second.user());
  expect(user.email).toMatch(/@example\.test$/);
  expect(user.id).toMatch(/^[a-f0-9]{8}-0000-4000-8000-[a-f0-9]{12}$/);
  const company = first.company(user.id);
  expect(company).toEqual(second.company(user.id));
  expect(company.isDemo).toBe(true);
  expect(first.membership(company.id, user.id)).toEqual(
    second.membership(company.id, user.id),
  );
  expect(syntheticFactory(12).id()).not.toBe(syntheticFactory(11).id());
});

it.each([0, -1, 1.5, Number.NaN, 0x100000000])(
  "rejects invalid factory seed %s",
  (seed) => {
    expect(() => syntheticFactory(seed)).toThrow("seed");
  },
);

const name = `jobflow_test_${"a".repeat(32)}`;
const connection = `postgresql://synthetic:fake@127.0.0.1:5432/${name}`;
const environment = {
  NODE_ENV: "test",
  JOBFLOW_ISOLATED_TEST_DATABASE: name,
  DATABASE_URL: connection,
  TEST_DATABASE_URL: connection,
};
it("requires the matching harness-provisioned loopback database", () => {
  expect(isolatedTestConnection(environment)).toBe(connection);
});
it.each([
  { NODE_ENV: "production" },
  { DATABASE_URL: "malformed://synthetic-invalid" },
  { JOBFLOW_ISOLATED_TEST_DATABASE: undefined },
  { DATABASE_URL: connection.replace("127.0.0.1", "remote.example.test") },
  { DATABASE_URL: connection.replace(name, "jobflow_test") },
  { DATABASE_URL: connection.replace(name, "jobflow") },
  { DATABASE_URL: `${connection}?options=-csearch_path=public` },
  { TEST_DATABASE_URL: connection.replace(name, "other") },
])("refuses unsafe per-test transaction environment %j", (overrides) => {
  expect(() =>
    isolatedTestConnection({ ...environment, ...overrides }),
  ).toThrow();
});
