import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";
it("enforces effective strict compiler settings throughout the workspace", () => {
  expect(() =>
    execFileSync(process.execPath, ["scripts/check-strict.mjs"]),
  ).not.toThrow();
});
