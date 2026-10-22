# UI/UX design system and implementation brief

## Objective
Create an original, polished business application for Australian job management, customer tax invoices, GST reporting, employees and on-demand subcontractors. Use reference implementations to learn patterns, not reproduce proprietary websites. Prioritise clarity, accessibility, reliable financial data, and efficient daily workflows.

## Reference repositories and licensing review
- shadcn/ui: https://github.com/shadcn-ui/ui — review current MIT licence and upstream documentation before reusing components.
- Invoice Ninja: https://github.com/invoiceninja/invoiceninja — study invoice workflows; inspect current repository licence; do not copy restricted assets/code without suitable rights.
- ERPNext: https://github.com/frappe/erpnext — study information architecture and workflows; GPL obligations apply to code reuse.
- shadcn blocks: https://ui.shadcn.com/blocks — use only assets and examples under their applicable terms.

Record the version, source URLs, licences and decisions in docs/UI_REFERENCES.md if third-party code is incorporated. Never copy MYOB branding, screenshots, exact layouts or copyrighted assets. Keep code and appearance original.

## Visual direction
- Trustworthy modern accounting and field operations, not flashy marketing or generic admin-template clutter.
- Neutral/slate surfaces, navy/blue primary, green positive, amber pending, red destructive/overdue. Use semantic tokens and accessible contrast; never rely on colour alone.
- Light theme default, complete dark theme. Fonts Geist or Inter (respect licence), tabular numbers for amounts. 8px spacing rhythm, consistent sizing and compact data density.
- Layout: collapsible left navigation on desktop, breadcrumb/header/actions, responsive stacked/mobile navigation, sticky headers only when beneficial.
- Design system: shadcn/ui + Tailwind, Radix primitives where applicable, icon consistency, keyboard/focus support, confirmation for irreversible or financial actions.

## Routes and screens
- /dashboard: revenue ex/incl GST as explicitly labelled, invoiced, received, incurred cost, gross margin, outstanding, GST draft position, recent jobs.
- /customers: searchable company directory, contacts and service locations.
- /jobs: list/table and filters, create/edit, detail with overview, assignments, expenses, visit log, files, status timeline, finances.
- /contractors: approved contractor directory, job offers, agreed costs, acceptance and supplier bills.
- /employees: assignments, timesheets and historical cost rates.
- /quotes: quote builder, revisions, status, approval and conversion to job.
- /invoices: tax invoice list, GST-inclusive/exclusive builder, mixed tax lines, PDF preview, send/issue workflow, partial payments, overdue state.
- /expenses and /payments: separate obligations vs settlement; receipts, attachments and reconciliation.
- /reports: job profitability, customer aging, supplier balances, cash position, draft GST/BAS summaries, CSV export.
- /settings: company, ABN, GST registration, tax basis, invoice numbering, user access and audit events.

## Component standards
Reusable AppShell, SidebarNav, PageHeader, Breadcrumbs, KPIStat, DataTable, FilterBar, EmptyState, StatusPill, MoneyDisplay, FormField, DateRangePicker, ConfirmDialog, Drawer, ActivityTimeline, FileUploader, InvoiceLineEditor, TaxCodeSelect, JobProfitBreakdown and ErrorState. Document props and usage.

- Tables: sorting, search, pagination, loading, column controls, keyboard navigation, empty states; mobile card fallback when appropriate.
- Forms: inline field validation, required markers, unsaved changes warning, sensible input defaults, labels and helper text.
- Money: $ and AUD context, separators, fixed cents, negative sign, tabular figures. Always distinguish ex GST vs incl GST, paid vs incurred, actual vs projected.
- Each financial form shows a transparent GST and total breakdown; do not hide tax computations behind vague labels.
- Avoid user confusion: use explicit statuses, times, last-updated, who approved and what changed.
- Contractor portal must hide sales prices, profits and other contractors' information; enforcement is server-side.

## Responsiveness and accessibility
Review at 360, 390, 768, 1024 and 1440px; WCAG 2.2 AA target. Keyboard access, screen reader labels, visible focus, 44px touch targets where practical, contrast-tested colours, reduced-motion support. Never convey status through colour only.

## Implementation order (all coding agents)
UI work follows the backend milestones in [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md); screens never get ahead of the modules that supply their data.
1. Inspect current repository and docs/REQUIREMENTS.md, docs/GST.md and AGENTS.md. Inventory existing UI before making changes.
2. **M0:** create design tokens, themes, typography, navigation and the reusable app shell, including the persistent "Demo Data" indicator.
3. **M0:** build **design previews** of the Dashboard and the GST-aware Invoice builder — visual only, behind a clearly labelled "Design preview — not real data" banner, using static fixture values, with no financial logic, no persistence and no controls that pretend to succeed.
4. Run usability, contrast, keyboard and mobile viewport checks on the two previews; get the owner's review before scaling the design system.
5. **M1–M3:** roll the design system out to customers, jobs, employees, contractors, expenses, quotes, bills, invoices and payments as each backend module lands. The real invoice builder ships in M3.
6. **M4:** replace the dashboard preview with the real dashboard, reading server-side figures (demo records shown with the "Demo Data" indicator).
7. Keep actual calculations server-side; demo data is database-backed synthetic data, never visual-only fake transactions.
8. Add component, visual regression (screenshots) and end-to-end Playwright tests, including permissions and GST summaries.

## Quality gates
- No copied logo/brand.
- No new hardcoded secrets.
- No incomplete clickable controls that pretend success.
- Reusable patterns rather than one-off components.
- Mobile layouts have no clipped tables or inaccessible controls.
- Visual QA snapshots across themes and representative viewports.
- Financial figures reconcile with the server-side source of truth.

## Acceptance
An owner can find an overdue tax invoice in two clicks from dashboard; a manager can open a job, see internal projected vs incurred costs, and allocate the work; an employee sees only assignments; a contractor cannot see margin; an accountant can inspect GST composition and export draft reports. All screens have usable empty/loading/error states.
