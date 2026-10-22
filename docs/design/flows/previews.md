# Preview and future financial flows

These diagrams distinguish [M0 preview specimens](../review-22.md) from later real workflows. They define no functioning financial UI in M0.

## M0 review

```mermaid
flowchart TD
  A[Open labelled design preview] --> B{Choose specimen navigation}
  B --> C[Dashboard static sample]
  B --> D[Invoice static sample]
  C --> E[Inspect loading, empty, error and success samples]
  D --> E
  E --> F[Owner records feedback on #22]
  F --> G[Designer updates specification]
  G --> H[Owner review recorded before scale-out]
```

No path saves, issues, pays, recalculates, exports or generates an invoice. A preview sample does not require database demo records; the shell's separate Demo Data indicator still follows database state.

## M3 issue, with failure paths

```mermaid
flowchart TD
  A[Authorised draft] --> B[Edit fields and lines]
  B --> C[Server validates and computes]
  C -->|Invalid| D[Focus error summary, preserve input]
  D --> B
  C -->|Valid| E[Review document and totals]
  E -->|Cancel| B
  E -->|Confirm once| F[Transactional idempotent issue]
  F -->|Response lost| G[Check status or retry same key]
  G --> F
  F -->|Rejected or conflict| D
  F -->|Success| H[Issued snapshot, number and audit]
  H --> I[Authorised credit, void or reversal if needed]
```

All paths check company and object permission; authentication failure leads to a safe access/login state, not the draft payload. Locked periods reject issue/correction as required by domain rules. A PDF error stays in the preview dialog and does not issue the draft.

## M4 overdue path

```mermaid
flowchart LR
  A[Dashboard overdue invoice link] -->|Click 1| B[Authorised overdue invoice list]
  B -->|Click 2 on invoice number| C[Invoice detail with current balance]
  B -->|No results| D[No overdue invoices, retain filter context]
  C -->|Settled meanwhile| E[Show current settled status and explanation]
```

This path is an acceptance contract for the real M3/M4 modules. M0 labels the sample link unavailable instead of linking to nonexistent financial screens.
