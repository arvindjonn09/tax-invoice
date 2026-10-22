import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MoneyDisplay, formatAudCents } from "../src/components/money-display";
import { StatusPill, type Status } from "../src/components/status-pill";
import { Button } from "../src/components/ui/button";
describe("integer-cent presentation", () => {
  it.each([
    [0, "$0.00"],
    [1, "$0.01"],
    [99, "$0.99"],
    [100, "$1.00"],
    [250000, "$2,500.00"],
    [-1500, "−$15.00"],
    [9007199254740991n, "$90,071,992,547,409.91"],
    [99999999999999999999999n, "$999,999,999,999,999,999,999.99"],
  ] as const)("formats %s without floating point", (cents, output) => {
    expect(formatAudCents(cents)).toBe(output);
  });
  it.each([0.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid number %s",
    (cents) => {
      expect(() => formatAudCents(cents)).toThrow(RangeError);
    },
  );
  it.each(["ex GST", "incl GST"] as const)(
    "shows currency and %s basis",
    (basis) => {
      const html = renderToStaticMarkup(
        createElement(MoneyDisplay, { cents: 250000, basis }),
      );
      expect(html).toContain("$2,500.00 AUD");
      expect(html).toContain(basis);
      expect(html).toContain('class="money"');
    },
  );
  it("distinguishes unavailable from zero", () => {
    const html = renderToStaticMarkup(
      createElement(MoneyDisplay, { unavailable: true, basis: "ex GST" }),
    );
    expect(html).toContain("Unavailable");
    expect(html).not.toContain("$0.00");
  });
});
describe("status and button semantics", () => {
  it.each([
    "draft",
    "active",
    "completed",
    "paid",
    "pending",
    "overdue",
    "void",
  ] as Status[])("gives %s a written label plus decorative icon", (status) => {
    const html = renderToStaticMarkup(createElement(StatusPill, { status }));
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain(status[0]?.toUpperCase() + status.slice(1));
    expect(html).not.toContain("button");
  });
  it("supports a contextual label", () => {
    expect(
      renderToStaticMarkup(
        createElement(StatusPill, {
          status: "pending",
          label: "Awaiting review",
        }),
      ),
    ).toContain("Awaiting review");
  });
  it("preserves native disabled semantics", () => {
    const html = renderToStaticMarkup(
      createElement(Button, { disabled: true }, "Save sample"),
    );
    expect(html).toContain('disabled=""');
    expect(html).toContain("Save sample");
  });
});
