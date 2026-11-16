# Mission 41J: provenance candidates, pack leak check, review order (offline; no upload, no gate opened)

Tested only with synthetic fixtures (`tests/mission41j-provenance.test.cjs`). Not run on the owner's real data or under PowerShell 5.1.

## One command (PS5.1, repo root)
```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools\mission41j-review.ps1
```
With a 41B manifest and 41C `secret-review.json` (also runs the leak check):
```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools\mission41j-review.ps1 -Manifest "<manifest.json>" -Review "<secret-review.json>" [-AlsoReview "<other secret-review.json>"]
```
Output has no paths and no values. One new report file goes to `%TEMP%`.

## 1. Provenance candidates (`provenance`)
Reads repo text only (`config/datasets/*.json`, any `source.json`, README/MISSION*.md). Per family (PLATEAU, OSM, N03/CODH boundaries, e-Stat, Wikimedia, GSI tiles) it lists evidence file names and the licence strings the repo *claims*. Every family stays `owner-confirm-required`, `approved:false`, `redistributionAllowed:null`. Flags: multiple/conflicting claims, no explicit licence field. A claim written in the repo is not proof of a redistribution right. Mixed-origin derived categories (`3dtiles-output`, `building-tiles` incl. OSM-fallback tiles, `photo-index`, `facilities`) are listed so they are not approved as one block.

## 2. Use scopes (`scopes`)
| scope | licence | personal data | secrets |
|---|---|---|---|
| private GitHub storage | weaker, but source terms may forbid re-hosting | stored on GitHub: exclude/redact first | never, even privately |
| Claude Code viewing | like private; content goes to the model provider | readable and can be echoed into comments | readable by agent/logs |
| public web | redistribution + attribution confirmed per family (PLATEAU unconfirmed) | none allowed | only restricted browser keys |
Informational, not legal advice.

## 3. Leak check (`leak-check`)
Matches every manifest file to 41C ids (`sha256(root:rel)`), plus secret-like names, `local-config.js`, notes/memo/key-named files. Exit 2 and ids only if found. Gaps it states: contents of packed files are not scanned; a review made on other roots cannot flag files from roots it did not list. The key found by 41C in a *different* local root is covered only if that root was in the 41C run and the same root is in the pack; run 41C over every root 41B/41F packs, then `-AlsoReview` for each report.
Gates `noSecretsReviewed`, `noPersonalDataReviewed`, `readyToUpload` are always false here.

## 4. Order, one step at a time
1. `exposure-check` (41I): done, no exposure in git. Not covered: zips, screenshots, manual deploys, Cloud Console restrictions (unconfirmed).
2. Google key `063c5d34`: owner checks referrer + API restrictions; rotate if the folder/zip was ever shared. Then fill the 41I review ledger entry (ids only).
3. E-mail `4f661142`: owner opens it locally, classifies, decides.
4. `mission41j-review.ps1 -Manifest ... -Review ...` until `leaks: 0`.
5. 41H `licence-ledger`, fill per family from primary sources using the section 1 candidates; `licence-check`.
6. Photos / backups stay held (`photos-unverified-rights`, `backup-archive`); the 75.62 GB goal is staged by category, never in one step.
No data upload, repo creation, paid API, main/production change or public deployment is performed by any of these tools.
