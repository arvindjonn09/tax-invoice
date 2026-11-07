import { describe, expect, it } from "vitest";
import {
  MAX_EXTENSION_DAYS,
  TRIAL_DAYS,
  addDays,
  extensionLastDay,
  sydneyDate,
  sydneyMidnight,
  trialStatus,
  trialThreshold,
  trialWindow,
  validateDirectExtension,
} from "../src";

// #209: the Sydney-day trial clock (requirements glossary, S8 AC5; ADR 0004 D3).
const at = (iso: string) => new Date(iso);

describe("sydneyDate", () => {
  it("uses the Sydney calendar day, not the UTC one", () => {
    // 07:00 on 3 Nov in Sydney (AEDT, +11) is still 2 Nov in UTC.
    expect(sydneyDate(at("2026-11-02T20:00:00Z"))).toBe("2026-11-03");
    // 10:00 on 2 Nov in Sydney is 1 Nov 23:00 UTC.
    expect(sydneyDate(at("2026-11-01T23:00:00Z"))).toBe("2026-11-02");
  });

  it("changes exactly at Sydney midnight", () => {
    expect(sydneyDate(at("2026-11-02T12:59:59.999Z"))).toBe("2026-11-02");
    expect(sydneyDate(at("2026-11-02T13:00:00.000Z"))).toBe("2026-11-03");
    // In standard time (AEST, +10) midnight is 14:00 UTC.
    expect(sydneyDate(at("2026-07-14T13:59:59.999Z"))).toBe("2026-07-14");
    expect(sydneyDate(at("2026-07-14T14:00:00.000Z"))).toBe("2026-07-15");
  });

  it("holds across both daylight-saving transitions", () => {
    // DST starts Sunday 4 Oct 2026 at 02:00 AEST → 03:00 AEDT (16:00 UTC on 3 Oct).
    expect(sydneyDate(at("2026-10-03T15:59:59Z"))).toBe("2026-10-04");
    expect(sydneyDate(at("2026-10-03T16:00:00Z"))).toBe("2026-10-04");
    // DST ends Sunday 4 Apr 2027 at 03:00 AEDT → 02:00 AEST (16:00 UTC on 3 Apr):
    // 02:30 happens twice, and both are 4 April.
    expect(sydneyDate(at("2027-04-03T15:30:00Z"))).toBe("2027-04-04");
    expect(sydneyDate(at("2027-04-03T16:30:00Z"))).toBe("2027-04-04");
  });

  it("refuses an invalid instant", () => {
    expect(() => sydneyDate(new Date(Number.NaN))).toThrow(RangeError);
    expect(() => sydneyDate("2026-11-02" as unknown as Date)).toThrow(
      RangeError,
    );
  });
});

describe("sydneyMidnight", () => {
  it.each([
    ["2026-07-15", "2026-07-14T14:00:00.000Z"], // AEST
    ["2026-12-02", "2026-12-01T13:00:00.000Z"], // AEDT
    ["2026-10-04", "2026-10-03T14:00:00.000Z"], // DST starts later that night
    ["2026-10-05", "2026-10-04T13:00:00.000Z"], // first midnight on AEDT
    ["2027-04-04", "2027-04-03T13:00:00.000Z"], // DST ends later that night
    ["2027-04-05", "2027-04-04T14:00:00.000Z"], // first midnight on AEST
  ])("00:00 Sydney on %s is %s", (day, instant) => {
    const midnight = sydneyMidnight(day);
    expect(midnight.toISOString()).toBe(instant);
    expect(sydneyDate(midnight)).toBe(day);
    expect(sydneyDate(new Date(midnight.getTime() - 1))).toBe(addDays(day, -1));
  });

  it("refuses an invalid day", () => {
    expect(() => sydneyMidnight("2026-02-30")).toThrow(RangeError);
  });
});

