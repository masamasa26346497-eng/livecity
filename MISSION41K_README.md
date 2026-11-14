# Mission 41K: read-only content scan of manifest files (offline; no upload, no gate opened)

Tested only with synthetic fixtures (`tests/mission41k-content-scan.test.cjs`). Not run on the owner's real data or under PowerShell 5.1.

## One command (PS5.1, repo root; newest `%TEMP%\livecity-plan-*\manifest.json` is picked automatically, root `..` = the single LiveCity folder as in 41A/41F)
Stage 1, the `fukushima` subset:
```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools\mission41k-content-scan.ps1
```
Stage 2, all manifest files, resumable (run again to continue; `-MaxFiles 5000` / `-MaxSeconds 1800` work in slices):
```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools\mission41k-content-scan.ps1 -Stage All
```
Exit/summary: detections -> review ids; unscanned remain -> not safe.

## Behaviour
- Streaming 1 MiB chunks (4 KiB overlap, boundary matches counted once); files over 512 MiB are `over-size-limit` (unscanned).
- State file next to the manifest: ids, size, mtime, detector counts. No paths, content or values. Unchanged files are skipped on re-run.
- OneDrive cloud-only files are listed by attribute and never opened (opening would download them) -> `cloud-only-not-read`. Unreadable files -> `unreadable-or-cloud-only`.
- glb/pbf/zip/images/etc., archives and NUL-containing files -> `unscanned` with a reason. Zip contents are not opened. Never reported as safe.
- Detectors: Google API key, GitHub token, AWS key, OpenAI/Anthropic-style key, Slack token, Bearer, JWT, PEM private key, credential assignment, e-mail, JP phone. E-mail and phone matches include false positives (e.g. public OSM contact fields); each needs a human decision.
- Output: anonymous id (same `sha256(root:rel)` 8-hex as 41C/41J), category, extension, detector name, counts. No path, snippet, value or value fingerprint. `lookup --id` prints one path locally on request only.
- Independent of the 41J leak-check. `noSecretsReviewed`, `noPersonalDataReviewed`, `readyToUpload` are always false.
- Provenance: per category, origin candidates (PLATEAU / OSM / N03 / e-Stat / Wikimedia / GSI) from path and file header hints, `mixedOrigin` flag; always `owner-confirm-required`, `approved:false`. Not a licence approval; confirm from primary sources (41H ledger).
- Files held out of the 41B manifest (backups, secrets candidates) are not covered.
- No data transfer, repo creation, paid API, main or production change.
