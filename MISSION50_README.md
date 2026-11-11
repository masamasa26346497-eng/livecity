# Mission 50: GSI measured water polygons for Okawa / Nakanoshima (Kita/Chuo)

## What was dropped in the move to Cesium (confirmed from the old reports + current code)
- Old Three.js (31G ALIGNMENT-RESET, CANONICAL_GEOMETRY_DESIGN): GSI RdEdg = road outline, GSI/surveyed water = water outline (Okawa water 29% vs footprints was the symptom).
- Current Cesium viewer: roads = OSM centrelines with pixel widths; water = OSM `waterways.json` only inside the Sumiyoshi 9-tile bundle. Near Okawa there is **no water or road geometry at all** (no tracked OSM there). Mission 49 restored RdEdg only for Sumiyoshi/Kita-sample windows, default OFF.

## Change (viewer)
- New layer `gsiwater` (水域面・GSI実測), **default ON**: GSI `optimal_bvmap-v1` WA polygons for a 20-tile z16 window around Nakanoshima/Okawa (51 polygons, 6 holes, ~0.32 km²). Nothing is drawn outside the window; no area is invented.
- `gsiroadedge` (default OFF, lazy) now also includes the Okawa window (2,944 RdEdg lines).
- Data: `public/mission50-data/gsi-okawa-nakanoshima.json` (349 KB, 取得 2026-10-29). Credit: 国土地理院（基盤地図情報を含む）。 Re-generate: `tools/mission50-fetch-okawa.cjs` then `tools/mission50-build-okawa.cjs` (public GSI GET, 20 tiles, sequential). No coordinate shift anywhere.

## Measured (headless Chrome, same top-down view, `tools/experiments/mission50_okawa_qa.mjs`)
Points chosen from the data (>=6 m from any water edge), projected to the screen, pixel colour read:
| | layer OFF (before) | layer ON (after) |
|---|---|---|
| water-interior points rendered as water (142 usable) | 4 (2.8%) | 142 (100%) |
| land points rendered as water (512 usable) | 1 (0.2%) | 1 (0.2%) |
Depth read-back round trip (40 points): median 0.16 m, max 1.45 m.
Consistency control (GSI BldA vs GSI WA, 8,246 buildings): 0.1% of vertices in water, 9 buildings touch water.

## Limits (not claimed)
- This shows the **viewer now draws the surveyed river where the source says it is** (data -> screen). It does not independently validate GSI itself, and it does not test PLATEAU building position at Okawa: no tracked PLATEAU/GLB tiles exist there, so the old 29% symptom against PLATEAU footprints is still not reproducible or ruled out.
- Only this window. No other ward gets GSI water/road edge; OSM fallback elsewhere is unchanged.
- Polygons are split at GSI tile seams and extend a few tens of metres past the window (tile clip buffer).
- Headless: software rendering, no basemap; not a human visual QA. Licence: GSI terms believed CC BY 4.0 compatible, not independently verified.
