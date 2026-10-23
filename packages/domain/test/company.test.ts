import { describe, expect, it } from "vitest";
import {
  type GstRegistrationPeriod,
  formatAbn,
  gstStatusOn,
  isIsoDate,
  isValidAbn,
  normaliseAbn,
  periodsOverlap,
  registrationProblem,
} from "../src/index";
import { syntheticAbn } from "../../../tests/helpers/abn";

describe("ABN", () => {
  const valid = syntheticAbn("000000001");

  it("accepts checksum-valid ABNs with or without spaces", () => {
    expect(isValidAbn(valid)).toBe(true);
    expect(isValidAbn(formatAbn(valid))).toBe(true);
    expect(isValidAbn(` ${formatAbn(valid)} `)).toBe(true);
    for (const body of ["123456789", "987654321", "555000111"])
      expect(isValidAbn(syntheticAbn(body))).toBe(true);
  });

  it("rejects a wrong checksum, any single changed digit and swapped digits", () => {
    for (let index = 0; index < 11; index += 1) {
      const digit = Number(valid[index]);
      const changed = `${valid.slice(0, index)}${(digit + 1) % 10}${valid.slice(index + 1)}`;
      expect(isValidAbn(changed), changed).toBe(false);
    }
    const swapped = `${valid[1]}${valid[0]}${valid.slice(2)}`;
    if (swapped !== valid) expect(isValidAbn(swapped)).toBe(false);
  });

  it("rejects wrong lengths, letters, punctuation and a leading zero", () => {
    for (const bad of [
      "",
      "1234567890",
      "123456789012",
      `${valid.slice(0, 10)}A`,
      `${valid.slice(0, 2)}-${valid.slice(2)}`,
      `0${valid.slice(1)}`,
    ])
      expect(isValidAbn(bad), bad).toBe(false);
    expect(normaliseAbn("12 345 678 9X1")).toBeNull();
    expect(normaliseAbn(" 12 345 678 901 ")).toBe("12345678901");
  });

  it("formats as NN NNN NNN NNN", () => {
    expect(formatAbn("12345678901")).toBe("12 345 678 901");
  });
});

describe("GST registration on a date", () => {
  const periods: GstRegistrationPeriod[] = [
    { startsOn: "2025-07-01", endsOn: "2026-06-30", basis: "cash" },
    { startsOn: "2026-07-01", endsOn: null, basis: "non_cash" },
  ];

  it("answers registered/basis on boundary days", () => {
    expect(gstStatusOn(periods, "2025-06-30")).toEqual({
      registered: false,
      basis: null,
    });
    expect(gstStatusOn(periods, "2025-07-01")).toEqual({
      registered: true,
      basis: "cash",
    });
    expect(gstStatusOn(periods, "2026-06-30").basis).toBe("cash");
    expect(gstStatusOn(periods, "2026-07-01").basis).toBe("non_cash");
    expect(gstStatusOn(periods, "2099-12-31").basis).toBe("non_cash");
  });

  it("is not registered in a gap or with no periods", () => {
    const gap: GstRegistrationPeriod[] = [
      { startsOn: "2025-07-01", endsOn: "2025-12-31", basis: "cash" },
      { startsOn: "2026-02-01", endsOn: null, basis: "cash" },
    ];
    expect(gstStatusOn(gap, "2026-01-15").registered).toBe(false);
    expect(gstStatusOn(gap, "2026-01-31").registered).toBe(false);
    expect(gstStatusOn(gap, "2026-02-01").registered).toBe(true);
    expect(gstStatusOn([], "2026-01-01").registered).toBe(false);
  });

  it("rejects invalid dates", () => {
    expect(() => gstStatusOn(periods, "2026-02-30")).toThrow(RangeError);
    expect(isIsoDate("2024-02-29")).toBe(true);
    expect(isIsoDate("2025-02-29")).toBe(false);
    expect(isIsoDate("2026-7-1")).toBe(false);
  });
});

describe("registration periods", () => {
  const open: GstRegistrationPeriod = {
    startsOn: "2026-07-01",
    endsOn: null,
    basis: "cash",
  };
  const closed: GstRegistrationPeriod = {
    startsOn: "2025-07-01",
    endsOn: "2026-06-30",
    basis: "cash",
  };

  it("treats inclusive end days as overlapping, the next day as not", () => {
    expect(periodsOverlap(closed, open)).toBe(false);
    expect(periodsOverlap(closed, { ...open, startsOn: "2026-06-30" })).toBe(
      true,
    );
    expect(periodsOverlap(open, { ...open, startsOn: "2030-01-01" })).toBe(
      true,
    );
    expect(
      periodsOverlap(
        { startsOn: "2020-01-01", endsOn: "2020-12-31", basis: "cash" },
        closed,
      ),
    ).toBe(false);
  });

  it("explains why a period cannot be added", () => {
    expect(registrationProblem(open, [closed])).toBeNull();
    expect(
      registrationProblem({ ...open, startsOn: "2026-06-30" }, [closed]),
    ).toBe("overlap");
    expect(
      registrationProblem(
        { startsOn: "2026-07-02", endsOn: "2026-07-01", basis: "cash" },
        [],
      ),
    ).toBe("ends-before-start");
    expect(
      registrationProblem(
        { startsOn: "2026-07-01", endsOn: "2026-07-01", basis: "cash" },
        [],
      ),
    ).toBeNull();
    expect(registrationProblem({ ...open, startsOn: "2026-13-01" }, [])).toBe(
      "invalid-date",
    );
    expect(registrationProblem({ ...open, endsOn: "nope" }, [])).toBe(
      "invalid-date",
    );
  });
});
