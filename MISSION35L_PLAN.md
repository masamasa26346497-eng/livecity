# Mission 35L｜大阪24区 町丁目境界完全化

## Goal
Mission 35K の「町名クリック → 境界表示 → bbox-fit zoom」を、大阪市24区で町丁・字等レベルの実境界に接続する。

## Source policy
- primary geometry source: 総務省統計局 e-Stat「令和2年国勢調査 町丁・字等境界データ」
- geometry is accepted only from Polygon/MultiPolygon features
- ward membership is determined from official CITY / KEY_CODE data, not inferred from label position
- no invented town polygons
- N03 ward boundary remains fallback only when a label cannot be matched to an official town boundary
- existing 3-ward legacy `TOWN_POLYGONS` may be retained for regression comparison, not promoted as official

## Coordinate policy
- keep the Live City origin and scale unchanged
- output runtime coordinates are `znorth-neg-v1`: +X east, -Z north, 1 unit = 1m
- do not modify `tools/lib/projection.js`; negate Z at the official-town ingestion boundary, matching the N03 ingestion policy

## Runtime compatibility
Output remains compatible with Mission 35K `area-boundaries.json`:
- `areas[]`
- `labelMap`
- `boundaryGranularity`
- `boundarySource`
- `bbox`
- `rings`

35K UI / click priority / animation should not require redesign.

## Completion gates
1. official Osaka-prefecture boundary ZIP can be downloaded reproducibly
2. SHP + DBF are parsed without external GIS dependencies
3. only Osaka City 24 wards are retained
4. all official town features are converted to `znorth-neg-v1`
5. base-town groups (e.g. 梅田一〜三丁目 → 梅田) are generated from official member polygons only
6. 24 wards represented in official-town dataset
7. no synthetic/invented boundary count > 0
8. representative label mapping verified for north/central/south Osaka
9. Mission 35K behavior retained
10. `npm test` fail 0 where GitHub runner data permits
11. production HTML and protected baseline are not modified
12. production cutover requires explicit user approval
