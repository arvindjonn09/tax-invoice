import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  JOB_STATUSES,
  NO_EVIDENCE,
  showsNoWorkerEvidence,
  type JobStatus,
} from "@jobflow/domain";
import { ReviewForm, StatusForm } from "@/features/jobs/actions";
import { NoEvidenceLabel } from "@/features/jobs/no-evidence-label";
import type { Job } from "@/features/jobs/types";

// #303: approve completion without worker evidence, with a note and a label.
const job = (status: JobStatus, extra: Partial<Job> = {}): Job => ({
  id: "job-1",
  reference: "JOB-0002",
  title: "Synthetic",
  status,
  dueOn: null,
  ...extra,
});

describe("No worker evidence label (#303)", () => {
  it("has text, not just colour, from one configurable place", () => {
    const html = renderToStaticMarkup(<NoEvidenceLabel />);
    expect(NO_EVIDENCE.label).toBe("No worker evidence");
    expect(html).toContain(">No worker evidence<");
    expect(html).toContain("bg-danger");
    expect(html).toContain("text-danger-foreground");
    expect(NO_EVIDENCE.approverRoles).toEqual(["owner", "manager"]);
  });

  it("shows from review onwards when workers were assigned and none gave evidence", () => {
    const shown = JOB_STATUSES.filter((status) =>
      showsNoWorkerEvidence({ status, hadWorkers: true, evidenceCount: 0 }),
    );
    expect(shown).toEqual([
      "awaiting_review",
      "completed",
      "invoiced",
      "closed",
    ]);
    for (const status of JOB_STATUSES) {
      expect(
        showsNoWorkerEvidence({ status, hadWorkers: false, evidenceCount: 0 }),
      ).toBe(false);
      expect(
        showsNoWorkerEvidence({ status, hadWorkers: true, evidenceCount: 1 }),
      ).toBe(false);
    }
  });
});

describe("status form without evidence (#303)", () => {
  it("doesn't offer Awaiting review when the job has no evidence", () => {
    const html = renderToStaticMarkup(
      <StatusForm
        job={job("in_progress", { hasEvidence: false })}
        saved={() => {}}
      />,
    );
    expect(html).not.toContain('value="awaiting_review"');
    expect(html).toContain('value="cancelled"');
  });
  it("still offers it once there's evidence", () => {
    const html = renderToStaticMarkup(
      <StatusForm
        job={job("in_progress", { hasEvidence: true })}
        saved={() => {}}
      />,
    );
    expect(html).toContain('value="awaiting_review"');
  });
});

describe("review form without evidence (#303)", () => {
  it("warns with the label and asks for a note before approving", () => {
    const html = renderToStaticMarkup(
      <ReviewForm
        job={job("awaiting_review", { hasEvidence: false })}
        saved={() => {}}
      />,
    );
    expect(html).toContain(">No worker evidence<");
    expect(html).toContain("No worker submitted a photo, note or signature");
    expect(html).toContain("approving without evidence");
    expect(html).toContain("Approve completion");
    expect(html).toContain("Request rework");
  });
  it("is unchanged with evidence: no warning", () => {
    const html = renderToStaticMarkup(
      <ReviewForm
        job={job("awaiting_review", { hasEvidence: true })}
        saved={() => {}}
      />,
    );
    expect(html).not.toContain("No worker evidence");
    expect(html).toContain("Required when sending the work back");
  });
});
