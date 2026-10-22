# Owner review: dashboard and invoice builder

Status: **pending owner review**. These are concrete wireframes and state contracts, not approved designs or live application screens. #22's owner-review acceptance checkbox remains open until review is recorded.

Read the [dashboard wireframe and states](screens/dashboard.md) and [invoice-builder wireframe and states](screens/invoice-builder.md), with [flow diagrams](flows/previews.md). They use the original [design system](design-system.md); #23 will turn these into explicitly labelled non-functional visual previews after its dependencies.

| Decision to review | Proposed design | Feedback to record |
|---|---|---|
| Dashboard priorities | Invoiced profit/cost first, cash separately, outstanding then recent jobs and draft GST | Is this daily-work ordering useful? |
| Invoice access | Dashboard overdue link → filtered list → invoice detail, two clicks | Is this the expected shortcut? |
| Financial labels | Ex/incl GST on amounts, incurred includes non-creditable GST, cash never labelled profit | Is the wording clear for your team? |
| Builder | Customer/job/date above line editor; totals alongside on desktop and below on phone | Are any required everyday fields missing? |
| Safety | Persistent preview/demo banners; explicit issue review; issued snapshots read-only | Are warnings visible and understandable? |
| Mobile | Single-column cards and line fieldsets; all amounts and tax codes retained | Does the proposed order match field use? |

Record a review comment on #22 with accepted items and requested changes. Implementation teams can continue dependency-independent work, but must not mark this checkpoint complete or claim approval from silence. Preview routes are not linked from production navigation. Owner review of rendered #23 previews is a further checkpoint before broad design rollout.

Evidence so far: documentation link validation and the existing token contrast checks are automated. No rendered viewport, assistive-technology, application financial or authorisation testing is claimed by these artifacts.
