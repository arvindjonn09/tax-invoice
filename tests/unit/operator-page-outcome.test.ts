import { describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({ headers: vi.fn() }));
vi.mock("next/navigation", () => ({ notFound: vi.fn(), redirect: vi.fn() }));

const { operatorPageOutcome } =
  await import("../../apps/web/src/server/operator/index");

// #232 (ADR 0004 D5, design §13e): what an operator page does in production.
describe("operatorPageOutcome", () => {
  it("lets a full operator through", () => {
    expect(
      operatorPageOutcome({
        strict: true,
        relaxed: true,
        twoFactorEnabled: true,
      }),
    ).toBe("ok");
  });

  it("sends an operator with an old or missing code back to sign in", () => {
    expect(
      operatorPageOutcome({
        strict: false,
        relaxed: true,
        twoFactorEnabled: true,
      }),
    ).toBe("reauth");
  });

  it("sends an unenrolled operator to /operator/mfa", () => {
    expect(
      operatorPageOutcome({
        strict: false,
        relaxed: true,
        twoFactorEnabled: false,
      }),
    ).toBe("enrol");
  });

  it("gives everyone else the 404, TOTP or not", () => {
    for (const twoFactorEnabled of [true, false])
      expect(
        operatorPageOutcome({
          strict: false,
          relaxed: false,
          twoFactorEnabled,
        }),
      ).toBe("not-found");
  });
});
