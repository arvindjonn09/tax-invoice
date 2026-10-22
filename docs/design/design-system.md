# JobFlow design system

Specification for #18; implementation begins in #19. This is the single source of truth for visual tokens and component behaviour, subordinate to [UI requirements](../UI_DESIGN.md), [financial definitions](../DATA_MODEL.md) and [GST rules](../GST.md). No third-party assets or component code are incorporated here. The navy/slate visual language, layouts and naming are original; future shadcn/ui, font and icon incorporation requires a licence record in `docs/UI_REFERENCES.md`.

## Semantic colours

Use these exact opaque sRGB pairs. Tokens are semantic CSS custom properties; changing themes changes values, not component markup. Light is default; support an explicit light/dark/system preference without flashing the wrong theme. Do not apply opacity to text or place text on unspecified backgrounds. Decorative separators may use subtle colours; controls use `control-border` for a visible boundary. All text including muted and disabled labels meets 4.5:1. Status includes an icon and written label.

<!-- contrast-pairs:start -->
| Pair | Light foreground | Light background | Dark foreground | Dark background | Light ratio | Dark ratio |
|---|---|---|---|---|---|---|
| foreground / background | #0F172A | #F8FAFC | #F8FAFC | #0F172A | 17.06 | 17.06 |
| card-foreground / card | #0F172A | #FFFFFF | #F8FAFC | #1E293B | 17.85 | 13.98 |
| muted-foreground / muted | #475569 | #F1F5F9 | #CBD5E1 | #334155 | 6.92 | 6.97 |
| primary-foreground / primary | #FFFFFF | #1E40AF | #0F172A | #93C5FD | 8.72 | 9.90 |
| primary-hover-foreground / primary-hover | #FFFFFF | #1E3A8A | #0F172A | #BFDBFE | 10.36 | 12.56 |
| link / card | #1E40AF | #FFFFFF | #93C5FD | #1E293B | 8.72 | 8.11 |
| success-foreground / success | #166534 | #DCFCE7 | #BBF7D0 | #14532D | 6.49 | 7.52 |
| warning-foreground / warning | #854D0E | #FEF3C7 | #FDE68A | #713F12 | 6.15 | 6.96 |
| danger-foreground / danger | #991B1B | #FEE2E2 | #FECACA | #7F1D1D | 6.80 | 6.93 |
| info-foreground / info | #1E40AF | #DBEAFE | #BFDBFE | #1E3A8A | 7.15 | 7.29 |
| destructive-foreground / destructive | #FFFFFF | #B91C1C | #0F172A | #FCA5A5 | 6.47 | 9.41 |
| control-border / card | #64748B | #FFFFFF | #94A3B8 | #1E293B | 4.76 | 5.71 |
| focus-ring / background | #1D4ED8 | #F8FAFC | #93C5FD | #0F172A | 6.41 | 9.90 |
<!-- contrast-pairs:end -->

Ratios use WCAG relative luminance, calculated by `python3 scripts/check-design-contrast.py`. Text pairs require 4.5:1; control boundary and focus pairs require 3:1. These are the only permitted text/background combinations; reuse card text for popovers, dialogs and inputs, muted for secondary/disabled surfaces, primary-hover for active buttons, info for selected navigation, warning for demo and preview banners. Links remain underlined within prose. Focus uses a 2px ring with a 2px card/background offset; test visibility on coloured controls. Forced-colours mode preserves system outlines and borders. A token table does not replace rendered accessibility tests in #19/#23.

## Typography, geometry and motion

Start with `ui-sans-serif, system-ui, sans-serif`; optional Geist or Inter awaits licence review and local hosting. Body and controls: 16px/24px, weight 400; secondary/table: 14px/20px; caption: 12px/16px; section heading: 20px/28px, 600; page title: 28px/36px, 600; KPI amount: 32px/40px, 600. Use `font-variant-numeric: tabular-nums lining-nums` for money, quantities and dates. Avoid fixed-height text containers; preserve 200% text scaling and reflow at 400% zoom.

Spacing tokens: 0, 8, 16, 24, 32, 40, 48, 64px (8px rhythm). A 4px optical gap is allowed only between an icon and label. Content padding is 16px mobile, 24px tablet, 32px desktop; maximum content width 1440px. Controls and touch targets are at least 44px high/wide; table cells have 16px horizontal and 8px vertical padding. Radius: controls 8px, cards/dialogs 16px, status pills 999px. Elevation: flat content, card `0 1px 2px rgb(15 23 42 / 0.08)`, popover `0 8px 24px rgb(15 23 42 / 0.16)`; dark theme also uses a visible control border. Shadows never carry meaning.

Z-order: content 0, sticky table/header 10, navigation drawer backdrop 30, navigation drawer 40, dialog backdrop 50, dialog 60, toast 70. Keep banners in document flow and account for their height in sticky offsets. Motion: 120ms colour transitions, 180ms drawer transition; disable nonessential animation with `prefers-reduced-motion`. No animated financial counters.

