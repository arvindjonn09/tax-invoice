# Profit and draft GST reporting (#54/#55, in progress)

This branch is stacked on #143 / #127 at the owner's request to start M4 while
those dependencies are reviewed. It must not merge until the prerequisite fixes
are merged, main is integrated, CI passes and the other agent reviews the head.

## Shared source of truth

`server/reports/events.ts` projects company-scoped invoices, supplier bills,
approved expenses, approved labour, settlements and immutable void adjustments.
Readers use one repeatable-read transaction. All money is bigint internally and
exact cent strings in JSON. Recoverable GST is excluded from profit; purchases
use the recorded cost snapshot, including non-creditable GST. Settlements are
separate channels and cannot add revenue or incurred cost.

Source document events remain in their original business-date period. A void is
a signed reversal on its Sydney business date, with any separate GST rounding
adjustment on `adjustedOn`. Currently void records are not simply removed from
historical reports. Dates are inclusive. Cancelled jobs retain their costs.

- `GET /api/reports/profitability?from=&to=&jobId=&customerId=` requires
  `job.profit.read`. It returns period totals, job/customer breakdowns, unallocated
  general expenses, source facts, and unbilled commitments at the range end.
  `positions.currentAgreedRevenueExclusive` explicitly means the job's **current**
  recorded agreed estimate; it is not a historical quote snapshot.
- `GET /api/reports/gst` requires `gst_report.read` (owner/accountant). G1 excludes
  out-of-scope amounts; 1A/1B are separated. Every response says **Draft BAS/GST
  summary — not lodged**. Profit responses contain no GST channels.
- A foreign job/customer ID returns404, rather than an empty report.
- Registration and source-date accounting basis select cash/non-cash facts. Cash
  uses stored allocation GST plus dated void adjustments; mixed out-of-scope G1
  uses cumulative integer rounding. Non-cash uses the earlier invoice/payment
  date. Explicit accountant adjustments are separate dated facts.

Basis changes and complex adjustments require accountant review: manual
adjustments are supported; there is no automatic opening-balance conversion
between bases. This remains draft support, not lodgement or tax advice. Existing
pinned rules are in [GST.md](../GST.md) and
[the sourced domain rules](../research/domain-gst-profit.md). ATO background on
adjustment notes: [GSTR 2013/2](https://www.ato.gov.au/law/view/document?LocID=%22GST%2FGSTR20132%2FNAT%2FATO%2Ffp4%22&PiT=20251205000001).

## Finalisation and amendments

- `POST /api/reports/gst/periods` requires `gst_settings.update`. It accepts
  `{from,to,note}` for a finished, complete configured month or quarter; overlapping
  finalisations are rejected. The report snapshot and audit are transactional.
- `GET /api/reports/gst/periods` returns immutable revision history to GST readers.
- `POST /api/reports/gst/adjustments` accepts whole signed-cent strings
  `{effectiveOn,g1,oneA,oneB,reason}` for an open, registered date.
- `POST /api/reports/gst/periods/:id/amend` records a correction inside a closed
  period and a new report revision, preserving all earlier snapshots. Both
  correction endpoints require an `Idempotency-Key`; replay creates neither a
  second adjustment nor revision, changed content with the same key is409.
- An exact whole-company GST read of a finalised range returns the latest stored
  revision, with finalisation metadata. Filtered drill-down is a live source view.

Database triggers take a shared per-company advisory transaction gate for source
writes and reject dates in closed periods. Closing/amending takes that same gate
exclusively before reading. It waits for in-flight financial writers and does not
take their row locks. Registration/basis changes cannot change coverage of closed
days. Backdated non-cash settlements cannot shift tax out of a closed source
period. The shared API policy maps the lock refusal to409. Old documents can be
voided in an open current period: this posts a reversal, not a historical edit.

## Verification and remaining work

Combined fixture tests run both registered and unregistered through real stored
invoices, bills, approved expenses and labour; a cash variant checks 9091 cents
sales GST. Payments leave the105000-cent profit unchanged. Report authorization,
foreign objects, finalisation, immutable amendments, correction replay and a
barrier-based close-versus-writer test are included. Labour/accepted-offer snapshots
are seeded records; #59 remains the full browser workflow through all entry UIs.

This is a draft backend PR, **not completion of M4**. Remaining before closing
#54/#55: independent financial/security review, richer quote estimate/cost source
integration after #44, broader correction/basis-boundary regressions (including out-of-order/backdated settlement rounding) and dependency
sync. Follow-on M4 work: #56 exports/ageing/cash, #57 real dashboard, #58 report UI,
#142 late-evidence reclassification and #59 end-to-end reconciliation. No UI,
production deployment or accountant sign-off is included here.
