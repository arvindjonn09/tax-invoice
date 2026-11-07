import { describe, expect, it } from "vitest";
import {
  sydneyDateTime,
  waitText,
} from "../src/app/(app)/settings/trial/format";

// #232 (design §12): request times in Sydney, and the 429 wait.
describe("trial settings formatting", () => {
  it("shows request times in Sydney time", () => {
    // 22:14 UTC on 2 Dec is 9:14 am on 3 Dec in Sydney (AEDT).
    expect(sydneyDateTime("2026-12-02T22:14:00Z")).toBe("3 Dec 2026, 9:14 am");
  });

  it("counts the wait in hours, then as a day past 48 hours", () => {
    const now = new Date("2026-12-01T00:00:00Z");
    expect(waitText(60, now)).toBe("in 1 hour");
    expect(waitText(5 * 3600, now)).toBe("in 5 hours");
    expect(waitText(48 * 3600, now)).toBe("in 48 hours");
    expect(waitText(9 * 86_400, now)).toBe("on 10 Dec 2026");
  });
});
