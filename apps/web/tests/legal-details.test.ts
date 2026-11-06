import { describe, expect, it } from "vitest";
import {
  legalDetails,
  legalDetailsMissing,
} from "../src/content/legal/details";

describe("legal details (#212)", () => {
  it("shows a visible gap until the business is named", () => {
    expect(legalDetails({}).abn).toBe("[ABN]");
    expect(legalDetailsMissing({})).toBe(true);
    expect(legalDetailsMissing({ LEGAL_BUSINESS_NAME: "Sample" })).toBe(true);
    expect(legalDetailsMissing({ LEGAL_ABN: " " })).toBe(true);
  });
  it("uses the name and ABN from the environment", () => {
    const env = {
      LEGAL_BUSINESS_NAME: " Sample Pty Ltd ",
      LEGAL_ABN: "00 000",
    };
    expect(legalDetails(env)).toMatchObject({
      legalName: "Sample Pty Ltd",
      abn: "00 000",
      state: "New South Wales",
      hostingLocation: "Australia",
    });
    expect(legalDetailsMissing(env)).toBe(false);
  });
});
