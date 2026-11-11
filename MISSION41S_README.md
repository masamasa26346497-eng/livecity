# Mission 41S: anonymous triage of 41R findings (offline, read-only)

Not run on real data. Synthetic fixtures only (`node --test tests/mission41*.test.cjs`).
No network, no upload, no paid API. Source files, manifest and scan state are never changed. `uploadAllowed` is always `false`; nothing is auto-approved or auto-excluded.

## 1. Classify the credential-assignment candidates (3 files)
```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools\mission41s-triage.ps1 -Mode credential
```
Targets are resolved internally from the newest `livecity-plan-*` manifest + 41K state (every file with a `credential-assignment` finding). `-Ids a,b` narrows it.
Per id it prints only: id, detector, manifest category, extension, hit-count buckets, other detectors in the same file, and a coarse value shape:
`placeholder-shaped`, `reference-shaped` (template / env reference), `random-shaped-candidate`, or `unknown` (default when there is no basis).
Never printed: value, any part of a value, hash, key name, environment variable, path, file name or context. A shape label is not a verdict and never approves; all items stay HOLD.
`ownerGuidance` lists what to do only if you decide a value is a real key (restrict / rotate at the provider, check usage logs, clean local copies). The tool performs none of it.

## 2. Group the phone-regex candidates (building-tiles etc.)
```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools\mission41s-triage.ps1 -Mode phone-groups -ProgressFile ..\41s-progress.json
```
Reads files locally, `-Max 500` per run (same cap as 41R `-Shape`). Re-run with the same `-ProgressFile` to continue; it stores only `anonymous id -> class`.
Classes: `uuid-shape-only`, `id-or-numeric`, `free-text/contact` (needs a human look), `unreadable` (plus `binary-not-classified`, `over-128MiB-not-classified`, `root-not-given`).
Counts by class / category / extension / category x extension x class. An apparent false positive is not a transfer approval.

## 3. Unscanned files
Always HOLD. GLB: JSON chunk only (41L `-Mode GlbMeta`). Office (xlsx etc.) and archives: never expanded. Other binaries: never auto-approved. Public-data re-fetch is a separate phase.

## 4. 41R wording fix
`sanitizePlan.note` said "335 phone-shaped values". Correct: 335 contact-key string values, of which 116 match the phone regex; the other 219 do not look like phone numbers. A derived copy blanking all 335 is not approved and not generated automatically.
