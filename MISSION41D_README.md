# Mission 41D: offline pack dry-run / verify (no upload)

Read-only and offline. Nothing is copied, moved, deleted or uploaded. Real data was NOT available to the CI; only synthetic fixtures were tested.

## Flow on the PC (Windows PowerShell 5.1, repo root)
1. `tools\mission41c-quick.ps1` (existing) -> prints anonymous summary and writes `manifest.json`, `deferred-ledger.json` under `%TEMP%\livecity-plan-*`.
2. Dry-run of the pack (checks every listed file; first small transfer = Fukushima):
```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools\mission41d-pack.ps1 -Manifest "$env:TEMP\livecity-plan-XXXX\manifest.json" -Roots "..\livecity-data-pipeline;..\livecity-3dtiles-out-fukushima" -PathContains fukushima
```
Root folder names must equal the root names in the inventory. Japanese paths are passed via a UTF-8 JSON file, not the command line.
3. After parts exist (future step): `... -Verify -PartsDir <dir>`.

## What the dry-run checks
relative-path only (no `..`, absolute, backslash, NUL, `./`, `//`, non-NFC, >255 bytes), duplicates and case collisions, symlinks refused (lstat), real path stays inside root, file exists and size equals manifest, tar size estimate (512-byte headers) under 1.5 GiB and always < 2 GiB, free disk for ONE part at a time (build, hash, upload, delete), `--out` outside every root. Report ids are hashes, no paths.

## Verify
missing / extra / truncated (not a 512 multiple) / sha256 mismatch / duplicate parts / >= 2 GiB; hashes are cached by size+mtime so a rerun resumes.

## Gates (all closed by default; `readyToUpload` is always false in 41D)
licence ledger approved per part, secrets reviewed (41C `mission41c-secrets.ps1`), personal data reviewed. `upload` exists but is disabled: it needs `--confirm-upload I-APPROVE-PRIVATE-UPLOAD` AND env `LIVECITY_UPLOAD_APPROVED=yes-i-approved-this-exact-manifest-<sha256 of manifest.json>`, and even then only prints that the uploader is not implemented.

## Nothing is dropped
Deferred categories (raw PLATEAU, DEM, backup zips, photos, other) stay on `deferred-ledger.json` with a phase; release them with `-Include` in 41C. Secret-bearing items and backup zips stay in review until opened and cleaned.

## CI
`node --test tests/mission41d-pack.test.cjs` parses the ps1 with Linux `pwsh` when present. That is a syntax parse by PowerShell 7, NOT a run under Windows PowerShell 5.1.
