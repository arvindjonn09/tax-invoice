import { describe, expect, it, vi } from "vitest";
import { cachedReadiness } from "../../apps/web/src/server/health/readiness";

describe("cached readiness (#168)", () => {
  it("shares concurrent probes, caches both outcomes for two seconds, then refreshes", async () => {
    let time = 0;
    let resolve!: (value: boolean) => void;
    const check = vi.fn(() => new Promise<boolean>((done) => (resolve = done)));
    const read = cachedReadiness(check, 2000, () => time);
    const first = read();
    const second = read();
    expect(check).toHaveBeenCalledTimes(1);
    resolve(false);
    expect(await Promise.all([first, second])).toEqual([false, false]);
    time = 1999;
    expect(await read()).toBe(false);
    expect(check).toHaveBeenCalledTimes(1);
    time = 2000;
    const refreshed = read();
    resolve(true);
    expect(await refreshed).toBe(true);
    expect(check).toHaveBeenCalledTimes(2);
    time = 3999;
    expect(await read()).toBe(true);
  });

  it("caches a failed probe as not ready without leaking its error", async () => {
    const read = cachedReadiness(async () => {
      throw new Error("private database detail");
    });
    expect(await read()).toBe(false);
  });
});
