import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  JOB_STATUSES,
  nextStatuses,
  transitionProblem,
  type JobStatus,
} from "@jobflow/domain";
import { StatusForm } from "@/features/jobs/actions";

// #301: after a status change the form must not pre-select a backward step
// or Cancelled, so pressing Update can never move a job back by accident.
const render = (status: JobStatus) =>
  renderToStaticMarkup(
    <StatusForm
      job={{
        id: "job-1",
        reference: "JOB-0001",
        title: "Synthetic",
        status,
        dueOn: null,
      }}
      saved={() => {}}
    />,
  );

/** The pre-selected option's value ("" for the placeholder), or null. */
const selected = (html: string) =>
  /<option value="([^"]*)"[^>]*selected=""/.exec(html)?.[1] ?? null;

describe("job status form default (#301)", () => {
  const withOptions = JOB_STATUSES.filter((status) =>
    nextStatuses(status).some((to) => transitionProblem(status, to) === null),
  );

  it("covers every status that has options", () => {
    expect(withOptions).toEqual([
      "draft",
      "quoted",
      "approved",
      "assigned",
      "in_progress",
      "awaiting_review",
      "completed",
      "invoiced",
    ]);
  });

  it.each(withOptions)(
    "%s: never pre-selects a backward or Cancelled status",
    (status) => {
      const value = selected(render(status));
      expect(value, status).not.toBeNull();
      if (value === "") return;
      expect(value).not.toBe("cancelled");
      expect(JOB_STATUSES.indexOf(value as JobStatus)).toBeGreaterThan(
        JOB_STATUSES.indexOf(status),
      );
    },
  );

  it("pre-selects the usual next step, or asks the person to choose", () => {
    expect(
      Object.fromEntries(withOptions.map((s) => [s, selected(render(s))])),
    ).toEqual({
      draft: "quoted",
      quoted: "approved",
      approved: "assigned",
      assigned: "in_progress",
      in_progress: "awaiting_review",
      awaiting_review: "",
      completed: "",
      invoiced: "closed",
    });
    const html = render("assigned");
    // The reported bug: Approved was pre-selected after Assigned.
    expect(html).not.toMatch(/<option value="approved"[^>]*selected=""/);
    expect(render("completed")).toMatch(
      /<select[^>]*required=""[^>]*>[\s\S]*<option value="" disabled="" selected="">Choose a status<\/option>/,
    );
  });

  it("still says a final status is final", () => {
    for (const status of ["closed", "cancelled"] as const)
      expect(render(status)).toContain("This job status is final.");
  });
});
