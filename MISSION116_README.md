# Mission 116 - 2025 private buildings + 24-ward road/water/park/rail layers in ONE local viewer

## Status (honest)
- **Layers generated from real data: 0/24.** The old OSM tiles (`livecity-data-pipeline/public/map-data/osaka-city/{roads,waterways,parks,railways}`) exist only on the owner PC.
  They are not in this repo (git-ignored), not in the private 2025 release (which has no `layers/`), and not reachable from GitHub Actions. Nothing was generated or invented here.
- **Built and tested here (synthetic fixtures only):** `tools/mission116/combined-server.cjs` + `combined-run.ps1`; `-Wards ALL` listing 24 wards; audit readiness summary.
- Not done: browser render of buildings + layers together, owner-PC run. License: OSM (ODbL) derived layers stay local/private; 2025 buildings stay private.

## Why a new server
`mission45e-preview` needs a 45D (legacy pc23) proof and serves only those buildings, so the 2025 private buildings would drop out.
`mission40f-serve-local` serves buildings but has no layers mapping. The combined server serves, from one origin and port:
- `/ext-3dtiles/<ward>25/{tileset.json,tiles,ids,attrs,...}` from `--buildings-root` (2025 archives, e.g. `temp\mission114\root`)
- `/ext-3dtiles/<ward>25/layers/{roads,waterways,parks,railways,labels,layers-report}.json` from `<layers-root>\<ward>\layers\` (45I output)
- `/ext-3dtiles/index.json` (wards, layersWards) and `public/` for the viewer page.
The viewer is unchanged (`?ext=nishi25,...` already derives the layer URL from the building base). 127.0.0.1 only, GET/HEAD, loopback Host/Origin, whitelisted files,
no links, no writes. Layers root must be outside the repo and OneDrive and carry the 45I marker; buildings root must not be under `public/`. Busy port: next free port is used.

## Owner PC: shortest steps (PowerShell 5.1, Node 24, non-ASCII/OneDrive paths OK)
Repo root. Buildings: fetch with Mission 114 first (token needed only for wards not yet downloaded):
```powershell
$env:LIVECITY_3D_DATA_TOKEN = Read-Host "read-only token"
node tools\mission114\local-run.mjs --wards ALL        # incremental; Ctrl+C after it starts serving, or use --reuse later
```
1. **Audit** (reads the source only, writes nothing):
```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools\mission116\combined-run.ps1 -Mode audit -Wards ALL -Src "..\livecity-data-pipeline\public\map-data\osaka-city"
```
   Look at `summary.ready` (source exists), `roadsOnly`, `noSource` (with reason). `ready` is not "generated".
2. **Build + verify**, first 3 wards, then all (existing ward layers are skipped, never overwritten; output `%LOCALAPPDATA%\LiveCity-MapLayers-Out-24`):
```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools\mission116\combined-run.ps1 -Mode build -Src "..\livecity-data-pipeline\public\map-data\osaka-city"
powershell -NoProfile -ExecutionPolicy Bypass -File tools\mission116\combined-run.ps1 -Mode build -Wards ALL -Src "..\livecity-data-pipeline\public\map-data\osaka-city"
```
   Re-run only missing wards with `-Wards a,b`. `verify` checks: convention `znorth-neg-v1`, constants CLAT 34.604208 / CLON 135.52502 / MPD 111320, non-finite coordinates,
   % vertices outside the ward bbox, N03-polygon road/water cell coverage. Best state is `generated-unverified-visually`.
3. **Combined preview** (2025 buildings + layers; default buildings root `temp\mission114\root`, override with `-BuildingsRoot`):
```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools\mission116\combined-run.ps1 -Mode serve -Wards ALL
```
   It prints the URL (`...?ext=<ward>25,...`). Select the ward in the left "3D buildings ward" selector; check `__mission37g.stats.wardVec` (`state:'ready'` + counts) and compare roads with buildings.
   `-Mode all` runs 1 -> 2 -> 3 -> serve in order. Wards with buildings but no layers show buildings only; the server prints which.
Old pc23 data is never read as buildings.
