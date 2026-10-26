import { describe, expect, it } from "vitest";
import {
  type CsvColumn,
  csvStream,
  neutralise,
  toCsv,
} from "../../apps/web/src/server/exports/csv";

// CSV exports (#56, #70): authoritative ASCII cents and formula-safe text.
type Row = { name: string; cents: bigint | null; day: string; n: number };
const columns: CsvColumn<Row>[] = [
  { name: "name", type: "text", value: (r) => r.name },
  { name: "amount_cents", type: "cents", value: (r) => r.cents },
  { name: "date", type: "date", value: (r) => r.day },
  { name: "count", type: "integer", value: (r) => r.n },
];
const row = (over: Partial<Row>): Row => ({
  name: "Synthetic",
  cents: 0n,
  day: "2026-07-01",
  n: 1,
  ...over,
});

describe("CSV exports", () => {
  it("writes money as signed ASCII integer cents, whatever the size", () => {
    const text = toCsv(columns, [
      row({ cents: -1500n }),
      row({ cents: 0n }),
      row({ cents: 900719925474099312345n }),
      row({ cents: -900719925474099312345n }),
      row({ cents: null }),
    ]);
    expect(text).toBe(
      [
        "name,amount_cents,date,count",
        '"Synthetic",-1500,2026-07-01,1',
        '"Synthetic",0,2026-07-01,1',
        '"Synthetic",900719925474099312345,2026-07-01,1',
        '"Synthetic",-900719925474099312345,2026-07-01,1',
        '"Synthetic",,2026-07-01,1',
        "",
      ].join("\r\n"),
    );
    expect(text).not.toMatch(/[−$]|AUD|GST/);
    for (const line of text.trim().split("\r\n").slice(1))
      expect(line.split(",")[1]).toMatch(/^(-?\d+)?$/);
  });

  it("refuses display text or floats in typed columns", () => {
    for (const bad of ["−$15.00", "-15.00", 15, 1.5])
      expect(() =>
        toCsv(columns, [row({ cents: bad as unknown as bigint })]),
      ).toThrow(TypeError);
    expect(() => toCsv(columns, [row({ n: 1.5 })])).toThrow(TypeError);
    expect(() => toCsv(columns, [row({ day: "1/7/2026" })])).toThrow(TypeError);
  });

  it("quotes text and neutralises formula-leading cells", () => {
    for (const formula of [
      "=1+1",
      "+61 400 000 000",
      "-2",
      "@SUM(A1)",
      " =cmd",
      "\t=cmd",
      "\r=cmd",
      "\u0000=cmd",
      "\tplain",
      "＝1",
    ])
      expect(neutralise(formula)).toBe(`'${formula}`);
    for (const safe of ["Synthetic Pty Ltd", "a=b", "100", ""])
      expect(neutralise(safe)).toBe(safe);
    expect(
      toCsv(columns, [row({ name: 'Say "hi", =now\r\nnext' })]).split(
        "\r\n",
      )[1],
    ).toBe('"Say ""hi"", =now');
    expect(toCsv(columns, [row({ name: '=HYPERLINK("x")' })])).toContain(
      '"\'=HYPERLINK(""x"")"',
    );
  });

  it("streams the same text in chunks", async () => {
    const rows = Array.from({ length: 1234 }, (_, i) =>
      row({ cents: BigInt(i - 600), n: i }),
    );
    const streamed = await new Response(csvStream(columns, rows, 100)).text();
    expect(streamed).toBe(toCsv(columns, rows));
    expect(await new Response(csvStream(columns, [])).text()).toBe(
      "name,amount_cents,date,count\r\n",
    );
  });
});
