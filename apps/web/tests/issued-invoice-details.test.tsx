import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { IssuedDetails } from "@/features/invoices/issued";

// #306: the issued screen shows the PO number and due date, like the PDF.
describe("issued invoice details (#306)", () => {
  it("shows the customer reference / PO number and the due date", () => {
    const html = renderToStaticMarkup(
      <IssuedDetails
        invoice={{
          issueDate: "2026-07-15",
          dueOn: "2026-08-14",
          customerReference: "PO-7781",
        }}
      />,
    );
    expect(html).toContain("Customer reference / PO number");
    expect(html).toContain("PO-7781");
    expect(html).toContain("Due date");
    expect(html).toContain("Issue date");
  });

  it("leaves out rows that have nothing to show", () => {
    const html = renderToStaticMarkup(
      <IssuedDetails
        invoice={{
          issueDate: "2026-07-15",
          dueOn: null,
          customerReference: null,
        }}
      />,
    );
    expect(html).toContain("Issue date");
    expect(html).not.toContain("Due date");
    expect(html).not.toContain("PO number");
    expect(
      renderToStaticMarkup(
        <IssuedDetails
          invoice={{ issueDate: null, dueOn: null, customerReference: null }}
        />,
      ),
    ).toBe("");
  });
});
