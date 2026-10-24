# Profit and draft GST reporting (#54/#55, in progress)

The owner requested work on M4 before every prerequisite merged. Receipts and
bills are now on main; quote estimate integration includes the pending #144 head. It must not merge until the prerequisite fixes
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
  recorded agreed estimate; it is not a historical quote snapshot. `positions[].estimated` separately sums
  accepted quote/variation snapshots as of the range end (revenue, cost, profit,
  margin and source quote IDs). It is null when no accepted estimate exists;
  drafts and later acceptances are excluded. Estimates never add actual revenue
  or incurred cost.
- `GET /api/reports/gst` requires `gst_report.read` (owner/accountant). G1 excludes
  out-of-scope amounts; 1A/1B are separated. Every response says **Draft BAS/GST
  summary — not lodged**. Profit responses contain no GST channels.
- A foreign job/customer ID returns404, rather than an empty report.
- Registration and source-date accounting basis select cash/non-cash facts. Cash
  uses stored allocation GST plus dated void and credit adjustments. Mixed
  out-of-scope G1 uses cumulative integer rounding against the remaining supply.
  A paid credit retains the credited cash component until it is refunded;
  issuing or voiding a credit appends a GST correction under the original invoice
  lock, without editing allocations. Credits cannot exceed the original amounts
  per tax treatment. Cash credit dates precede neither recorded settlements nor
  earlier corrections, so a new credit cannot rewrite their tax attribution. Non-cash uses the earlier invoice/payment
  date, excluding voided settlements. Explicit accountant adjustments are separate dated facts.

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
writes. An immutable `gst_source_postings` row preserves each source tax date.
A newly recorded or approved late item keeps its original business date for
profit and posts GST on the current Sydney day when its tax date is closed.
Later finalisations do not move that persisted date. Finalised snapshots remain
unchanged; filtered live source reports can show the newly recorded costs. Closing/amending takes that same gate
exclusively before reading. It waits for in-flight financial writers and does not
take their row locks. Registration/basis changes cannot change coverage of closed
days. Backdated non-cash settlements cannot shift tax out of a closed source
period. Voiding an earlier non-cash settlement also checks the period it would
remove attribution from. The shared API policy maps SQLSTATE55000 with the fixed
lock marker to409; user text alone cannot select that response. Old documents can be
voided in an open current period: this posts a reversal, not a historical edit.

Cash adjustment timing follows the refund distinction in
[ATO GSTR2000/12, paragraph28](https://www.ato.gov.au/law/view/pdf?DocID=GST%2FGSTR200012%2FNAT%2FATO%2F00001&PiT=20131120000001&filename=law%2Fview%2Fpdf%2Fpbr%2Fgstr2000-012c3.pdf).
The migration brings valid legacy credited-invoice GST balances forward with a
dated correction; immutable historical allocations remain unchanged.

## Verification and remaining work

Combined fixture tests run both registered and unregistered through real stored
invoices, bills, approved expenses and labour; a cash variant checks 9091 cents
sales GST. Payments leave the105000-cent profit unchanged. Report authorization,
foreign objects, finalisation, immutable amendments, correction replay and a
barrier-based close-versus-writer test are included. Labour/accepted-offer snapshots
are seeded records; #59 remains the full browser workflow through all entry UIs.

This is a draft backend PR, **not completion of M4**. Remaining before closing
#54/#55: independent financial/security review, broader correction/basis-boundary regressions (including out-of-order/backdated settlement rounding) and dependency
sync. Follow-on M4 work: #56 exports/ageing/cash, #57 real dashboard, #58 report UI,
#142 late-evidence reclassification and #59 end-to-end reconciliation. No UI,
production deployment or accountant sign-off is included here.
