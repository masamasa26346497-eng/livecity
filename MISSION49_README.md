# Mission 49: lessons from the Three.js history vs the Cesium viewer

## Old fix -> current Cesium path (tracked data only)
| Old fix (report) | Cesium viewer today | Evidence |
|---|---|---|
| FIX24: NEAR LOD simplification tolM=2 moved outlines up to 49.96 m | Leaf GLB equals source footprint (max vertex deviation < 0.00005 m, 10,546/10,546) | `tools/mission49-footprint-exact.cjs`, `data/reports/mission49/footprint-exact-sumiyoshi.json` |
| FIX11: north = -Z vs +Z mix | Not present. GLB footprints round-trip to attrs rep points, median 0.36 m (Kita, 2,698) | `tools/lib/mission49-glb-footprints.cjs`, test |
| ALIGNMENT-RESET: GSI RdEdg is the road outline, PLATEAU road area too wide | **Dropped in the move to Cesium** (only OSM centrelines with px widths). Restored as optional layer `gsiroadedge` (default OFF) for two small windows | this PR |
| FIX23C / legacyRoot: stale RoadLayer duplicates | Bundle-vs-ward duplicate lines are clipped (existing `opt.clip`); no legacy renderer exists | not re-tested here |
| CANONICAL_GEOMETRY_DESIGN: Okawa water 29% vs footprints | Not testable: no tracked water/road data near Okawa. Tracked Kita sample is the Yodogawa side | see limits |

## Independent measurement (GSI z16: WA, RdEdg, BldA; public, free)
| Area | PLATEAU in water | PLATEAU crossing RdEdg | GSI BldA control crossing | Best rigid shift |
|---|---|---|---|---|
| Kita sample (2,698) | 0.087% samples, 2 buildings | 9.30% | 4.80% | (0,0) coarse, fine, all 4 quadrants |
| Sumiyoshi 9 tile (10,546) | 0.101%, 6 buildings | 3.78% | 1.67% | (0,0) coarse, fine, all 4 quadrants |

Reading: no global or local offset (minimum at 0,0, also per quadrant). Buildings are not in the river. The excess crossings (about 2x the control) are the source-semantics difference already classified in 32J: LOD1 footprint vs surveyed road edge. It is not a position error. Tools: `tools/mission49-kita-independent.cjs`.

## Fix
`gsiroadedge` layer in `public/mission37g-osaka-24ward-mvp.html`: default OFF, fetched only when turned ON (no startup cost), same-origin JSON from `tools/mission49-build-roadedge.cjs` (GSI RdEdg, 130 KB + 341 KB), no Google. Credit: 国土地理院. Headless same-position pixel diff OFF vs ON: Kita 59,719 px, Sumiyoshi 82,464 px; OFF vs OFF-again 92-94 px (noise). `tools/experiments/mission49_roadedge_qa.mjs`.

## Limits
- Window only (Sumiyoshi 9-tile area, Kita sample area). Other wards: no tracked road/water data.
- Okawa / Nakanoshima: no tracked building tiles there, so the old 29% symptom could not be reproduced or ruled out.
- Old branch `feature/ward-expansion-20260817` was fetched but its HTML was not diffed line by line; comparison above is from the reports plus current code.
- Headless uses software rendering, no basemap; screenshots are not a human visual QA.