describe("addDays", () => {
  it("moves across month, year and leap-day boundaries", () => {
    expect(addDays("2026-11-02", 29)).toBe("2026-12-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDays("2026-11-02", -2)).toBe("2026-10-31");
  });

  it("refuses an invalid day or a fractional count", () => {
    expect(() => addDays("02/11/2026", 1)).toThrow(RangeError);
    expect(() => addDays("2026-11-02", 1.5)).toThrow(RangeError);
  });
});

describe("trialWindow", () => {
  it("matches the requirements example", () => {
    // Created 2 Nov 2026 15:00 Sydney (AEDT) = 04:00 UTC.
    const window = trialWindow(at("2026-11-02T04:00:00Z"));
    expect(TRIAL_DAYS).toBe(30);
    expect(window.lastDay).toBe("2026-12-01");
    expect(window.readOnlyFrom.toISOString()).toBe("2026-12-01T13:00:00.000Z");
  });

  it("counts from the Sydney day of creation, just before and after midnight", () => {
    // 23:59:59 on 2 Nov in Sydney.
    expect(trialWindow(at("2026-11-02T12:59:59Z")).lastDay).toBe("2026-12-01");
    // 00:00 on 3 Nov in Sydney, still 2 Nov in UTC.
    expect(trialWindow(at("2026-11-02T13:00:00Z")).lastDay).toBe("2026-12-02");
  });

  it("puts read-only at Sydney midnight when the trial crosses a DST change", () => {
    // Starts in AEST, ends in AEDT: read-only from 00:00 AEDT on 20 Oct.
    const intoDaylight = trialWindow(at("2026-09-20T02:00:00Z"));
    expect(intoDaylight.lastDay).toBe("2026-10-19");
    expect(intoDaylight.readOnlyFrom.toISOString()).toBe(
      "2026-10-19T13:00:00.000Z",
    );
    // Starts in AEDT, ends in AEST: read-only from 00:00 AEST on 19 Apr.
    const intoStandard = trialWindow(at("2027-03-20T03:00:00Z"));
    expect(intoStandard.lastDay).toBe("2027-04-18");
    expect(intoStandard.readOnlyFrom.toISOString()).toBe(
      "2027-04-18T14:00:00.000Z",
    );
  });
});

describe("trialStatus", () => {
  const lastDay = "2026-12-01";
  it.each([
    ["2026-11-02T04:00:00Z", 30, "normal"], // creation day
    ["2026-11-24T04:00:00Z", 8, "normal"],
    ["2026-11-25T04:00:00Z", 7, "warning"],
    ["2026-11-30T04:00:00Z", 2, "warning"],
    ["2026-12-01T04:00:00Z", 1, "critical"],
    ["2026-12-01T12:59:59.999Z", 1, "critical"], // 23:59:59.999 on the last day
    ["2026-12-01T13:00:00.000Z", 0, "expired"], // = readOnlyFrom
    ["2027-01-15T04:00:00Z", -44, "expired"],
  ] as const)("at %s: N = %i, %s", (now, daysRemaining, phase) => {
    expect(trialStatus(lastDay, at(now))).toEqual({ daysRemaining, phase });
  });

  it("agrees with trialWindow: expired exactly from readOnlyFrom", () => {
    const { lastDay: last, readOnlyFrom } = trialWindow(
      at("2027-03-20T03:00:00Z"),
    );
    const before = new Date(readOnlyFrom.getTime() - 1);
    expect(trialStatus(last, before).phase).toBe("critical");
    expect(trialStatus(last, readOnlyFrom).phase).toBe("expired");
  });

  it("uses the Sydney day for N, not the UTC day", () => {
    // 07:00 on 1 Dec in Sydney is still 30 Nov in UTC: the last day.
    expect(trialStatus(lastDay, at("2026-11-30T20:00:00Z")).daysRemaining).toBe(
      1,
    );
  });

  it("refuses an invalid last day", () => {
    expect(() => trialStatus("2026-13-01", at("2026-11-02T04:00:00Z"))).toThrow(
      RangeError,
    );
  });
});

describe("extensionLastDay (approving a request)", () => {
  it("adds to the current last day while the trial is still running", () => {
    expect(extensionLastDay("2026-12-01", "2026-11-28", 14)).toBe("2026-12-15");
  });

  it("counts from yesterday for an expired trial, so access starts today", () => {
    // Expired on 1 Dec; approved 10 Dec for 7 days → 10–16 Dec inclusive.
    expect(extensionLastDay("2026-12-01", "2026-12-10", 7)).toBe("2026-12-16");
    // Approved the day after the last day: same either way.
    expect(extensionLastDay("2026-12-01", "2026-12-02", 7)).toBe("2026-12-08");
  });

  it("accepts 1 to 365 days only", () => {
    expect(extensionLastDay("2026-12-01", "2026-11-28", 1)).toBe("2026-12-02");
    expect(
      extensionLastDay("2026-12-01", "2026-11-28", MAX_EXTENSION_DAYS),
    ).toBe("2027-12-01");
    for (const days of [0, -1, MAX_EXTENSION_DAYS + 1, 2.5])
      expect(() => extensionLastDay("2026-12-01", "2026-11-28", days)).toThrow(
        RangeError,
      );
  });

  it("refuses invalid days", () => {
    expect(() => extensionLastDay("bad", "2026-11-28", 7)).toThrow(RangeError);
    expect(() => extensionLastDay("2026-12-01", "bad", 7)).toThrow(RangeError);
  });
});

describe("validateDirectExtension", () => {
  it("accepts a later day from today up to 365 days ahead", () => {
    expect(
      validateDirectExtension("2026-12-01", "2026-12-20", "2026-11-28"),
    ).toEqual({ ok: true });
    // Expired trial: today itself is a valid new last day.
    expect(
      validateDirectExtension("2026-12-01", "2026-12-10", "2026-12-10"),
    ).toEqual({ ok: true });
    expect(
      validateDirectExtension("2026-12-01", "2027-11-28", "2026-11-28"),
    ).toEqual({ ok: true });
  });

  it("refuses shortening or keeping the same day", () => {
    for (const day of ["2026-12-01", "2026-11-30"])
      expect(validateDirectExtension("2026-12-01", day, "2026-11-28")).toEqual({
        ok: false,
        reason: "not_later",
      });
  });

  it("refuses a day before today", () => {
    expect(
      validateDirectExtension("2026-12-01", "2026-12-05", "2026-12-10"),
    ).toEqual({ ok: false, reason: "before_today" });
  });

  it("refuses more than 365 days from today", () => {
    expect(
      validateDirectExtension("2026-12-01", "2027-11-29", "2026-11-28"),
    ).toEqual({ ok: false, reason: "too_far" });
  });

  it("refuses invalid days", () => {
    expect(() =>
      validateDirectExtension("bad", "2026-12-20", "2026-11-28"),
    ).toThrow(RangeError);
    expect(() =>
      validateDirectExtension("2026-12-01", "bad", "2026-11-28"),
    ).toThrow(RangeError);
    expect(() =>
      validateDirectExtension("2026-12-01", "2026-12-20", "bad"),
    ).toThrow(RangeError);
  });
});

describe("trialThreshold (S10)", () => {
  it.each([
    [30, null],
    [8, null],
    [7, "d7"],
    [4, "d7"],
    [3, "d3"],
    [2, "d3"],
    [1, "d1"],
    [0, "ended"],
    [-40, "ended"],
  ])("with %i days left it's %s", (days, threshold) => {
    expect(trialThreshold(days)).toBe(threshold);
  });
});
