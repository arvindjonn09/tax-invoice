# Invoice builder screen specification

Issue #22 · owner review pending. Uses the [design system](../design-system.md), [GST rules](../../GST.md), [financial definitions](../../DATA_MODEL.md) and [UI brief](../../UI_DESIGN.md). See [owner review sheet](../review-22.md). This is a layout and behaviour contract; it implements no invoice functionality.

## Milestone and access boundary

M0 `/design-previews/invoice-builder` is a static, read-only specimen labelled “Design preview — not real data” and “Static layout preview. Financial actions are unavailable.” Show sample fields as text or disabled controls with explanations. Do not attach save, issue, payment, tax calculation, persistence, export or PDF-generation handlers. Navigate between labelled static registered/unregistered, mixed-code, loading/error and issued-state specimens if useful. A PDF-shaped panel is labelled “PDF layout sample — not an issued document”; it is not a legal or downloadable invoice. Demo Data is a separate server-driven shell indicator.

M3 #47/#48/#49 provides the real builder only after customer, job, settings and invoice domain modules exist. Owner/accountant and other explicitly permitted roles receive server-authorised actions. Employees/subcontractors receive no customer sales invoice data. All issue, PDF, download and correction operations enforce company/object permission independently; hidden controls are not enforcement.

## Desktop layout

```text
┌──────────────┬─────────────────────────────────────────────────────────┐
│ Navigation   │ Demo Data [conditional] / Design preview banner [M0]    │
│              ├─────────────────────────────────────────────────────────┤
│              │ Invoices › New invoice                                  │
│              │ Tax Invoice                         Draft · Not issued  │
│              │ [Save draft] [Preview PDF] [Review and issue]            │
│              ├─────────────────────────────────┬───────────────────────┤
│              │ Customer [Sample Customer A]    │ Totals · AUD          │
│              │ Job [Sample Job 001]            │ Subtotal ex GST       │
│              │ Issue date / Payment due date   │ GST                   │
│              │ Supplier identity (settings)    │ Total incl GST        │
│              │ Recipient identity (customer)   │                       │
│              ├─────────────────────────────────┤ Required before issue │
│              │ Prices entered: (•) ex GST      │ validation summary    │
│              │                 ( ) incl GST    │                       │
│              │ Description / Qty / Unit price │ Snapshot on issue     │
│              │ GST treatment / ex / GST / incl│                       │
│              │ [Add line]                      │                       │
│              │ Notes / payment instructions    │                       │
└──────────────┴─────────────────────────────────┴───────────────────────┘
```

The content area uses 2:1 columns at 1024px+, capped at 1440px. At 768px stack totals below line editor; at 360/390px use full-width fieldsets “Line 1” etc. Each line retains every tax amount; no hidden mandatory field. Actions wrap below the h1; the main action is Review and issue. Sticky totals are allowed only with enough vertical space and no obscured keyboard focus. At 400% zoom remove sticky behaviour. Use native inputs and selects where possible.

Components: AppShell, Breadcrumbs, PageHeader, FormField, InvoiceLineEditor, TaxCodeSelect, MoneyDisplay, ErrorState and ConfirmDialog; Drawer/dialog for PDF preview. One h1 reflects server-established registration state: “Tax Invoice” for a registered taxable-supply specimen, “Invoice” for an unregistered specimen. A separate Draft status explains that no issued invoice exists. Do not promise an invoice number before server issue; say “Assigned on issue”. Settings supply legal identity, ABN and effective registration context; no editable identity override in the builder.

## Fields, entry mode and validation

| Field | Label/help | Validation message and behaviour |
|---|---|---|
| Customer | “Customer (required)” | “Select a customer.” Block issue; server checks company/customer and recipient identity requirements. No real data in previews. |
| Job | “Job” with requirement supplied by domain workflow | “Select an authorised job for this customer.” Reject mismatched/foreign IDs server-side. |
| Issue date | “Issue date (Australia/Sydney)” | “Enter a valid issue date.” Server checks effective GST state and locked period; registration transition shows a specific review requirement. |
| Due date | “Payment due date” | “Enter a valid payment due date.” If earlier than issue: “Due date must be on or after issue date.” |
| Supplier/recipient | Read-only summary with permitted link to settings/customer | “Complete required supplier details before issue.” / “Complete required recipient details before issue.” Link to the missing field's owning module, preserving draft. Statutory thresholds come from #16, not UI constants. |
| Description | “Description (required)” | “Enter a description for line N.” Text wraps and has a server-defined maximum reflected in help. |
| Quantity | “Quantity (required)” | “Enter a quantity greater than zero for line N.” Decimal precision and bounds follow domain rules; no scientific notation or silent coercion. |
| Unit price | “Unit price (ex GST)” or “Unit price (incl GST)” | “Enter a valid AUD amount with at most two decimal places for line N.” Zero is allowed if domain rules allow; negative sale lines require the explicit correction workflow. Bounds checked server-side. |
| GST treatment | “GST treatment (required)” with explanations | “Select a valid GST treatment for line N.” Four distinct domain codes retained even for zero rates; registration rules restrict taxable treatment. |
| Notes/instructions | “Notes” / “Payment instructions” | Server-defined length limit and safe text rendering. Never log payment details or copy real bank details into fixtures. |

Real validation runs on blur and submit; authoritative issue validation runs on server. On failure, preserve draft text, focus an error-summary heading and link each error to field/line. Newly added lines receive focus in Description; remove buttons say “Remove line N”. Removing a populated line offers Undo before save; after removal focus previous line or Add line. At least one valid line is required to issue. Do not drop errors when reordering lines; stable IDs identify them.

