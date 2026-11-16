# Mission 41H: pre-transfer gates (offline, nothing is uploaded)

Tested only with synthetic fixtures in CI (66/66 `tests/mission41*.test.cjs`). NOT run on the owner's real data or under PowerShell 5.1. No gate is opened by any tool here; `readyToUpload` stays false.

## 1. 41F: pack, then verify, in one command
```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools\mission41f-pack-local.ps1
```
After a successful pack it now prints an anonymous `SUMMARY` (tar count, source file count, bytes, SHA-256 per tar) and re-verifies every tar (size, SHA-256, tar structure) before exit. Re-check later without any source data:
```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools\mission41f-pack-local.ps1 -VerifyOnly -OutDir "<41F output folder>"
```
Unreadable sources (OneDrive cloud-only file, lock, I/O error) stop the run: the partial tar goes to `quarantine`, nothing is finalised, and the message shows only the error code and a hint (no path). Fix: set the folder to "Always keep on this device" and rerun; verified tars are not rewritten.

## 2. Secret candidates: anonymous report
Run 41C `mission41c-secrets.ps1` first (existing), then:
```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools\mission41h-gates.ps1 -Action secrets-summary -Review "<report folder>\secret-review.json"
```
Prints ids, extension, category, "under served public/ folder", verdict types, and required actions. No values, no paths, no fingerprints. Paste that text only.

## 3. Licence / provenance ledger
```powershell
... -File tools\mission41h-gates.ps1 -Action licence-ledger -Ledger "$env:TEMP\livecity-licence-ledger.json"   # template, all approved:false
... -File tools\mission41h-gates.ps1 -Action licence-check  -Ledger "$env:TEMP\livecity-licence-ledger.json"   # exit 2 until complete
```
One entry per manifest category. Fill `source`, `licence`, `redistributionAllowed` (true only if the primary source allows it), `attribution`, `approvedBy`, `approvedOn`, `approved` by hand from the primary source. Photos, PLATEAU originals, OSM-derived data and backups need separate decisions (ODbL needs attribution; PLATEAU terms are still unconfirmed in this repo). Do not guess.

## 4. Existing backups: key-like names and duplicates
```powershell
... -File tools\mission41h-gates.ps1 -Action zip-keys -Zip "<path to the backup zip>"
```
Reads only the zip central directory (zip64 OK, so the 8.4 GB zip is fine): counts key-like names (`.env*`, `*.pem/*.key`, credential/token names, `local-config.js`) and prints no names. Contents are not read. Treat every backup zip as secret-bearing until opened by the owner. Duplicates: existing `mission41c-hash.ps1` (>= 50 MB candidates, fingerprint then full sha256, resumable); nothing is dropped on name or size alone.

## 5. Status
```powershell
... -File tools\mission41h-gates.ps1 -Action gates-status -Ledger "<ledger>" -Review "<secret-review.json>"
```
`licenceApproved` can become true from a complete ledger; `noSecretsReviewed` and `noPersonalDataReviewed` are always false here and are decided by the owner outside these tools.

## Not done / still deferred
No upload, no private repo, no Release, no billing API. PLATEAU originals, backups, other and photos (75.62 GB total) stay in later phases via the deferred ledger.