## Component contracts

Props below describe implementation contracts, not already available exports. Every component accepts an accessible name where visible content is insufficient. Native semantics and Radix focus management are preferred after licence review. States must be visible in both themes. Server policies determine data and permitted actions; presentation never grants access.

| Component | Inputs and variants | States and behaviour |
|---|---|---|
| AppShell | children, company label, permitted navigation, demoPresent, preview, theme | Skip link → navigation → page header → main; one main landmark. Load demo status server-side before rendering business content; error resolving status blocks content with retry. Persistent banners above main. |
| SidebarNav | authorised items `{label, href, icon}`, currentPath, collapsed | Desktop 240px or 72px collapsed with named icon buttons; current link has `aria-current=page`, text and indicator. Below 1024px use a labelled menu button and modal drawer; Escape closes, focus returns, background inert. No inaccessible hover-only flyouts. |
| PageHeader | title, description, primaryAction, secondaryActions | One h1; action row wraps and stacks on small screens. One primary action. Pending actions retain text plus progress and prevent repeat submission. |
| Breadcrumbs | ordered `{label, href?}` | Native nav labelled Breadcrumb, ordered list, final item current page; wrap long labels without hiding the current location. |
| KPIStat | label, formattedValue, basis, period, updatedAt, comparison? | Loading skeleton with text alternative; unavailable shows “Unavailable”, zero shows $0.00. Comparison includes text and sign, no colour-only arrows. Basis required for money. M0 accepts static preview content only. |
| DataTable | caption, columns, rows, sort, pagination, selection?, rowActions? | Semantic table with scoped headers and `aria-sort`; sort buttons in headers. Named selection controls, stable row IDs, explicit pagination count; loading, empty, filtered-empty and error states. No spreadsheet arrow-key model unless implemented completely. |
| FilterBar | search, filters, appliedCount, onClear | Visible labels, explicit Apply on mobile; Clear filters restores defaults. Search results announce count politely after completion; no focus jump. Store/share non-sensitive filter state in URL. |
| EmptyState | title, description, permittedAction? | Distinguish “No jobs yet” from “No results”; filtered state offers Clear filters. No fake successful action or invented records. |
| ErrorState | title, safeMessage, retry?, reference? | Explain recovery; retain filters and unsaved input. No internal stack, sensitive IDs or customer data. Inline submit errors use alert once; full-page failures have a focusable heading. |
| StatusPill | status, label, icon | Neutral draft, info active, success completed/paid, warning pending, danger overdue/void. Explicit label and icon; no interactive pill unless a real button. “Paid” means settlement only. |
| MoneyDisplay | integer cents or safe BigInt, currency=AUD, basis, unavailable? | Format server/domain result with separators and exactly two decimals; right-align, prevent truncation. Example $2,500.00 ex GST, −$15.00 incl GST. Currency context AUD visible on page; accessible text includes basis. No calculation from decimal floating point. |
| FormField | id, label, required, help, error, children | Persistent label with linked help/error; required text explained. Validate on blur/submit, preserve values; error summary links to first invalid field and receives focus on failed submit. `aria-invalid` only for invalid values. |
| ConfirmDialog | title, consequence, summary, confirmLabel, pending, onConfirm | Modal with labelled title/description, Cancel and explicit “Issue tax invoice”/“Void invoice” labels. Initial focus on Cancel for irreversible actions; trap focus, Escape cancels before submission, restore focus. Pending cannot imply cancellation; show result/error in place. Financial retries use server idempotency. |
| TaxCodeSelect | value, permittedCodes, onChange, disabledReason? | Label “GST treatment”; options “Taxable — 10%”, “GST-free — 0%”, “Input taxed — 0%”, “Out of scope — 0%” mapped to domain codes. Native select on mobile; descriptions explain distinction. Unregistered mode supplied by server rules; no client inference from a zero rate. |
| InvoiceLineEditor | draft lines with stable IDs, entryMode, permissions, serverTotals, errors | Fields: description, quantity, unit price (explicit ex/incl GST), GST treatment, ex GST, GST and incl GST. Add/remove buttons identify line; after removal focus previous line or Add line. Errors identify line and field. Read-only issued snapshots; correction actions instead of edit. M0 preview has no mutation handlers. |
| DateRangePicker | start, end, timezone, errors | Label both dates; typed dates supported alongside calendar; announce Australia/Sydney. Invalid ranges block Apply with linked error. Keyboard-operable calendar if used. |
| Drawer | title, open, onClose, children | Dialog semantics, focus trap/return, Escape, close button and scrollable content. Unsaved changes prompt before abandoning. |
| ActivityTimeline | authorised events, actor, timestamp, description | Ordered list with written action and Australia/Sydney timestamp; no sensitive data hidden only by CSS. Loading/error/empty states. |
| FileUploader | permittedTypes, maxBytes, uploadState | Native labelled input, keyboard alternative to drop area, progress/cancel/error/retry. Explain limits before selection; server validates. Private download access is checked afresh. |
| JobProfitBreakdown | server revenue/cost/profit, basis, period | Separate quoted, committed, incurred, paid; reconcile breakdown to displayed totals. Zero revenue margin “N/A”. Loading/error/unavailable states; never render unauthorised financial data. |

