# Mission 41N: HOLD handling for one transfer candidate (offline, read-only)

Not run on real data. Tested with synthetic fixtures only (`node --test tests/mission41*.test.cjs`).
No network, no upload. No source file is changed, moved or deleted. No existing tar is touched. All gates stay false.

## Context
41M field triage of the file with id `e6b68bd7` (boundaries/json) returned `HOLD`: 116 phone-pattern matches, all under contact-like keys,
including mobile/050 prefixes. Source-metadata keys exist (`keyOccurrences`) but not at top level; this is NOT licence approval.
Decision (owner): keep the original data untouched, hold this one id back from the transfer candidates, and plan an optional sanitized derived copy.

## 1. Hold the id (dry-run, then an ids-only plan)
```powershell
# anonymous impact: category/ext/size, totals before/after, affected part, tar-name effect; writes nothing
powershell -NoProfile -ExecutionPolicy Bypass -File tools\mission41n-exclude.ps1
# also look inside your existing 41F tars (headers only; tar names and member names are not printed)
powershell -NoProfile -ExecutionPolicy Bypass -File tools\mission41n-exclude.ps1 -TarDir "D:\path\to\41f-out"
# write a NEW ids-only plan into a NEW folder
powershell -NoProfile -ExecutionPolicy Bypass -File tools\mission41n-exclude.ps1 -WritePlanDir "..\livecity-exclusion-plan"
```
- Default `-Id` is `e6b68bd7`; any 8-hex id (or a comma list) works.
- `existingTars.mustRepackCount > 0` means that tar contains the held file: it must be re-created with
  `node tools\mission41f-pack-local.cjs create ... --exclude-plan <exclusion-plan.json> --out <NEW folder>`.
  The old tar is never modified or deleted by any tool; remove it yourself only after the new one is verified.
- With `--exclude-plan`, 41F leaves the id out. The affected part becomes a subset, so its asset name is `...-subset-<sig>.tar`
  (the full-part name is no longer produced). 41F prints `by exclusion plan: N files`.
- Holding one id reviews nothing else. Other detected files (41K findings: phone/e-mail) and the unscanned binaries (GLB etc.) stay
  unreviewed; `licenceApproved`, `noSecretsReviewed`, `noPersonalDataReviewed`, `readyToUpload` remain false.

## 2. Optional sanitized derived copy (design; real-data generation NOT available yet)
`createSanitizedCopy()` in `tools/mission41n-exclude.cjs` is fixture-tested but is **not reachable from the CLI**, and requires an explicit
`ownerApproved: true` argument. Design:
1. Source is only read. Destination must be a new/empty folder outside the source folder; files are created with `wx` (never overwritten).
2. Every STRING under a contact-like key is blanked to `""` (whole value; no partial edits). Nothing else changes.
   Public facility numbers cannot be told from personal ones automatically, so they are blanked too.
3. In-memory verification before anything is written: same key order and types, same array lengths (feature count), coordinates/geometry
   identical, ids identical, source/licence/attribution metadata identical, every contact value blank, phone-pattern matches after = 0.
4. Refused (nothing written) if a phone-like value sits under a non-contact key (unknown purpose), or a contact key holds an object/array/number.
5. `DERIVED-FROM-SOURCE.json` records counts and `licence: {inheritedFromSource: true, approved: false}`. The derived copy inherits the
   source licence/attribution; the owner must still verify them.

Read-only preview on your PC (parses the file, runs sanitize + verify in memory, writes nothing, prints counts only):
```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools\mission41n-exclude.ps1 -Mode SanitizePlan -Roots ".."
```
Look at: `wouldBlankValues`, `wouldBlankWithoutPhonePattern`, `unsupportedContactStructures`, `matchesAfterInMemory` (must be 0), `verification.passed`.
Generating the copy needs your explicit approval in a later mission.
