# Mission 55 P0: unified-frame alignment check on Sumiyoshi 9 tile (buildings / road edge / centreline / waterways)

Result: **measurement only; viewer not changed.** I did not reach the "buildings + road surface + river surface drawn together" screen, and no browser QA was run.

## Area chosen
Sumiyoshi 9 tile is the only window where every source is committed: 10,546 PLATEAU LOD1 footprints, GSI RdEdg road-edge lines (36 z16 tiles), OSM road centrelines (969), OSM waterways (20), parks. Nakanoshima has no committed buildings (Mission 54), so it cannot be completed from repo data.

## Frame
All layers already use one frame, `znorth-neg-v1`: x east, z south, metres, origin CLAT 34.604208 / CLON 135.525020, MPD 111320 (same as `geoToThree()`). No new transform was introduced; no coordinate or canonicalId changed.

## Measured (`node tools/mission55-sumiyoshi-align.cjs data/reports/mission55-sumiyoshi-align.json`)
| layer vs buildings | length | inside building footprints |
|---|---|---|
| GSI road edge | 284,615 m | 2,248 m (0.79 %), 392 buildings touched |
| OSM centreline | 135,646 m | 70 m (0.05 %), 11 buildings |
| OSM waterways | 3,964 m | 14.5 m, 2 buildings |

Rigid shift sweep of the road edge (+-8 m, 2 m step): zero shift is the minimum (2,248 m); +-2 m already gives ~20,000 m. So roads and buildings in this window are aligned and there is no shift to apply.

## Not done / limits
- No road *surface* or river *surface* polygons exist in this window (GSI WA only at Okawa/Nakanoshima; PLATEAU tran only at Okawa). I did not synthesise any.
- The remaining visible mismatch is at Nakanoshima/Okawa, where building footprints are missing, not misplaced. Fixing it needs more PLATEAU bldg data (>50 MB budget, or the licence-unverified ZIP): needs your approval.
- 0.79 % edge-in-building is not classified (elevated roads, tunnels, data-year differences).
- Headless Chrome top/oblique comparison and 10-point visual QA: **not run**. Licence of PLATEAU/GSI redistribution not verified.