Use one explicit radio group “Prices entered” with “Ex GST” and “Incl GST”. Changing mode changes the representation of the same price using the authoritative domain rounding policy; it must not silently change the commercial total. The real implementation shows the recalculated line breakdown and requests confirmation if a domain-supported conversion must change a saved price by a cent. Never relabel unchanged numeric input as a new basis. Show pending recalculation and disable issue until the latest server result matches the draft. M0 offers separate static specimens, not a working toggle.

Each line displays description, quantity, entered unit price, tax code, amount ex GST, GST and amount incl GST. Totals always show Subtotal (ex GST), GST, Total (incl GST), with AUD visible. Mixed-tax treatment is visible per line, not a blanket “Includes 10% GST”. Tax-code help distinguishes GST-free, input taxed and out of scope. Supplier-credit eligibility is not part of a sales invoice builder and must not be inferred here.

## Static specimens for owner review

These are labelled sample values, never client calculations. The M0 renderer transcribes them without a financial engine.

| Specimen | Line | Ex GST | GST | Incl GST |
|---|---|---|---|---|
| Registered combined fixture | Sample service, taxable 10% | $2,500.00 | $250.00 | $2,750.00 |
| Mixed-code layout | Sample taxable service | $100.00 | $10.00 | $110.00 |
| Mixed-code layout | Sample GST-free service | $50.00 | $0.00 | $50.00 |
| Mixed-code layout | Sample input-taxed service | $20.00 | $0.00 | $20.00 |
| Mixed-code layout | Sample out-of-scope item | $30.00 | $0.00 | $30.00 |
| Mixed-code total | Four labelled sample lines | $200.00 | $10.00 | $210.00 |
| Unregistered independent fixture | Sample service, no GST charged | $2,500.00 | $0.00 | $2,500.00 |

The mixed-code specimen demonstrates layout, not classification advice for an actual contracting business. The unregistered specimen title is Invoice, with “Not GST registered — no GST charged”; tax controls cannot select a chargeable 10% rate. Keep the explicit 0.00 GST row for transparent review, without implying all zero codes are interchangeable.

## PDF preview and issue flow (M3)

Preview PDF opens an accessible titled dialog with a readable HTML summary equivalent to the PDF. Show draft watermark until issue; server-rendered PDF content uses validated draft values and never silently substitutes stale totals. Dialog supports Escape, close button, trapped focus and focus return to Preview PDF. At mobile sizes provide full-width scrollable content and selectable text, not an inaccessible image-only page. Download is an authorised server action after its module exists.

Review and issue opens a confirmation showing customer, job, issue/due dates, document title, subtotal/GST/total, and “Issuing assigns an invoice number and preserves this document. Corrections require a credit note, void or reversal.” Initial focus Cancel. Confirm button explicitly says “Issue tax invoice” or “Issue invoice”. Submit once with transactional server idempotency; pending text “Issuing…” prevents duplicates. A lost response offers “Check issue status” or safe retry with the same key, not creation of a fresh invoice. Success navigates to immutable issued detail with invoice number and confirmation. Sending email and recording payment are separate authorised actions, not implied by issue.

Issued preview/detail displays locked icon + “Issued — read only”, actor/time and snapshot document. Never offer silent edit/delete. Correction actions are named credit note/void/reversal and follow later domain rules, especially after receipts or period locking. For state diagrams and alternative paths see [preview flows](../flows/previews.md).

## States

| State | Content and recovery | M0 representation |
|---|---|---|
| Loading | Skeleton structure, “Loading invoice”, `aria-busy`; no zero totals or draft number. | Labelled static loading specimen. |
| Empty | “Add the first invoice line”; totals not shown as final, issue unavailable with reason. Customer/job defaults only from permitted real context. | Static blank-draft sample. |
| Error | Inline/summary field errors; calculation/PDF/save failure retains values and last confirmed totals labelled stale; retry only failed operation. | Named invalid-field and server-error specimens; no simulated retry. |
| Success | Draft saved displays timestamp and “Draft saved”; issued success displays server number and immutable snapshot. A PDF preview alone never implies saving or issuing. | Text “Sample saved state” / “Sample issued state”, not live success toast. |
| Unsaved/pending | “Unsaved changes” and save state; issue blocked during unresolved recalculation. Warn on navigation away from dirty real draft. | Static state label; no persistence. |
| Conflict | “This draft changed in another session. Review the latest version before saving.” Preserve local input for comparison. | Static conflict specimen. |
| Locked/issued | Read-only snapshot; permitted correction workflow, reason and audit identity. Locked-period error explains accountant review. | Static locked state. |
| Access denied/session expired | Remove private data; require login/re-authorisation, never silently save elsewhere. | Static safe error copy only. |
| PDF unavailable | “PDF preview could not be generated.” Retain draft and accessible HTML summary; retry generation. | Static error sample. |

## Keyboard, accessibility and verification

Reading/tab order: breadcrumb → actions → customer/job/date fields → supplier/recipient summaries → entry-mode group → line fields/actions → notes → totals → issue review. At narrow widths totals follow lines in DOM as well as visually. Radio/select keyboard behaviour stays native; line rows are not a spreadsheet widget. Describe errors/help with `aria-describedby`, mark invalid fields only after validation, announce one submission result, and prevent background focus in dialogs. All statuses include words/icons, all amounts have basis, all targets are at least 44px, and focus must be visible in both themes/forced colours.

#23 verifies static success/loading/empty/error specimens, full line breakdown in both modes, 360/390/768/1024/1440px, keyboard, screen reader, 200% text, 400% zoom and reduced motion. M3 tests real mixed-code calculation with the same GST/profit fixtures, registration-date titles, server validation, stale recalculation, authorised PDF access, issue retries and snapshot immutability. This specification does not claim those application tests have run. Owner review remains pending.
