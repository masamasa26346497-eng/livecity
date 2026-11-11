# Mission 41U: anonymous review queue, owner decision ledger (design), clearer 41T metrics

Not run on real data. Synthetic fixtures only (`node --test tests/mission41*.test.cjs`). Offline, read-only by default, no network, no upload, no paid API.
`uploadAllowed=false`, `eligibleForPackOrUpload=0`, `autoApproved=false`, `autoExcluded=false`, `sanitizePlanApproved=false`, `decisionsAffectGate=false`.

## One command (read-only)
```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools\mission41s-triage.ps1 -Mode review-ledger -ProgressFile ..\41s-progress.json
```

## Review queue (cohorts)
- A `embedded-text-high-priority`: `contact-key-embedded-text` (expected 9). Look first.
- B `whole-value-source-license-pending`: `contact-key-whole-value` (expected 63). Public or not depends on source and licence, both unconfirmed.
- C `id-shaped-recheck`: `idish-only` (expected 1). Recheck, do not dismiss.
- D `other-review`: anything else.
Per cohort: file count, facility/boundary split, extension split, bucketed counts, and only a *possibility* of duplicates (several files with an identical size; no content hash). At most 12 anonymous ids per cohort.
The phone format and the key name cannot tell a company number from a personal number. Nothing is concluded.

## Owner decision ledger (local only, on request)
- Nothing is created unless you pass `-InitDecisions <file>` yourself. The file must be outside the repo and outside any git work tree; an existing file is never overwritten (`wx`).
- It holds anonymous ids and `undecided` only. Allowed notes: `undecided, keep-hold, needs-recheck, owner-note-public-business-number, owner-note-personal-or-unsure, owner-note-not-a-phone`.
- `-DecisionsFile <file>` makes the summary print decision *counts*. A decision never changes a gate; removal or masking of any data is a separate step needing its own approval.
- Never commit, push or paste that file.

## 41T metric fix
`hitsBucket:0` on `jsonl:idish-only` meant "no NON-id phone candidates", not "the matcher found nothing". Each id now also has `nonIdPhoneCandidateBucket`, `idShapedStringBucket`, `rawPhoneMatchesBucket` and `rawPhoneMatchesZero`. `hitsBucket` is kept as the legacy name of the first one; `metricMeaning` explains it.
JSONL streaming now splits on the 0x0A byte and decodes each whole line as UTF-8. Before, a latin1 decode garbled non-ASCII key names, so a Japanese contact-like key (for example the one meaning "telephone") could be filed as a non-contact key. Bounded memory (1 MiB chunk, 4 MiB line cap, time cap) is unchanged. Whether the earlier real-data class counts would change is unknown until re-run.

## Still open (all HOLD, unreviewed)
All phone/email/credential findings outside this queue, 269 unscanned files, scanned-no-pattern files, source and licence families, and the bulk contact-key clean-up plan. `openItems` in the output is recomputed from the scan state, not typed in.
