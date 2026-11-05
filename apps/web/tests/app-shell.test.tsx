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

describe("TrialBanner (S8)", () => {
  const banner = (
    phase: "normal" | "warning" | "critical" | "expired",
    daysRemaining: number,
    showCountdown: boolean,
  ) =>
    renderToStaticMarkup(
      <TrialBanner
        status={{ phase, daysRemaining }}
        lastDay="2026-12-02"
        showCountdown={showCountdown}
        supportEmail="support@example.test"
      />,
    );

  it("shows owners the countdown, end date and, once urgent, how to continue", () => {
    expect(banner("normal", 30, true)).toContain("30 days left");
    expect(banner("normal", 30, true)).toContain("2 December 2026");
    expect(banner("warning", 5, true)).toContain("support@example.test");
    expect(banner("critical", 1, true)).toContain("Last day");
    expect(banner("expired", -3, true)).toContain("2 December 2026");
  });

  it("hides trial dates and contacts from employees and subcontractors", () => {
    expect(banner("normal", 30, false)).toBe("");
    expect(banner("critical", 1, false)).toBe("");
    const ended = banner("expired", -3, false);
    expect(ended).toContain("free trial has ended");
    expect(ended).not.toContain("2026");
    expect(ended).not.toContain("support@example.test");
  });
});
