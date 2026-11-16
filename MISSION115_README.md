# Mission 115 - road / water layers for nishi, fukushima, yodogawa (owner PC)

Reuses Mission 45I (builder + `--layers-root` preview + `vecTick` in the 37G viewer). No new viewer code, no data, no network.
Roads/water come from the owner's OLD OSM tiles (`livecity-data-pipeline/public/map-data/osaka-city/{roads,waterways,parks,railways}`), written to a
private folder outside the repo and OneDrive, separate from the 2025 private building archives (which have no `layers/`).

## One command (PowerShell 5.1, Node 24, non-ASCII paths OK)
```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools\mission115\layers-run.ps1 -Src "..\livecity-data-pipeline\public\map-data\osaka-city"
# -AuditOnly: only counts source features per ward. -Wards a,b or ALL for more wards.
```
Then serve: `tools\mission45e-preview.ps1 -LayersRoot "$env:LOCALAPPDATA\LiveCity-MapLayers-Out-24"` -> `http://127.0.0.1:8137/mission37g-osaka-24ward-mvp.html?ext45=1`.
Existing ward `layers/` dirs are never overwritten; the 2025 building roots are not touched; the source is read-only.

## Numeric checks (`verify`, also run after `build`)
- Projection constants (CLAT 34.604208 / CLON 135.52502 / MPD 111320) equal in the 37G viewer and the legacy page (tested). No transform is changed and no building shift exists.
- Layer convention must be `znorth-neg-v1` (x east, z south-positive, metres); 45I additionally probes 8 axis/sign variants against the N03 polygon.
- Per ward: road/water feature counts, share of N03 ward 100 m cells touched by road/water vertices, % of vertices outside the ward bbox, non-finite coordinates. State is `generated-unverified-visually` at best.

## Owner QA after serving
Look at `__mission37g.stats.vec45i` (mounted wards, `lastError`), then compare roads against buildings in each ward and screenshot. Water edges and 1-3 m offsets can only be judged visually.

## Status (honest)
Not run on real data here (no access to the owner's tiles). served = false, browserRendered = false, ownerDeviceAccepted = 0/24. License: OSM (ODbL) - keep private/localhost until attribution and share-alike are handled.
Remaining 21 wards: same command with `-Wards ALL`; a ward without source tiles is reported `no-source-data`.
