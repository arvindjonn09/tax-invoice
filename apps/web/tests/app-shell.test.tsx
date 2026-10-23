import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AppShell } from "@/components/shell/app-shell";

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
