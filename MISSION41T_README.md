# Mission 41T: anonymous sub-classification of the 72 `free-text/contact` files (offline, read-only)

Not run on real data. Synthetic fixtures only (`node --test tests/mission41*.test.cjs`). No network, no upload, no paid API.
Nothing is written: source files, manifest, scan state and the 41S progress file are only read. `uploadAllowed=false`, `eligibleForPackOrUpload=0`, `autoApproved=false`, `autoExcluded=false`.

## One command (after 41S phone-groups finished)
```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools\mission41s-triage.ps1 -Mode contact-subclass -ProgressFile ..\41s-progress.json
```
Uses the same newest `livecity-plan-*` as 41S. The progress file stays on your PC (never push or paste it).

## What it does
- Selects the ids whose 41S class is `free-text/contact` (72) or `over-128MiB-not-classified` (1). `uuid-shape-only` (1,235) is not touched.
- JSON: parsed only up to 64 MiB; walks string values; classes (highest-attention first): `noncontact-key-text`, `memo-key-text`, `noncontact-key-whole-value`, `contact-key-embedded-text`, `contact-key-whole-value`, `idish-only`; plus `json-parse-error`, `html-text`.
- JSONL (the >128 MiB file): streamed 1 MiB at a time, line by line (lines over 4 MiB skipped, not buffered), 600 s cap (`--max-seconds`). Never `readFileSync` or a whole-file parse. Output has line-count buckets only.
- Phone-prefix type buckets only (mobile / IP / freephone / landline-or-other). Nothing is concluded from them: a business number and a personal number are both left HOLD.
- Output: bucketed counts, class x category x extension tallies, and at most 12 anonymous ids (most attention-needing first). Never values, fragments, hashes, key names, context, file names or paths.
- Classes are labels for ordering your review, not verdicts. Binaries, archives and the 269 unscanned files are not read.

## Still open
1,235 uuid-shape-only, the 10 non-phone findings (7 email, 3 credential-assignment), 269 unscanned, source/licence gates: all HOLD, unreviewed.
