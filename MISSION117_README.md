# Mission 117: chuo `check-failed` (818 / 15,712 = 5.21% outside the ward bbox)

## Cause (from the code; the real data was not available to the CI runner)
The 45I builder (`tools/mission45i-build-layers-24.cjs`, after 40G `readLayer`) produced vertices outside the ward bbox by design in two ways:
1. **Lines kept one outside neighbour vertex** (40G `clipLine` + 45I `clipRuns`, "so lines do not float at the edge"). The neighbour can be as far away as the next OSM node, i.e. a long segment.
2. **Water/park AREA rings were kept whole** if any vertex touched the box (never clipped). Rivers/moats around chuo (Yodogawa/Okawa side, Dotonbori etc.) are long polygons.

chuo is a narrow ward surrounded by rivers and 6+ neighbours, so it crosses 5% while the other 23 wards stay below. This is a hypothesis fitted to the code, **not confirmed on the owner's data**: run `diagnose` (below) on the existing output to see which one it is (`adjacentKeepVertex` vs `byLayerKind "waterways:area"`, `sides`, `maxOffsetM`, `crossWard`).

## Fix (no threshold change, no ward exception, same denominator)
* `tools/lib/mission117-clip.cjs`: lines are cut exactly at the ward polygon boundary (bisection); area rings are clipped to the ward clip box (Sutherland-Hodgman).
* 45I builder uses it and writes `clipVersion: 2`.
* Verifier: legacy output (no clipVersion) keeps the 5% rule unchanged; `clipVersion 2` output must have **0** vertices outside the bbox (1 m tolerance, counted, not rounded %).
* Not changed: constants CLAT/CLON/MPD, N03 polygons, the source, the existing output, buildings.
* Limitation: a line/area that crosses the ward without any vertex inside is still dropped (as before).

## Owner PC (PowerShell 5.1, repo root; existing output is never overwritten)
```powershell
git fetch origin
git merge --ff-only origin/claude/issue-23-20261007-1424
# 1) read-only diagnosis of the existing output (anonymous aggregates only)
powershell -NoProfile -ExecutionPolicy Bypass -File tools\mission116\combined-run.ps1 -Mode diagnose -Wards chuo -LayersRoot "$env:LOCALAPPDATA\LiveCity-MapLayers-Out-24"
# 2) regenerate chuo (or ALL) into a NEW root, then verify
powershell -NoProfile -ExecutionPolicy Bypass -File tools\mission116\combined-run.ps1 -Mode build -Wards chuo -Src "..\livecity-data-pipeline\public\map-data\osaka-city" -LayersRoot "$env:LOCALAPPDATA\LiveCity-MapLayers-Out-24-v2"
```
Use `-Wards ALL` for step 2 to re-check 24/24 with the same rules. Browser acceptance stays **unverified** until looked at on the PC (`stats.vec45i`); the combined server (Mission 116) is unchanged.
