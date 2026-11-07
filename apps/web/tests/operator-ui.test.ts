import { describe, expect, it } from "vitest";
import { ENROLMENT_CODE_HEADER } from "../src/server/operator/access";
import {
  ENROLMENT_HEADER,
  secretFrom,
} from "../src/app/operator/mfa/enrolment";
import { cleanCode, verifyProblem } from "../src/app/login/two-factor-step";
import { operatorOutcome } from "../src/components/operator/format";
import { pageFrom } from "../src/components/operator/pager";

// #232 (design §13d, §13e): the operator's enrolment and code step.
const APP = "https://jobflow.example.test";

describe("operator UI helpers", () => {
  it("sends the header the server reads", () => {
    expect(ENROLMENT_HEADER).toBe(ENROLMENT_CODE_HEADER);
  });

  it("shows the key from the otpauth URI in groups of four", () => {
    expect(
      secretFrom(
        "otpauth://totp/JobFlow:a%40b?secret=ABCDEFGHIJKLMNOP&issuer=JobFlow",
      ),
    ).toBe("ABCD EFGH IJKL MNOP");
  });

  it("strips spaces and dashes before holding a code to 6 digits", () => {
    expect(cleanCode("123 456")).toBe("123456");
    expect(cleanCode("123-456")).toBe("123456");
  });

  it("tells a wrong code from a timed-out step and Cloudflare Access", () => {
    expect(verifyProblem(401, { code: "INVALID_CODE" }, APP)).toMatchObject({
      message: expect.stringContaining("That code didn't work"),
      clear: true,
    });
    expect(
      verifyProblem(401, { code: "INVALID_BACKUP_CODE" }, APP).message,
    ).toBe("That backup code didn't work. Each code works once.");
    expect(
      verifyProblem(401, { code: "INVALID_TWO_FACTOR_COOKIE" }, APP),
    ).toEqual({
      message: "Your sign-in timed out. Sign in again.",
      restart: true,
    });
    // An Access page (not JSON) or a bare 403 from the proxy.
    for (const [status, json] of [
      [200, null],
      [403, {}],
    ] as const)
      expect(verifyProblem(status, json, APP).message).toBe(
        `Your operator sign-in needs Cloudflare Access first. Open ${APP}/operator to sign in to Access, then sign in here again.`,
      );
    // JobFlow's own 401 (#323) says why and returns to the password form.
    expect(
      verifyProblem(
        401,
        { message: "Your session ended. Sign in again to continue." },
        APP,
      ),
    ).toEqual({
      message: "Your session ended. Sign in again to continue.",
      restart: true,
    });
    expect(verifyProblem(429, {}, APP).message).toMatch(/Too many attempts/);
  });

  it("describes each decided outcome without the approval note", () => {
    const base = {
      newLastDay: "2026-12-15",
      decisionNote: "private",
      closedReason: null,
    };
    expect(operatorOutcome({ ...base, status: "approved" })).toBe(
      "Extended to 15 Dec 2026",
    );
    expect(
      operatorOutcome({ ...base, status: "declined", decisionNote: "No" }),
    ).toBe("Declined: No");
    expect(
      operatorOutcome({
        ...base,
        status: "closed",
        closedReason: "made_unrestricted",
      }),
    ).toBe("Closed: made unrestricted");
  });

  it("throttles with the server's wait and keeps the code on a 5xx", () => {
    expect(verifyProblem(429, {}, APP, 150)).toEqual({
      message: "Too many attempts. You can try again in 3 minutes.",
      waitSeconds: 150,
    });
    expect(verifyProblem(429, {}, APP).waitSeconds).toBe(60);
    expect(verifyProblem(500, { message: "x" }, APP)).toEqual({
      message: "Something went wrong. Try again.",
    });
  });

  it("reads ?page= safely", () => {
    expect(pageFrom(undefined)).toBe(1);
    expect(pageFrom("3")).toBe(3);
    expect(pageFrom(["2", "9"])).toBe(2);
    for (const bad of ["0", "-1", "1.5", "abc", "100000"])
      expect(pageFrom(bad)).toBe(1);
  });
});
