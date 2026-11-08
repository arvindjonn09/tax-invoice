# PDF test fixtures (#136)

Synthetic files for the real-clamd contract tests (`tests/unit/clamd-contract.test.ts`).

`password-protected.pdf` is the one-page `plainPdf()` from `tests/helpers/pdf-fixtures.ts`, encrypted once with qpdf
(AES-256, non-empty user password). Its passwords are throwaway test values, not secrets:

```sh
# plain.pdf: write plainPdf() to a file first
qpdf --encrypt synthetic-user-pass synthetic-owner-pass 256 -- plain.pdf password-protected.pdf
pdfinfo password-protected.pdf        # "Incorrect password": it can't be opened without one
```

It's committed as a binary so the tests contain no password-hashing code (CodeQL `js/insufficient-password-hash`).
