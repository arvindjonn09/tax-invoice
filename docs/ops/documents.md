# Unattached uploads (#137)

A document is uploaded first and attached second: to an expense receipt, a supplier bill, a work-evidence photo and so on. Sometimes the second step never happens. A form gets abandoned, an attach fails, or the evidence type is switched to a note (#129). Without cleanup, those files would stay in private storage forever: only the uploader could link them, and the office couldn't see them.

**Rule:** a document that **nothing references** and that **no audit event names** in a document-reference field (`receiptDocumentId`, `documentId`; free text doesn't count) (other than its own upload) is deleted once it is **older than 7 days**. A receipt swapped out of a submitted expense is named in that expense's audit history, so it is kept as evidence of what was submitted. Each deletion writes a `document.unattached_deleted` audit event. The event records the document's kind, size, upload time and the grace period, and is attributed to the uploader. It never records the file name or storage key.

## Command

```sh
pnpm documents:cleanup --dry-run       # counts only, deletes nothing
pnpm documents:cleanup                 # delete (default grace period: 7 days)
pnpm documents:cleanup --grace-days 14
```

- **Settings:** staging/production require `MAINTENANCE_DATABASE_URL` for the separate maintenance login and a separate storage key limited to DeleteObject on the documents prefix. Local development may use DATABASE_URL. The web role cannot delete document rows or read the private outbox.
- **Output:** a single JSON line with counts: deleted, bytes, skipped, failed, objectsLeft, and the error classes seen (codes or names only, never messages). It never prints file names, keys or connection details.
- **Flags:** unknown or malformed flags are refused, so a typo like `--dryrun` can't turn into a real run.
- **Failures:** a failure on one document doesn't stop the batch. That document is left in place for the next run, and the command exits 1.
- **Schedule:** run it daily on staging and production, for example from the same timer host as the backups.
- **Batch size:** each run handles at most 500 documents.

## Why it never deletes an attached document

- **Every referencing table is checked.** The tables that reference `documents` are read from the database catalog (foreign keys) at run time, so a table added later is covered automatically. If fewer than the four known references are found, the run stops.
- **Nothing can attach mid-check.** Each candidate is re-checked inside its own transaction under `SELECT … FOR UPDATE`. Bills, expenses and work evidence take the same lock to attach. Any new referencing row needs a `KEY SHARE` lock, which conflicts with it. So a concurrent attach either:
  - commits first, and the document is then seen as attached and kept; or
  - waits until the delete commits, and then fails on its foreign key.
- **The foreign keys are a last line.** They refuse deleting a referenced row.
- **Order of deletion:** the row and its audit event commit first, and only then is the storage object deleted (with retries). A failure can therefore never leave a row pointing at a missing file, which could be attached later as empty evidence. If the object delete still fails, the file stays private but unreachable. The run reports it as `objectsLeft` and exits 1; the private document_delete_retries outbox retains the key for the next run. The outbox entry commits atomically with the row deletion and audit, so crashes after commit also retry safely. Successful storage deletion removes its outbox entry. Each run retries at most 500 pending objects, then handles at most 500 unattached documents.

## Retention (#62)

An unattached upload was never part of a business record: no expense, bill, invoice or job evidence refers to it. Deleting it doesn't conflict with record retention. Documents that are attached fall under #62's retention rules and are never touched by this job.


## Least-privilege staging job (#170)

The migration installs a narrowly scoped lock function and a durable deletion outbox. The deployment role script applies maintenance-role.sql, which grants SELECT/DELETE on documents, SELECT/INSERT on audit_events, access to the private outbox, and SELECT of only company/FK columns on referencing tables. It grants no employee rate access or document UPDATE. A SECURITY DEFINER function, executable only by maintenance, takes the attachment lock without granting UPDATE. Fixed search_path and bound IDs protect this helper.

Set MAINTENANCE_DATABASE_PASSWORD in migrate.env to create/rotate the dedicated login, then configure maintenance.env from its example. Use an independent storage credential with DeleteObject only. Install jobflow-document-cleanup.service/timer like the backup timer; it runs daily at 03:15 Sydney. The Compose maintenance profile runs inside the database network using the backup/tool image rebuilt on every deploy, with read-only filesystem, dropped capabilities and no published ports. A dry run is:

```sh
docker compose -f infra/staging/compose.yml --env-file infra/staging/env/compose.env --profile maintenance run --rm maintenance pnpm --silent documents:cleanup --dry-run
```

The private outbox contains storage keys and is intentionally inaccessible to the web role. Company export implementations must exclude internal maintenance tables/keys. Bucket versioning with a short noncurrent expiry is recommended for the operator to evaluate; enabling it and deploying the timer are owner actions. The local integration suite exercises a separate maintenance login, web-role denials and a failed deletion retried after the document row is gone; no real staging run is claimed.
