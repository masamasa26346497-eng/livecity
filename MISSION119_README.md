# Mission 119: 24-ward readiness matrix (buildings 2025 + layers v1/v2)

A READ-ONLY check of what the combined server (Mission 116/118) can actually serve per ward. It is not a browser acceptance.

## What the CI runner could and could not do
* Could: code, synthetic-fixture HTTP integration tests (loopback), `node --test` (30 tests pass across 116/117/118/119).
* Could not: the private building Releases, the owner's 24-ward layers and WebGL rendering are not available here. No Release was downloaded, nothing was converted or re-audited.
* Therefore real wards rendered in a browser are unchanged from Mission 118 (nishi, fukushima, yodogawa observed by the owner; the other 21 UNVERIFIED). Buildings+layers simultaneous WebGL is UNVERIFIED.

## Owner PC: one command (PowerShell 5.1, repo root; writes nothing)
```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools\mission116\combined-run.ps1 -Mode readiness -BuildingsRoot "temp\mission114\root" -LayersRoot "$env:LOCALAPPDATA\LiveCity-MapLayers-Out-24" -SupplementalLayersRoot "$env:LOCALAPPDATA\LiveCity-MapLayers-Out-24-v2"
```
Output: one line per ward (`both-servable` / `buildings-only` / `layers-only(not served)` / `neither`, tile count, layer source and clipVersion, water LINE vs AREA counts), then a JSON summary. Exit 1 on `CLIP-V2-VIOLATION` (v2 ward with vertices outside the bbox) or `HTTP-FAIL`.
Wards that are `buildings-only` / `neither` have no 2025 building archive in the root: restore them from the Release first (the only blocker for the other wards' buildings). Then use `-Mode serve` (same roots) and open the printed URL.
