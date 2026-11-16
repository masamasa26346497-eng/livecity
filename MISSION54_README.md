# Mission 54: real PLATEAU building footprints at Nakanoshima vs GSI water / road edge

Result: **no viewer change. Positional shift NOT fixed - no evidence of a shift to fix.** The old 31G ~29 % overlap is not reproduced with real building footprints.

## Acquisition (Node fetch, sequential, >=1.1 s apart, UA livecity-poc/1.0)
| # | request | HTTP | bytes |
|---|---|---|---|
| 1 | api.plateauview.mlit.go.jp/datacatalog/citygml/r:135.488,34.691,135.503,34.698?types=bldg | 200 | 2,159 |
| 2 | 52350339_bldg_6697_op.gml, Range `bytes=0-199999` probe | 200 (**Range ignored, full body**) | 30,202,098 downloaded and discarded (> 15 MB limit; my probe did not abort the stream - a mistake, counted) |
| 3 | 52350339 first-N-bytes read, connection aborted | 200 | 9,500,829 |
| 4 | 52350430 first-N-bytes read, connection aborted | 200 | 9,402,699 |

Total 4 requests, **49,107,785 bytes (< 50 MB)**. The per-file 15 MB limit was not raised: the server does not honour Range, so only a prefix read (stream, then abort) is possible. No 403/429. Originals are in `temp/m54` (git-ignored, not committed; redistribution terms not verified; the API response has no licence text).
Source: PLATEAU Osaka-shi 2025 (spec 5.0), `27100_osaka-shi_city_2025_citygml_1_op`, EPSG:6697 (lat lon h), `bldg:lod0FootPrint`.

## What the data is
Only **complete** `<bldg:Building>` elements inside each prefix were parsed: 909 buildings (unique ids), ~32 % of mesh 52350339 and ~26 % of 52350430 (a sample, not the whole mesh; order in file is not spatial). 680 touch the GSI window.
Coordinates via the same `geoToThree()` constants (CLAT/CLON/MPD), no shift.

## Measured (`node tools/mission54-bldg-vs-gsi.cjs temp/m54 data/reports/mission54-bldg-vs-gsi.json`)
- Footprint vertices in GSI water: 14 / 5,037 (0.28 %). Centroids in water: 2 / 680 (0.29 %) - two tiny structures (9 m2, 85 m2), likely river-side/floating structures; not classified further.
- Vertex to nearest GSI road-edge line: p10 0.26 m, p50 6.3 m, p90 20 m (buildings are set back from road edges, as expected).
- Rigid shift sweep +-8 m (2 m step): best 11 vs 14 vertices at (0,0); flat, noise-level. No shift is justified.

## Viewer
The viewer has no Nakanoshima buildings: the committed Kita (52350349/359) and Chuo (52350400/410) tilesets do not overlap meshes 52350339/430. So there was nothing to correct; no GLB/canonicalId was moved, no snapping, no global shift. Viewer code unchanged.

## Not done / unverified
- Whole-mesh coverage (~70 % of buildings not fetched); PLATEAU tran not re-fetched (budget used; Mission 53 covers tran vs GSI).
- Bridges / roof overhang / data-year differences not classified (no case needed it).
- Browser before/after and Mission 45X/49-53 QA re-run: not executed (no viewer change).
- Licence not verified.
Further building coverage would need >50 MB or a different source; needs your approval.
