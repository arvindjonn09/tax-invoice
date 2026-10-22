# Owner review: dashboard and invoice builder

Status: **owner layouts approved with changes; requested changes incorporated; supervisor review pending**. [Owner decision on #22, 22 October 2026](https://github.com/arvindjonn09/tax-invoice/issues/22#issuecomment-6340064070) approves items 1–6 below for the M0 static previews. This records specification approval, not approval of rendered previews or live application functionality.

Read the [dashboard wireframe and states](screens/dashboard.md) and [invoice-builder wireframe and states](screens/invoice-builder.md), with [flow diagrams](flows/previews.md). They use the original [design system](design-system.md); #23 will turn these into explicitly labelled non-functional visual previews after its dependencies.

| Decision reviewed | Approved design | Owner outcome |
|---|---|---|
| Dashboard priorities | Invoiced profit/cost first, cash separately, outstanding then recent jobs and draft GST | Approved; requested additions below incorporated. |
| Invoice access | Dashboard overdue link → filtered list → invoice detail, two clicks | Approved; requested additions below incorporated. |
| Financial labels | Ex/incl GST on amounts, incurred includes non-creditable GST, cash never labelled profit | Approved; requested additions below incorporated. |
| Builder | Customer/job/date above line editor; totals alongside on desktop and below on phone | Approved; requested additions below incorporated. |
| Safety | Persistent preview/demo banners; explicit issue review; issued snapshots read-only | Approved; requested additions below incorporated. |
| Mobile | Single-column cards and line fieldsets; all amounts and tax codes retained | Approved; requested additions below incorporated. |

Requested changes incorporated in this revision:

1. Cash sample: Paid incl GST **$665.00**, Net cash **$335.00**, Supplier outstanding **$590.00**, with the paid-at-purchase assumption and internal-labour/wages footnotes under the cash cards.
2. Optional **Customer reference / PO number** and **Service location (site address)** in invoice details, included on the invoice/PDF when filled and snapshotted at issue.
3. Optional **Unit** next to Quantity on each line, also shown on the invoice/PDF.
4. Phone sticky bar **“Total incl GST $X · View breakdown”**, with clear focus/content, safe-area spacing and a normal-flow fallback at 400% zoom.

PR #76 must remain unmerged until every check passes and an exact-head “🔎 Claude supervisor review (<sha7>)” says “Ready to merge”. Build #23 only after #76 is merged and its other dependencies are satisfied. Preview routes are not linked from production navigation. Owner review of rendered #23 previews remains a separate checkpoint before broad design rollout.

Evidence so far: documentation link validation and the existing token contrast checks are automated. No rendered viewport, assistive-technology, application financial or authorisation testing is claimed by these artifacts.
