import { describe, expect, it } from "vitest";
import {
  JOB_STATUSES,
  formatJobReference,
  isJobEditable,
  isJobStatus,
  nextStatuses,
  transitionProblem,
} from "../src/index";

describe("job status machine", () => {
  it("follows the happy path draft → closed", () => {
    const path = [
      "draft",
      "quoted",
      "approved",
      "assigned",
      "in_progress",
      "awaiting_review",
      "completed",
    ] as const;
    for (let i = 1; i < path.length; i += 1) {
      expect(transitionProblem(path[i - 1]!, path[i]!), path[i]).toBeNull();
    }
    expect(transitionProblem("completed", "closed")).toBeNull();
    expect(
      transitionProblem("completed", "invoiced", { bySystem: true }),
    ).toBeNull();
    expect(transitionProblem("invoiced", "closed")).toBeNull();
  });

  it("allows real backward moves only", () => {
    expect(transitionProblem("quoted", "draft")).toBeNull();
    expect(transitionProblem("assigned", "approved")).toBeNull();
    expect(transitionProblem("awaiting_review", "in_progress")).toBeNull();
    expect(transitionProblem("completed", "in_progress")).toBe("not-allowed");
    expect(transitionProblem("approved", "quoted")).toBe("not-allowed");
  });

  it("rejects illegal jumps, same-status moves and anything out of final states", () => {
    expect(transitionProblem("draft", "completed")).toBe("not-allowed");
    expect(transitionProblem("draft", "in_progress")).toBe("not-allowed");
    expect(transitionProblem("in_progress", "closed")).toBe("not-allowed");
    expect(transitionProblem("draft", "draft")).toBe("same-status");
    for (const to of JOB_STATUSES) {
      if (to !== "closed")
        expect(transitionProblem("closed", to), to).toBe("not-allowed");
      if (to !== "cancelled")
        expect(transitionProblem("cancelled", to), to).toBe("not-allowed");
    }
    expect(nextStatuses("closed")).toEqual([]);
  });

  it("lets every open status be cancelled, but not completed/invoiced work", () => {
    for (const from of [
      "draft",
      "quoted",
      "approved",
      "assigned",
      "in_progress",
      "awaiting_review",
    ] as const)
      expect(transitionProblem(from, "cancelled"), from).toBeNull();
    expect(transitionProblem("completed", "cancelled")).toBe("not-allowed");
    expect(transitionProblem("invoiced", "cancelled")).toBe("not-allowed");
  });

  it("keeps 'invoiced' for the system (invoice issue)", () => {
    expect(transitionProblem("completed", "invoiced")).toBe("system-only");
  });

  it("knows statuses, editability and reference format", () => {
    expect(isJobStatus("in_progress")).toBe(true);
    expect(isJobStatus("done")).toBe(false);
    expect(isJobEditable("in_progress")).toBe(true);
    for (const status of ["invoiced", "closed", "cancelled"] as const)
      expect(isJobEditable(status)).toBe(false);
    expect(formatJobReference("JOB-", 7)).toBe("JOB-0007");
    expect(formatJobReference("J", 123456)).toBe("J123456");
  });
});
