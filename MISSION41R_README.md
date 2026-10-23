# Mission 41R: anonymous review summary of the final 41K scan state (offline, read-only)

Not run on real data. Tested with synthetic fixtures only (`node --test tests/mission41*.test.cjs`, 135 pass).
No network, no upload, no paid API. No source file, state, manifest or tar is changed. All gates stay false and `uploadAllowed` is always `false`.

## One command (Windows PowerShell 5.1, repository root)
```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools\mission41r-review.ps1
```
Uses the newest `livecity-plan-*` under TEMP. Options: `-Plan <folder>`, `-MaxIds 12` (0..50), `-WriteDir <NEW folder>` (saves `review-summary.json`),
`-Shape -Roots ".."` (reads local files to label phone-like hits; candidate labels only; capped at 500 files). Without `-Shape` no file content is read.

## What it prints (counts, detector types, categories, extensions, byte sums, capped anonymous ids only)
- progress ("reached" = looked at, not reviewed) and `byStatus`
- findings cohorts: kind (secret / personal / mixed), detector type, detector combination, category, extension, category x detector, hit-count bucket
- (with `-Shape`) shape class of phone-like hits: `inside-uuid-like-id-only`, `id-or-numeric-shape-only`, `contact-key-or-free-text-present`. A label never clears a file.
- `holdDistinction`: `e6b68bd7` (owner HOLD, always) and `a0d64b19` (UUID-shape candidate: label only, still HOLD) are reported separately
- `priorityReview`: at most `-MaxIds` anonymous ids (default 12). Order: owner HOLD, secret-kind, the UUID-shape candidate, contact-key/free-text, then fewest hits
- `unscanned` cohort (always HOLD / needs review): by reason (`binary-format-not-inspected`, `binary-content`, `archive-not-opened`, ...), file type, extension, size bucket, byte sums.
  Archives are never extracted. GLB: only the JSON chunk can be inspected (`tools\mission41l-triage.ps1 -Mode GlbMeta`); the BIN chunk is not safe.
  OneDrive cloud-only handling is not inferred: only the recorded reason is counted.
- `notApproved`: `scanned-no-pattern` files are NOT approved and NOT reviewed.
- `sanitizePlan.autoApply:false` (the owner HOLD file has 335 contact-key string values: 116 match the phone regex, the other 219 do not look like phone numbers; a derived copy blanking all 335 is not approved and never generated automatically) and `licenceLedger.approved:false` (separate manual gate).

Never printed: values, JSON key names, paths, file names, surrounding context. A detection count does not say real vs false positive (`verdict: none`).
