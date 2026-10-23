import { describe, expect, it } from "vitest";
import { isProductionEnvironment } from "../../apps/web/src/server/auth/index";

describe("isProductionEnvironment", () => {
  it.each([
    [{ NODE_ENV: "production" }, true],
    [{ NODE_ENV: "production", APP_ENV: "production" }, true],
    [{ NODE_ENV: "production", APP_ENV: "staging" }, false],
    [{ NODE_ENV: "production", APP_ENV: "preview" }, false],
    [{ NODE_ENV: "development" }, false],
    [{ NODE_ENV: "development", APP_ENV: "production" }, true],
    [{}, false],
  ])("%j → %s", (env, expected) => {
    expect(isProductionEnvironment(env)).toBe(expected);
  });
});
