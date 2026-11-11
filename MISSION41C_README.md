# Mission 41C: use the 41A inventory result, no PC rescan

Everything here is read-only and offline. Nothing is uploaded, copied, moved or deleted. Do not paste file paths or secret values into GitHub.

## 1. One line: anonymous summary + dry-run plan (no rescan)
From the repository root (PowerShell 5.1):
```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools\mission41c-quick.ps1
```
It finds the newest `%TEMP%\livecity-inventory-*\inventory.json` itself. Paste only the text it prints (categories, counts, plan validation, deferred list). To use a specific file add `-Inventory "<path>\inventory.json"`.

## 2. What changed in classification
| archive kind | old | new |
|---|---|---|
| `LiveCity-full-backup.zip`, `livecity-data-pipeline (3).zip`, names with backup/full/copy/`(n)` | plateau-raw | **backup-archive** (deferred, review) |
| FG-GML / DEM archives and `.gml/.xml` | plateau-raw | **dem-raw** (deferred) |
| name contains plateau/citygml/bldg/udx/27100... | plateau-raw | plateau-raw (deferred) |
| any other archive | plateau-raw | **archive-review** (owner says what it is) |

Name-based only. The existing `inventory.json` is re-classified on load (`reclassify`), so no rescan is needed. Photos, secrets and the rest are unchanged.

## 3. "Move everything": nothing is dropped for good
Held categories are **deferred to a later phase**, listed with files/bytes/phase in `deferred-ledger.json`:
`plateau-raw`, `dem-raw` (raw phase 2), `photos-unverified-rights` (photos phase 3), `backup-archive`, `archive-review`, `other` (review phase 2).
To plan them as well (still `approved:false` until the licence ledger is filled):
```powershell
... -File tools\mission41c-quick.ps1 -Include "plateau-raw,dem-raw,photos-unverified-rights"
```
Only `secrets-candidate` and cache folders cannot be released by `-Include` (secrets are cleaned file by file first). A single file over the part limit is still reported as `unsplittable` and needs byte chunking before upload (e.g. the 8.43 GB zip).

## 4. Optional: confirm duplicates cheaply (only >= 50 MB candidates)
1011 size-only candidates are not proof. This hashes only candidate groups >= 50 MB, in two stages (first/last 1 MiB fingerprint, then full sha256 only if fingerprints still match). Resumable cache; read-only.
```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools\mission41c-hash.ps1 -Roots ".." -MaxGB 40
powershell -NoProfile -ExecutionPolicy Bypass -File tools\mission41c-quick.ps1 -Hashes "$env:TEMP\livecity-hashes.json"
```
`-Roots` must be the same value you gave `mission41a-inventory.ps1`. Rerun to continue after `-MaxGB`. Groups with any un-hashed member stay "unconfirmed" and are never dropped. The 4.15 GB `(3)`/`(4)` zips cost one full read only if their fingerprints match; expect disk-speed time (roughly 1 GiB per few seconds on SSD, much slower on OneDrive placeholders - make sure files are "always keep on this device").

## 5. Secret candidates (`public/local-config.js` Google key, 4 x `.env.example`, 1 e-mail)
```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools\mission41c-secrets.ps1 -Roots ".."
```
Prints counts only. Per hit it records a verdict, never the value: `placeholder`, `looks-real`, `example-domain`, `personal-or-unknown-domain`, plus an 8-hex fingerprint and whether the file is under a served `public/` folder. `LOCAL-ONLY-id-to-path.json` maps ids to paths: keep it local.

How to read it:
- `.env.example` with `placeholder` or `example-domain` -> safe, it is a template (already tracked in the repo by design). Keep.
- `public/local-config.js` with `looks-real` -> a real Google key. In this repo that file is git-ignored (`/public/local-config.js`), so it is not on GitHub/Vercel unless it was uploaded by hand or by `vercel deploy` from your PC. Do this, in order, without pasting the key anywhere:
  1. Keep it out of every archive/upload (it stays in the secrets hold; 41B never plans it).
  2. In Google Cloud Console check the key has **HTTP referrer + API restrictions**. If you ever shared the folder, ZIP or screenshot, or if unsure, **rotate** it (create new, delete old) and put the new one only in the ignored file.
  3. Remember that any key in a browser file is visible to visitors: restriction, not secrecy, protects it. Billing-capable APIs stay disabled in this project (UI Kit `ENABLED=false`).
- The e-mail hit: `personal-or-unknown-domain` means a real address is in some file; decide whether that file may go to the private data repo. Never publish it.
- The zips (`LiveCity-full-backup.zip`, `(3)`, `(4)`) may contain `local-config.js` too. Treat them as **secret-bearing until opened**: they stay in `backup-archive` (deferred), not uploaded.

## 6. Not done
No upload, no private repo creation, no billing API. The uploader and licence approval are still pending owner approval. PowerShell 5.1 execution is not tested here (Linux CI); `.ps1` files are ASCII-only and checked by tests.
