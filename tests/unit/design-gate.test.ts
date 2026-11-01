import { describe, expect, it } from "vitest";
import { designPreviewsAvailable } from "../../apps/web/src/server/design/gate";

// #61: static design samples never reach production.
describe("design previews gate", () => {
  it.each([
    [{ NODE_ENV: "production" }, false],
    [{ NODE_ENV: "production", APP_ENV: "production" }, false],
    [{ NODE_ENV: "development", APP_ENV: "production" }, false],
    [{ NODE_ENV: "production", APP_ENV: "staging" }, true],
    [{ NODE_ENV: "production", APP_ENV: "preview" }, true],
    [{ NODE_ENV: "development" }, true],
    [{ NODE_ENV: "test" }, true],
  ])("%j → %s", (env, expected) => {
    expect(designPreviewsAvailable(env)).toBe(expected);
  });
});
