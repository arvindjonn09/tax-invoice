# M3 financial endpoints security review (#53)

Scope: invoices and credit notes, quotes, supplier bills, customer receipts and refunds, supplier payments, invoice
PDFs and private download links, as merged on `main` at `3f41ee9`. Checked against the [threat model](threat-model.md)
(T02 elevation, T03 disclosure, T04/T05 tampering, T06 repudiation, T07 file links, T08 renderer, T10 DoS) and the
non-negotiables in [AGENTS.md](../../AGENTS.md). Reviewer: Claude (security-engineer role), 2026-10-24.

**Result:** no Critical or High findings. One Low finding and one test gap were fixed in this PR. Two items are
recorded for later milestones.

## What was checked

| Area | Evidence | Result |
|---|---|---|
| Route authorisation (T02) | Every financial route is `withPolicy("<permission>", handler)`: `invoice.read/write/issue`, `quote.read/write`, `bill.read/write`, `payment.read/write`. `route-policy.test.ts` rejects any other export. `/api/files/[token]` is the documented public exception (signed token). | ✅ |
| Role matrix (T02/T03) | `packages/authz/src/policy.ts` is deny-by-default. Employees and subcontractors hold no quote, invoice, bill or payment permission. Office roles read; owner and accountant issue and pay; managers draft quotes. | ✅ (test gap fixed below) |
| Object scope (T02) | Every id lookup goes through `requireSameCompany` (404 for other tenants). Lists filter on `companyId`. Pages call `can(...)` and `notFound()`, then load records scoped to the company. | ✅ (lock ordering fixed below) |
| Cross-tenant references (T04) | Customer, job, site, contractor, offer, document, invoice and bill ids are checked in the handlers and enforced by composite `(company_id, …)` foreign keys on every financial table (`invoices`, `invoice_items`, `quotes`, `supplier_bills`, `receipt_allocations`, `supplier_payment_allocations`, GST adjustment tables). | ✅ |
| Server-authoritative money (T05) | Invoice and quote amounts are computed on the server from the lines (`calculateSupplyLine`, integer cents); the client sends no totals. Bill lines carry the supplier's stated ex-GST and GST, validated by `billLineProblem`: only a registered supplier, only on taxable lines, 10% ± 1 cent, never negative. | ✅ |
| Immutability (T05/T06) | Guard triggers on `invoices`, `invoice_items`, `quotes`, `quote_items`, `supplier_bills`, `customer_receipts` and `supplier_payments`; append-only allocations, GST adjustments and `invoice_pdfs`; truncate blocked. Corrections are credit notes and voids with audit events in the same transaction. | ✅ |
| Idempotency and races (T04) | Receipts and supplier payments require `Idempotency-Key`, unique per `(company_id, key)`; a replayed key with a different body gets 409. Allocations lock invoices and bills in sorted order, then recheck balances under the lock. | ✅ |
| PDF renderer (T08) | pdf-lib with standard fonts only: no HTML, scripts, fonts, images or fetches. Text is normalised to WinAnsi before drawing, so hostile or non-Latin text can't crash or inject. | ✅ |
| Download links (T07) | HMAC-SHA256 token (HKDF-derived key) bound to document and company, 5-minute TTL, `timingSafeEqual`; random object keys; always an attachment; link minting throttled (`download.sign`). | ✅ |
| Responses and logs (T03/T11) | Handlers answer through `privateJson` (no-store); errors via `safeError`; the redacting logger is used. | ✅ |
| Tests (T02/T04) | Cross-tenant ("outsider") and wrong-role cases in `invoices`, `quotes`, `supplier-bills`, `receipts` and `invoice-pdfs` integration tests; concurrency and idempotency in `money-safety` and `financial-safety`. | ✅ |

## Findings

| # | Severity | Finding | Status |
|---|---|---|---|
| F1 | Low | `lockRow` ran `SELECT … FOR UPDATE` on a request-supplied id **before** the company check. A user with write access in company A could briefly hold a row lock on company B's invoice, quote, bill, receipt or payment for the length of their own (refused) transaction. No data was exposed, but it allowed small cross-tenant lock contention. | **Fixed:** `lockRow(tx, table, id, companyId)` adds `AND company_id = …`; all financial call sites pass the actor's company. Test: `receipts.test.ts`, "never locks another company's row". |
| F2 | Test gap | The role-matrix test did not assert that employees and subcontractors lack `quote.read/write`, `invoice.write/issue`, `bill.write` and `payment.write`. | **Fixed:** added to the restricted list in `packages/authz/test/authz.test.ts`. |
| F3 | Info | CSV exports don't exist yet. Formula-injection escaping is required when they land. | Tracked in #56 / #70 |
| F4 | Info | Supplier credit notes (#155) and pay-on-account expenses (#156) are not on `main` yet. Review them with the same checklist before merge, including the chronology rule from #159. | Tracked on those PRs |

## Not covered
- Reporting endpoints (#54/#55, PR #150): reviewed separately on that PR.
- Malware scanning of uploads: owner decision #136.
- Deployment controls (TLS, proxy, bucket policy): #64, section 8 of [requirements.md](requirements.md).
