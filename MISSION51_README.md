# Mission 51: PLATEAU buildings vs GSI water / road edge at Okawa; duplicate road-edge drawing fixed

## 1. Real PLATEAU buildings DO exist in the Okawa window (tracked 3D Tiles)
Footprints recovered from the tracked GLBs (`tools/lib/mission49-glb-footprints.cjs`). No download.
Window = Mission 50 GSI window (inner 60 m margin). 249 PLATEAU buildings: Kita 246, Chuo 2, Nishi 1.
Coverage caveat: they are the **northern reach of Okawa** (Kita sample, z -11275..-10619). Nakanoshima proper has only 3 tracked PLATEAU buildings; it is NOT covered.

## 2. Direct comparison (`node tools/mission51-okawa-plateau.cjs` -> `data/reports/mission51/okawa-plateau-vs-gsi.json`)
| Measure (PLATEAU vs GSI WA / RdEdg, same local frame) | Result |
|---|---|
| Footprint vertices inside GSI water (2,457 vertices) | **0 (0 %)** |
| Buildings with any 3 m-grid sample in water | **0 / 249** |
| Nearest footprint vertex to a GSI water edge, signed (all land side) | 2.9, 3.4, 4.3, 5.6, 5.8, 8.7 m, then 19.4 ... |
| Buildings < 10 m / < 30 m from shore | 6 / 8 |
| Buildings with a footprint side crossing a GSI road edge | 19 / 249 (source-semantics difference, see Mission 49) |
| Rigid shift search +-12 m, 3 m step (water vertices) | 0 % at (0,0) and everywhere: no signal, so no shift is justified |

Reading: the old "Okawa water 29 % overlaps buildings" is **not reproduced** against current PLATEAU vs GSI WA in this window. That old figure used different data/definitions (31G/32J), so this neither confirms nor refutes it. Limits: only 8 buildings are within 30 m of the shore, so this is a weak test of shore alignment (max sensitivity ~3 m). Private 23-ward GLBs are not examined.

## 3. Viewer defect found and fixed: same road-edge segment drawn several times
`gsiroadedge` loads three GSI datasets. Measured on tracked data:
- Kita-sample window and Okawa window overlap: 260 identical lines, 1,149 identical segments drawn twice.
- Okawa file itself: 633 / 14,825 segments duplicated (tile-seam clip buffer).
- Fix: `public/mission51-seg-dedupe.js` drops only segments already drawn (direction ignored), rebuilds the rest as runs; no coordinate is changed. Wired in `public/mission37g-osaka-24ward-mvp.html` (both sources, shared `seen` set). Diagnostics: `__mission37g.gsiRoadEdge.dedupe`.
- Headless Chrome (`tools/experiments/mission49_roadedge_qa.mjs`, after fix): 37,338 segments in, 34,261 drawn, **3,077 (8.2 %) duplicates removed**, 0 JS errors, 0 Google requests.
- Visual effect is nil by design (identical coordinates): the gain is fewer primitives, not a visible shift. No before/after screenshot can show it; counts are the evidence.

Not changed: water polygons overlap each other at tile seams (8.1 % of 2 m cells covered by >1 polygon, alpha 0.95 so stacking is 0.9975); judged cosmetically negligible, left as is.

## 4. Not done / blockers
- No PLATEAU data for Nakanoshima/Okawa south part is tracked. No network fetch of PLATEAU was attempted (official data is a ~1.3 GB ZIP; range-fetch tool `tools/mission36k-fetch-citygml-ward-range.mjs` could get a mesh but the licence is unconfirmed, so nothing was committed).
- GSI redistribution terms unconfirmed; no new GSI source data was added (only a report).
- OSM waterways do not exist in the Okawa window, so there was no OSM-over-GSI duplicate to fix here.
