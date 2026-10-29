# Mission 52: GSI road edge restored as default layer; GSI water seam duplicates removed (Okawa / Nakanoshima window)

## Re-check against old reports (31G ALIGNMENT-RESET, FIX13)
- Old Three.js: GSI RdEdg was the **authoritative road outline and default ON** (31G sec.7-9); FIX13 road-surface polygons were fill only.
- Current Cesium viewer (before this mission): `gsiroadedge` existed but default **OFF**, so a normal user saw only OSM centrelines with pixel widths, which is the regression vs the old behaviour.
- Okawa/Nakanoshima defects found in current rendering: (a) no road outline by default; (b) GSI WA polygons are split at tile seams and 4 of 51 are fully covered by neighbouring polygons (drawn twice); a further 4.2 % of covered 2 m cells have 2+ polygons (partial overlap, alpha 0.95, left as is).

## Changes (`public/mission37g-osaka-24ward-mvp.html`)
1. `gsiroadedge` is now **default ON** (window-limited: Sumiyoshi 9-tile, Kita sample, Okawa/Nakanoshima; nothing is drawn outside). OSM centreline layer is kept as a separate layer; no road width is estimated.
2. `public/mission52-water-dedupe.js`: drops only water polygons fully covered by larger kept polygons (same objects, no new geometry, no coordinate change). Real data: 51 -> 47 polygons, 193 m2 removed. Diagnostics: `__mission37g.gsiWater.dedupe`.

## Measured (headless Chrome, software rendering, no basemap; `tools/experiments/mission50_okawa_qa.mjs`)
| state | water-interior points drawn as water (142) | land points drawn as water (512) |
|---|---|---|
| water OFF | 4 (2.8 %) | 1 (0.2 %) |
| water ON + road edge ON (new default) | 139 (97.9 %) | 1 (0.2 %) |
| water ON + road edge OFF | **142 (100 %)** | 1 (0.2 %) |
Reading: the dedupe loses no water pixel (100 % with road edge off). The 3 points that read non-water with the edge layer ON are covered by orange road-edge lines drawn over the river (bridges), i.e. edge line over water, as expected for RdEdg.
0 JS errors, 0 Google requests. The only 404s are favicon and the optional `ext-3dtiles/index.json`.

## Not done / blockers
- Nakanoshima proper has no tracked independent PLATEAU footprint (Mission 51: 3 buildings); not fetched (official ZIP ~1.3 GB, licence unconfirmed). The old "water vs building mismatch" at Nakanoshima remains **unverified**. GSI BldA is not PLATEAU.
- Road edge only covers the three windows; elsewhere roads are still OSM centreline + pixel width. This is not "ward-wide alignment fixed".
- Before/after here is pixel-sample based (data -> screen), not human visual QA with a basemap. No 45X/park/ward-select Chrome regression was run in this session beyond the Node tests below.
