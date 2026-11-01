# Accessibility and responsive audit (#60)

`tests/e2e/a11y-sweep.spec.ts` opens every screen each role can reach, at **360, 768 and 1440 px** in **light and dark**:
- **Owner:** 21 screens, including every Reports tab and all three Payments views.
- **Accountant, manager, employee and subcontractor:** each one's own screens.
- **Standalone pages:** sign-in and account.

On every screen it checks:
- exactly one `h1` and one `main`, and (in the app shell) one "Skip to main content" link;
- no horizontal scrolling;
- **axe with the WCAG 2.0, 2.1 and 2.2 A/AA rule sets: no violations**;
- keyboard: the first Tab reaches the skip link, and Enter moves focus into the main content.

**Result (2 November 2026):** the sweep found **no WCAG 2.2 AA failures**, so no fix issues were needed.

**Covered by other specs:**
- **Forced colours, reduced motion, 200% text reflow and keyboard focus styles:** `design-system.spec.ts`.
- **Screen states and forms** (labels, error text tied to fields, live status messages): each feature's own spec, for example `invoices.spec.ts`, `payments.spec.ts`, `reports.spec.ts`, `dashboard.spec.ts` and `expenses.spec.ts`.

**Not automated:** a real screen-reader pass (VoiceOver or NVDA) and testing with users. Do both before the production pilot. Automated checks can't judge reading order or whether wording makes sense.
