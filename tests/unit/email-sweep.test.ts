import { afterEach, describe, expect, it } from "vitest";
import { setLogSink } from "../../apps/web/src/server/log";
import {
  FAILURE_LOG_EVERY,
  startEmailSweep,
  sweepEnabled,
} from "../../apps/web/src/server/email/sweep";

// #259: the outbox sweep timer.
let stop: () => void = () => undefined;
afterEach(() => stop());

describe("sweepEnabled", () => {
  it("is on in production builds unless EMAIL_SWEEP=off, and off elsewhere unless EMAIL_SWEEP=on", () => {
    expect(sweepEnabled({ NODE_ENV: "production" })).toBe(true);
    expect(sweepEnabled({ NODE_ENV: "production", EMAIL_SWEEP: "off" })).toBe(
      false,
    );
    expect(sweepEnabled({ NODE_ENV: "development" })).toBe(false);
    expect(sweepEnabled({ NODE_ENV: "test", EMAIL_SWEEP: " On " })).toBe(true);
  });
});

describe("startEmailSweep", () => {
  it("runs on its interval, never overlaps a slow sweep, and starts once per process", async () => {
    let runs = 0;
    let active = 0;
    let overlapped = false;
    stop = startEmailSweep(async () => {
      runs += 1;
      active += 1;
      if (active > 1) overlapped = true;
      await new Promise((resolve) => setTimeout(resolve, 45));
      active -= 1;
    }, 10);
    const second = startEmailSweep(async () => {
      throw new Error("a second timer must not start");
    }, 10);
    await new Promise((resolve) => setTimeout(resolve, 200));
    second();
    expect(runs).toBeGreaterThanOrEqual(2);
    expect(runs).toBeLessThanOrEqual(5);
    expect(overlapped).toBe(false);
  });

  it("logs a lasting fault once, not on every failed sweep", async () => {
    const lines: string[] = [];
    const restore = setLogSink((line) => lines.push(line));
    let runs = 0;
    stop = startEmailSweep(async () => {
      runs += 1;
      throw new Error("SMTP is not configured");
    }, 5);
    await new Promise((resolve) => setTimeout(resolve, 120));
    stop();
    restore();
    expect(runs).toBeGreaterThan(3);
    expect(runs).toBeLessThan(FAILURE_LOG_EVERY);
    expect(lines.filter((l) => l.includes("email.sweep_failed"))).toHaveLength(
      1,
    );
  });

  it("keeps sweeping after a failed sweep", async () => {
    let runs = 0;
    stop = startEmailSweep(async () => {
      runs += 1;
      throw new Error("database down");
    }, 10);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(runs).toBeGreaterThanOrEqual(2);
  });
});
