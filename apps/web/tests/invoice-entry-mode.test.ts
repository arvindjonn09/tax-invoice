import { describe, expect, it } from "vitest";
import { convertEntryMode } from "../src/features/invoices/entry-mode";

// #146 review: switching GST entry mode keeps the commercial amount.
const line = (
  price: string,
  taxCode = "TAXABLE_10" as const,
  quantity = "1",
) => ({
  key: price,
  quantity,
  price,
  taxCode,
});

describe("price entry mode switch", () => {
  it("converts Taxable prices both ways without changing the total", () => {
    const toIncl = convertEntryMode(
      [line("100.00")],
      "exclusive",
      "inclusive",
      true,
    );
    expect(toIncl.lines[0]!.price).toBe("110.00");
    expect(toIncl.changed).toEqual([]);
    const back = convertEntryMode(toIncl.lines, "inclusive", "exclusive", true);
    expect(back.lines[0]!.price).toBe("100.00");
  });

  it("leaves non-Taxable, blank and unregistered prices alone", () => {
    const lines = [line("50.00", "GST_FREE" as never), line(""), line("abc")];
    expect(
      convertEntryMode(lines, "exclusive", "inclusive", true).lines,
    ).toEqual(lines);
    expect(
      convertEntryMode([line("100.00")], "exclusive", "inclusive", false)
        .lines[0]!.price,
    ).toBe("100.00");
    expect(
      convertEntryMode(lines, "exclusive", "exclusive", true).changed,
    ).toEqual([]);
  });

  it("reports a line whose total moves by rounding", () => {
    // 7 × $0.15 incl GST = $1.05. Ex unit $0.14 → 7 × $0.14 = $0.98 + $0.10 GST = $1.08.
    const result = convertEntryMode(
      [line("0.15", "TAXABLE_10", "7")],
      "inclusive",
      "exclusive",
      true,
    );
    expect(result.changed).toHaveLength(1);
    expect(result.changed[0]!.before).toBe(105n);
    expect(result.changed[0]!.after).toBe(108n);
  });

  it("skips the rounding check when a quantity can't be priced", () => {
    const result = convertEntryMode(
      [line("10.00", "TAXABLE_10", "x")],
      "exclusive",
      "inclusive",
      true,
    );
    expect(result.lines[0]!.price).toBe("11.00");
    expect(result.changed).toEqual([]);
  });
});
