# Mission 45E - view the 24-ward local 3D Tiles (read-only, loopback)

One command (Windows PowerShell 5.1, repo root; nothing is re-converted):

    powershell -NoProfile -ExecutionPolicy Bypass -File tools\mission45e-preview.ps1

Defaults: output `%LOCALAPPDATA%\LiveCity-3DTiles-Out-24`, source `..\livecity-data-pipeline\public\map-data\osaka-city\buildings`
(`-LegacyBuildings`, `-OutRoot`, `-Port`, `-Plan` are available). It prints the verified summary, then
`open: http://127.0.0.1:8137/mission37g-osaka-24ward-mvp.html?ext45=1`. Pick wards in the left panel ("3D building ward"); one ward is mounted at a time.

## What it does
- Re-computes the 45D verify-only proof from the files on disk against the legacy source. Serves only if `complete`, 24/24 wards,
  `sourceBuildings === convertedBuildings`, 0 failures. `state.json` / `completion.json` are never trusted alone.
- Maps the 45D layout: `pc23/<ward>-aN` (23 wards, re-verified by 43G) and `sumiyoshi-aN/sumiyoshi` (nested) to `/ext-3dtiles/<ward>/...`.
  `/ext-3dtiles/index.json` lists the 24 wards (ids, codes, counts; no paths) so the URL stays short.
- Safety (inherited from 43G): 127.0.0.1 only, GET/HEAD only, Host/Origin must be loopback, whitelisted file kinds, regular files only,
  realpath must stay in the ward dir, links refused, no CORS headers. Refuses a OneDrive-synced root. Writes/deletes/copies nothing.
- Viewer (`?ext45=1`, localhost only): the full local set of a ward replaces the Git-tracked partial tileset (Sumiyoshi 9 tiles, 5 sample wards)
  for that ward and is not double-counted in coverage. `published.json` is untouched. Camera fit on ward select already exists (44A).

## Not claimed
- Data is local, but the page still loads CesiumJS (jsDelivr) and base-map tiles from external servers: this is NOT "zero network".
- Gates stay `licenceApproved/noSecretsReviewed/noPersonalDataReviewed=false`, `uploadAllowed=0`. No publication, Git add, artifact or Vercel.
- CI has no real 24-ward data. Tests use a synthetic 45D root. Actual 24-ward rendering is pending the owner's PC check:
  "24 wards displayed" only after switching all wards at the local URL.
- Browser (headless Chrome) rendering of this server was not run in this change.
