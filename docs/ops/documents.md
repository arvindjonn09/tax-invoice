# Unattached uploads (#137)

A document is uploaded first and attached second: to an expense receipt, a supplier bill, a work-evidence photo and so on. Sometimes the second step never happens. A form gets abandoned, an attach fails, or the evidence type is switched to a note (#129). Without cleanup, those files would stay in private storage forever: only the uploader could link them, and the office couldn't see them.

**Rule:** a document that **nothing references** and that **no audit event names** (other than its own upload) is deleted once it is **older than 7 days**. A receipt swapped out of a submitted expense is named in that expense's audit history, so it is kept as evidence of what was submitted. Each deletion writes a `document.unattached_deleted` audit event. The event records the document's kind, size, upload time and the grace period, and is attributed to the uploader. It never records the file name or storage key.

## Command

```sh
pnpm documents:cleanup --dry-run       # counts only, deletes nothing
pnpm documents:cleanup                 # delete (default grace period: 7 days)
pnpm documents:cleanup --grace-days 14
```

- **Settings:** it uses the app's `DATABASE_URL` and document storage settings.
- **Output:** a single JSON line with counts: deleted, bytes, skipped and failed. It never prints file names, keys or connection details.
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
- **Order of deletion:** the storage object is deleted first, then the row. If the row delete fails, the next run finds the row again, and deleting a missing object does nothing. The reverse order could leave a private file that nothing points to.

## Retention (#62)

An unattached upload was never part of a business record: no expense, bill, invoice or job evidence refers to it. Deleting it doesn't conflict with record retention. Documents that are attached fall under #62's retention rules and are never touched by this job.