## Financial language and correction patterns

Each amount carries its own basis in its label or column header. Use “Unit price (ex GST)” / “Unit price (incl GST)” and a visible entry-mode choice. Always show subtotal ex GST, GST and total incl GST together; mixed-code lines retain their treatment. Entry-mode changes preserve value according to domain rules and show the resulting breakdown. Server results are authoritative; do not calculate tax, profit or attribution in a display component. The domain expert resolves rounding and statutory validation in #16; this document introduces no legal thresholds.

Use “Invoiced revenue (ex GST)”, “Incurred job cost (ex GST + non-creditable GST)”, “Gross job profit (invoiced basis)” and “Margin (invoiced basis)”. Show projected profit separately with its estimate/quote basis. Quoted, committed, incurred and paid each have separate rows, never a generic “Cost” total that adds them together. Customer outstanding and supplier outstanding use incl GST; receipts and payments are separate settlement rows. Recoverable GST is excluded from profit. Zero is a valid value; missing is “Unavailable”; zero-revenue margin is “N/A”.

Draft GST pages say “Draft BAS/GST summary, not lodged”, show period, cash/non-cash basis and last update, and expose G1/1A/1B drill-down only to authorised roles. Locked and issued states show lock icon plus text, issuer/approver/time and an authorised credit/void/reversal action. Confirmation summarises the financial consequence; failures preserve input and never report success before server confirmation. M3/M4 implement these behaviours after their dependencies land.

## Demo and preview indicators

“Demo Data” is a full-width warning banner in the shell whenever demo records exist in the active company context, across every route including worker views. Text: **Demo Data** — “Synthetic demonstration records are present.” It has an icon, visible border and no dismiss control; never collapse to a dot or tooltip. Server/database state determines presence, independent of filters, current record and role. Provide it on initial render; theme changes/navigation must not remove it. Re-evaluate after seeding/removal; production seeding remains forbidden by backend rules. Printed/exported demo content must retain a Demo Data label.

“Design preview — not real data” is a separate, non-dismissible info banner immediately above M0 preview content: “Static layout preview. Financial actions are unavailable.” It appears even when no demo database exists. Demo and preview indicators may coexist and neither substitutes for the other. Static preview controls are disabled with visible explanatory text or represented as labelled samples; navigation among previews may work. No save, issue, payment, export or calculation action pretends success. No database writes or financial functions power previews.

Banners wrap at 360px, have 16px padding and no fixed height. Expose each as a named region; initial static content uses no assertive live region. A runtime status change may announce once with `role=status`. Keep banners in the shell outside a modal drawer so closing navigation retains them.

## Responsive and accessibility acceptance

At 360/390px: single-column headers, full-width fields, stacked invoice lines as fieldsets with legend “Line N”; line totals remain visible. At 768px: two-column forms where labels fit. At 1024px: persistent sidebar and table layout. At 1440px: cap content width. Preserve the same reading order; no hidden mandatory columns. Dense tables may scroll inside a labelled, keyboard-focusable region with visible overflow affordance; the page itself must not overflow. Dialogs fit viewport with internal scroll and visible actions.

Keyboard checks cover skip link, mobile drawer, sort/filter/pagination, forms, line add/remove and confirmations with no trap outside a modal. Focus must not be obscured by sticky content. Errors identify recovery in text; status has icon + label. Verify screen-reader headings, table headers, names, form descriptions and one-time announcements. Touch targets 44px; no hover-only actions. Verify both themes, reduced motion, forced colours, 200% text and 400% zoom. Implementation issues #19/#20/#23 add rendered/component/Playwright tests and owner preview review; this specification alone does not claim those checks pass.

## Handoff and evidence

#19 implements tokens/components, #20 the shell/banners, #22 detailed preview screen specs, #23 non-functional previews. M1–M4 supply real module UI in milestone order. The implementation-plan design-token checkbox remains open until code, tests and review land. Changes here do not alter AGENTS.md or CLAUDE.md rules.

Run `python3 scripts/check-design-contrast.py` for all listed pair ratios and stale-table detection, plus `git diff --check`. The Design specification contract CI workflow repeats the contrast check. This documentation branch has no application runner; application type-check, lint, unit/integration, visual, authorisation and security checks were not run for this specification. QA and code review remain required before owner merge.
