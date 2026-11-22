# Mission 144: real road / river rendering acceptance + water-surface root cause

## Owner PC (Windows, one command each; the existing 141 launcher on 8137 is not touched)
```
git fetch origin && git merge --ff-only origin/claude/issue-23-20261007-1424
node tools/experiments/mission144_acceptance_e2e.mjs --root C:\lc141 --sample 6
node tools/experiments/mission144_acceptance_e2e.mjs --root C:\lc141 --sample all     # all 24 wards (slower)
```
Layers are auto-detected exactly as in Mission 143 (`%LOCALAPPDATA%\LiveCity-MapLayers-Out-24`); add `--layers-root <dir>` to force one.
Report: `data\reports\mission144\acceptance-real.json` (+ screenshots). Uses its own port 8192, loopback, read-only.
Per ward it records: HTTP status of each layer file, scene primitive counts, pixel difference with roads / waterways OFF vs ON (top-down),
page lon/lat vs the shared projection constants, pickPosition, ground vs layer heights, road-vs-building overlap ratio, disposal of the previous ward.

`--fixture` runs the same harness on committed samples with SYNTHETIC lines: harness proof only, never owner data.

## Water-surface 0/24: root cause
* Mission115/45I never writes `water-surface.json`. That file is a separate citywide sea/bay triangle layer (`tools/build-water-surface.js`), never sliced per ward.
* Real OSM water polygons are `kind:"area"` features inside `waterways.json` and are drawn by the waterways layer. The launcher now counts them separately.
* A river that is only a centre line has no width in the source; no surface is generated from it.
* `node tools/mission144-water-surface.cjs --layers-root <dir>` diagnoses each ward. With `--source <citywide water-surface.json> --apply` it creates NEW per-ward files from
  triangles fully inside the ward clip box (dry run by default, never overwrites).
* Alternative polygon source (proposal, not fetched): OSM water polygons / Geofabrik extract, ODbL, "OpenStreetMap contributors"; refresh by re-running the old-tile converter.

## Alignment
Buildings, roads, rivers and N03 share `znorth-neg-v1` (origin CLAT/CLON, MPD). The E2E measures page-vs-constants lon/lat difference, pickPosition,
terrain provider / ground height vs layer heights (0.5–2.0 m over an ellipsoid-flat globe, depthTestAgainstTerrain=false) and road/building overlap. No building shift is applied.
