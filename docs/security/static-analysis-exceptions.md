# Static-analysis exceptions

The CI gate (`scripts/check-sarif.mjs`) fails on every CodeQL finding except those listed in
`.github/codeql-exceptions.json`. Each exception binds **one rule to one file**, records the reason and the
owner's approval, and is reviewed here. Adding one is an owner checkpoint (AGENTS.md security exceptions).

| Rule | File | Why it is safe | Approved |
|---|---|---|---|
| `js/insufficient-password-hash` | `apps/web/src/server/security/pwned.ts` | The Pwned Passwords range API (k-anonymity) requires SHA-1. The digest is never stored or used for authentication; only its first 5 hex characters leave the server. Passwords are stored with scrypt (ADR 0003). | Owner, 3 Nov 2026 (#217) |

The matching GitHub code-scanning alert is dismissed as a false positive with the same reason.
