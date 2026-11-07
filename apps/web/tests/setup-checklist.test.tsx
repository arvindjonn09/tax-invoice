import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SetupChecklist } from "../src/components/onboarding/setup-checklist";
import { visibleSetupChecklist } from "../src/server/company/setup-checklist";

// #225 (S5 AC8, design §10): the owner's "Finish setting up your company".
const blank = {
  addressLine1: null,
  suburb: null,
  state: null,
  postcode: null,
  phone: null,
  businessEmail: null,
  website: null,
  about: null,
  logoDocumentId: null,
  setupChecklistDismissedAt: null,
};
const address = {
  addressLine1: "1 Example Street",
  suburb: "Sampleton",
  state: "NSW",
  postcode: "2000",
  phone: "02 5550 0100",
  about: "Synthetic about text",
  logoDocumentId: "00000000-0000-4000-8000-000000000001",
};
const open = { readOnly: false };

describe("visibleSetupChecklist", () => {
  it("lists the missing address for an owner", () => {
    expect(visibleSetupChecklist({ role: "owner" }, open, blank)).toEqual([
      {
        id: "business_details",
        label: "Business address",
        done: false,
        href: "/settings",
      },
      {
        id: "contact_details",
        label: "Contact details",
        done: false,
        href: "/settings",
      },
      { id: "logo", label: "Logo", done: false, href: "/settings" },
      {
        id: "about",
        label: "About your business",
        done: false,
        href: "/settings",
      },
    ]);
  });

  it("counts a partial address as to do", () => {
    const partial = { ...blank, ...address, postcode: null };
    expect(
      visibleSetupChecklist({ role: "owner" }, open, partial)?.[0]?.done,
    ).toBe(false);
  });

  it("is hidden once complete, dismissed, read-only or not the owner", () => {
    expect(
      visibleSetupChecklist({ role: "owner" }, open, { ...blank, ...address }),
    ).toBeNull();
    expect(
      visibleSetupChecklist({ role: "owner" }, open, {
        ...blank,
        setupChecklistDismissedAt: new Date(),
      }),
    ).toBeNull();
    expect(
      visibleSetupChecklist({ role: "owner" }, { readOnly: true }, blank),
    ).toBeNull();
    for (const role of [
      "manager",
      "accountant",
      "employee",
      "subcontractor",
    ] as const)
      expect(visibleSetupChecklist({ role }, open, blank)).toBeNull();
  });
});

describe("SetupChecklist", () => {
  it("states each item's progress in text and links what's left", () => {
    const html = renderToStaticMarkup(
      <SetupChecklist
        items={[
          {
            id: "a",
            label: "Business address",
            done: false,
            href: "/settings",
          },
          { id: "b", label: "Logo", done: true, href: "/settings" },
        ]}
      />,
    );
    expect(html).toContain("Finish setting up your company");
    expect(html).toContain('aria-labelledby="setup-checklist-heading"');
    expect(html).toContain("To do");
    expect(html).toContain("Done");
    expect(html).toContain('href="/settings"');
    expect(html).toContain("Dismiss");
    // Only the item still to do has an "Add" link.
    expect(html.match(/>Add</g)).toHaveLength(1);
  });
});
