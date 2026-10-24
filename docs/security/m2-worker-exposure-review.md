# M2 security review: worker data exposure and file access (#43)

**Date:** 24 October 2026 · **Reviewer:** Claude (security-engineer role) · **Base:** `main` at `78cda65`
**Scope:** everything an `employee` or `subcontractor` can reach after M2: contractor portal (#37), assignments and
My jobs (#32), private documents (#34), expenses (#40), timesheets and cost rates (#38), work evidence (#42), and the
shared company read. Threat model rows **T02** (elevation via IDs), **T03** (hidden prices/rates in payloads) and
**T07** (file access). The issue's labels "CP2, AS1, DOC2, EX2" aren't defined in the repository; they were read as
these modules.

> **Independence caveat.** The issue asks for a reviewer who didn't build #37/#42. Codex is out of credits, so this
> review was done by Claude; treat it as a single-reviewer pass and have it re-checked when Codex is available.

## Result
**No Critical or High findings.** M3 is not blocked by this review. Two Medium/Low items need an owner decision or
follow-up issue (below).

## What was checked

| Area | Control verified | Evidence |
|---|---|---|
| Route policy | Every worker-reachable API declares a permission; workers hold only `company.read`, `document.upload`, `job.read_assigned`, own-record submit/read permissions | `packages/authz/src/policy.ts`; route table audit |
| Server-rendered pages | Worker pages pass only an ID; data loads through the scoped APIs, so the RSC payload carries no office data | `app/(app)/jobs/[id]`, `offers`, `jobs` pages; e2e sweep below |
| My jobs (employee) | Positive `select` allowlist (reference, title, description, status, due, customer name, site, own visits); visit-only workers see only their visits; deactivation and ended assignments remove access | `server/jobs/my-jobs.ts`; `assignments.test.ts` |
| Portal (subcontractor) | Own-offer view omits job price, committed cost, company GST position and other contractors; other contractors' offers 404 | `ownOfferView`; `contractors.test.ts` "lists only their own offers…" |
| Timesheets | Submitter view has no rate or cost; only the submitter edits (others 404); rates need `employee.cost_rate.read` | `timesheets.test.ts` |
| Expenses | Own view has no approval snapshot, cost split or submitter; detail read needs `expense.read_all`; edits only by submitter; receipt must be the worker's own upload | `expenses/handlers.ts`; `expenses.test.ts` |
| Company read | Workers get id, name, demo flag and default settlement only (ABN/address need `gst_settings.read`) | `COMPANY_FIELDS` |
| Documents (T07) | Content sniffing (PDF/JPEG/PNG/WebP/HEIC only), 10 MB cap enforced while streaming, random object keys, upload and signing throttled, link only for the uploader or `document.read_all`, 5-minute HMAC links bound to company, download is an attachment with `sandbox` CSP, `nosniff`, `no-store` | `server/documents/*`; `documents.test.ts` |
| Evidence | Only the worker's own image upload, once, on a job/visit they work; append-only | `work-evidence.test.ts` |

## New evidence added
`tests/e2e/worker-exposure.spec.ts` plants distinctive office-only values — a job's agreed price, another
contractor's offered rate and the employee's hourly cost — then, signed in as each worker role, reads every page and
API the role can reach (raw HTML including the RSC payload, and JSON). It asserts:
- none of the planted values (or the formatted price) appear anywhere;
- no office-only keys (`agreedPrice`, `hourlyCost`, `costCents`, `committedCost`, `profit`, `margin`,
  `companyGstRegistered`, `contractorName`, `abn`) appear in worker JSON;
- every office endpoint for the same records answers 403/404, and office pages are 404;
- a positive control: the same values *are* present in office responses, so a clean sweep can't be a false negative.

## Findings

| # | Severity | Finding | Recommendation |
|---|---|---|---|
| F1 | Medium (owner decision) | **No malware scanning or quarantine for uploads.** The threat model says this must be decided in #34 and verified here; no decision is recorded. Uploads are type-sniffed and only ever served as sandboxed downloads, so they can't run in the app's origin, but a hostile PDF or image could still harm the office user who opens it locally. | Owner decides: scan on upload (e.g. ClamAV sidecar, fail closed), or accept the risk with the current controls and record it. Filed as #136. |
| F2 | Low | **Unattached uploads are kept indefinitely and are invisible to the office.** An upload that's never attached to an expense or evidence (e.g. after #129's switch-to-note, or an abandoned form) stays in private storage with no listing or cleanup. Only the uploader can link it. | Clean up unattached documents after a grace period, or list them for the office; align with retention in #62. Filed as #137. |
| F3 | Info | A worker can still mint download links for **their own** uploads after losing access to the job. They uploaded the file, so nothing new is disclosed. | Accept; noted for #62. |
| F4 | Info | A signed link is a bearer token for 5 minutes (documented residual risk). | No change. |

## Not covered
- PDF/CSV exports and invoice PDFs (M3/M4; #48, #56, #70) — out of M2 scope.
- MinIO-backed upload flows were exercised by CI's e2e job; the reviewer's sandbox has no object storage.
