# Mission 114 - 24-ward incremental local view + road/water gap explanation

## Cause of "orange road line only in part of a ward / water as blue lines only"
- Orange (#c8801a) = layer `gsiroadedge`; blue faces = `gsiwater`. Both load **fixed GSI windows** only (sumiyoshi 9-tile, kita sample, okawa/nakanoshima, sumiyoshi 57).
- The 2025 private archives carry **no `layers/`** (Mission108/109), so nothing else draws roads/water for those wards. Nothing is shifted: buildings and windows share `znorth-neg-v1`.
- `node tools/mission114/layer-coverage.cjs` -> `data/reports/mission114/layer-coverage.json`: share of N03 ward area inside a window. Road: nishi 13.3%, fukushima 3.6%, yodogawa 0.2%; no ward is fully covered (0/24).
- Viewer now states "outside the window = not delivered" in the layer note (`stats.vecCoverage.gsiRoadEdgeInWindow / gsiWaterInWindow`). No dummy data.

## Next real fix (needs data, not code)
Roads/water for a ward need a per-ward `layers/` (from the owner's `livecity-data-pipeline`: `tools/mission40g-build-ward-layers.cjs --check-only`, then export as a separate private asset). Until then they stay `unverified`.

## Owner PC, incremental 24 wards (PowerShell, Node 24, non-ASCII paths OK)
```powershell
$env:LIVECITY_3D_DATA_TOKEN = Read-Host "token"
node tools\mission114\local-run.mjs --wards nishi,fukushima,yodogawa   # same as Mission108
node tools\mission114\local-run.mjs --wards ALL --batch 3              # downloads only wards missing under temp\mission114\root
node tools\mission114\local-run.mjs --reuse --wards ALL                # no token; serves existing wards
```
Existing wards are never touched; verified new wards are moved in only if absent. Token never reaches the server process.

## Evidence status
`data/reports/mission114/owner-device-observed.json`: screenshot-only; ownerDeviceAccepted 0/24, browserCiAccepted 0/24.
