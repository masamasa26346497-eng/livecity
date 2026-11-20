# Mission 53: official PLATEAU (tran) vs GSI water at Okawa/Nakanoshima

Result: **no code change to the viewer. Positional shift NOT fixed (no evidence of a rigid shift to fix).**

## Fetch log (Node 24 fetch, sequential, 1 s apart, UA livecity-poc/1.0)
| # | URL | HTTP | bytes |
|---|---|---|---|
| 1 | api.plateauview.mlit.go.jp/datacatalog/citygml/r:135.488,34.691,135.503,34.698?types=bldg,tran | 200 | 3,286 |
| 2-5 | assets.cms.plateau.reearth.io/.../udx/tran/{52350329,52350339,52350420,52350430}_tran_6697_op.gml | 200 x4 | 2,923,652 / 1,557,869 / 3,477,739 / 2,067,953 |
Total 5 GET, 10,033,499 bytes (limits: 60 GET / 50 MB / 15 MB each). Originals are in `temp/` (git-ignored, not committed; redistribution terms not confirmed).

API facts: city 27100 大阪市, dataset year 2025, spec 5.0, files `27100_osaka-shi_city_2025_citygml_1_op`. bldg files for the 4 meshes are 30.2-36.4 MB each (> 15 MB individual limit), so **bldg GML (Nakanoshima building footprints) was NOT fetched**. The API response carries no licence text; licence not verified here.

## Measured (tools/mission53-plateau-tran-vs-gsi.cjs, coordinates via geoToThree constants, no shift applied)
- 6,302 PLATEAU road/traffic-area polygons touch the GSI window; 49,236 sample points (vertices + centroids).
- 1,439 points (2.92 %) fall inside GSI water polygons; 78 polygons are mostly in water (largest ~3,800 m2). No bridge flag exists in tran, so these are most likely bridges / river-crossing roads; not proven.
- Rigid-shift sweep (vertices, thinned 1/12, +-6 m): count of road vertices in water is minimal at (dx,dz)=(0,0) (112; +-6 m gives 123-155). The 3 m step search in the tool picked (3,0) on a different thinned sample with a small gain, which is noise-level; the finer sweep shows 0,0 minimum.
- PLATEAU road vertex to nearest GSI RdEdg line: p50 0.06 m, p90 3.3 m (n=1500).
=> PLATEAU, GSI water and GSI road edge agree in the same plane; no transform/layer bug found at Okawa.

## Viewer regression (headless Chrome, software GL, no basemap)
`node tools/experiments/mission50_okawa_qa.mjs` re-run: water ON+edge OFF 142/142, ON+edge ON 139/142, land false-water 1/512, round-trip median 0.16 m. Same as Mission 52; no regression.

## Blockers / not done
- Nakanoshima building footprint vs water: still unverified (bldg GML too large per file; Range fetch of unknown offsets not attempted).
- Old reports' (31G) mismatch is not reproduced with roads.
