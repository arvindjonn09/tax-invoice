import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AppShell } from "@/components/shell/app-shell";
import { TrialBanner } from "@/components/shell/banners";

const render = (demoPresent: boolean, preview = false) =>
  renderToStaticMarkup(
    <AppShell
      companyName="Sample Company A"
      roleLabel="Owner"
      navigation={[]}
      demoPresent={demoPresent}
      preview={preview}
    >
      <p>content</p>
    </AppShell>,
  );

describe("AppShell banners", () => {
  it("shows the Demo Data banner whenever demo data is present", () => {
    const html = render(true);
    expect(html).toContain('aria-label="Demo Data"');
    expect(html).toContain("Synthetic demonstration records are present.");
  });

  it("has no Demo Data banner once demo data is gone", () => {
    expect(render(false)).not.toContain("Demo Data");
  });

  it("keeps the design-preview banner separate from Demo Data", () => {
    const html = render(false, true);
    expect(html).toContain("Design preview — not real data");
    expect(html).not.toContain('aria-label="Demo Data"');
  });

  it("renders one main landmark after a skip link", () => {
    const html = render(true);
    expect(html.match(/<main/g)).toHaveLength(1);
    expect(html.indexOf("Skip to main content")).toBeLessThan(
      html.indexOf("<main"),
    );
  });
});

describe("TrialBanner (S8, docs/design/signup-trial.md)", () => {
  const banner = (
    phase: "normal" | "warning" | "critical" | "expired",
    daysRemaining: number,
    viewer: "owner" | "staff" | "worker",
  ) =>
    renderToStaticMarkup(
      <TrialBanner
        status={{ phase, daysRemaining }}
        lastDay="2026-12-01"
        viewer={viewer}
        supportEmail="support@example.test"
      />,
    );
  const indicator = (html: string) =>
    /<div role="status" aria-label="Trial status"[^>]*>.*?<strong>(.*?)<\/strong>/.exec(
      html,
    )?.[1];

  it("uses the exact S8 AC1 copy for each phase", () => {
    expect(indicator(banner("normal", 12, "owner"))).toBe("12 days remaining");
    expect(indicator(banner("warning", 5, "owner"))).toBe(
      "5 days remaining · Trial expires on 1 Dec 2026",
    );
    expect(indicator(banner("critical", 1, "owner"))).toBe(
      "Last day of your trial · Read-only from 12:00 am tomorrow (Sydney time)",
    );
    expect(indicator(banner("expired", -2, "owner"))).toBe(
      "Trial ended 1 Dec 2026 · Read-only",
    );
  });

  it("is a status landmark whose text, not colour, carries the state", () => {
    for (const phase of ["normal", "warning", "critical", "expired"] as const) {
      const html = banner(phase, phase === "normal" ? 12 : 2, "staff");
      expect(html).toContain('role="status"');
      expect(indicator(html)).toBeTruthy();
    }
  });

  it("shows the support email in warning, critical and expired, not normal", () => {
    expect(banner("normal", 12, "owner")).not.toContain("support@example.test");
    for (const [phase, days] of [
      ["warning", 5],
      ["critical", 1],
      ["expired", -1],
    ] as const)
      expect(banner(phase, days, "owner")).toContain("support@example.test");
  });

  it("offers Request extension to owners only, and never in the normal phase", () => {
    // Email until #232's /settings/trial exists.
    expect(banner("warning", 5, "owner")).toContain(
      "mailto:support@example.test?subject=Trial%20extension%20request",
    );
    expect(banner("warning", 5, "owner")).not.toContain("/settings/trial");
    expect(banner("expired", -1, "owner")).toContain("Request extension");
    expect(banner("normal", 12, "owner")).not.toContain("Request extension");
    expect(banner("warning", 5, "staff")).not.toContain("Request extension");
    expect(banner("expired", -1, "staff")).not.toContain("Request extension");
  });

  it("lets only the warning banner be dismissed", () => {
    expect(banner("warning", 5, "owner")).toContain(">Dismiss</button>");
    expect(banner("critical", 1, "owner")).not.toContain("Dismiss");
    expect(banner("expired", -1, "owner")).not.toContain("Dismiss");
  });

  it("shows workers no countdown, dates or support address, only the read-only notice", () => {
    for (const [phase, days] of [
      ["normal", 12],
      ["warning", 5],
      ["critical", 1],
    ] as const)
      expect(banner(phase, days, "worker")).toBe("");
    const ended = banner("expired", -3, "worker");
    expect(ended).toContain(
      "This company&#x27;s account is read-only. Contact your owner.",
    );
    expect(ended).not.toContain("2026");
    expect(ended).not.toContain("support@example.test");
    expect(ended).not.toContain('role="status"');
  });

  it("pluralises days in the countdown", () => {
    expect(banner("warning", 2, "owner")).toContain("2 days remaining");
  });
});
