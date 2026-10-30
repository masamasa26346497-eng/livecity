# Mission 57 P0: GSI water polygons (WA) for the Sumiyoshi 9-tile window

Change: layer `gsiwater` now also draws GSI `optimal_bvmap-v1` WA polygons for the Sumiyoshi 9-tile window (78 polygons, 6 holes, 58,435 m2 before dedupe), `public/mission57-data/gsi-sumiyoshi-9tile.json` (20 KB, water only; road edges stay in mission49-data). Same znorth-neg-v1 frame, no shift, no synthesized geometry. Credit: 国土地理院（基盤地図情報を含む）; licence believed CC BY 4.0 compatible, not independently verified.

Fetch: 36 z16 tiles, sequential, 1 s spacing, public GET (limit 60 GET / 50 MB respected; ~2 MB). Regenerate:
`node tools/mission50-fetch-okawa.cjs --out temp/gsi57/sumiyoshi --bbox -3600,-900,-2100,600 --max 36`
`node tools/mission50-build-okawa.cjs --ref temp/gsi57/sumiyoshi --label sumiyoshi-9tile --out public/mission57-data --audit data/reports/mission57/sumiyoshi-gsi-audit.json`
(then drop `lines` as done here).

Measured (`tools/experiments/mission57_sumiyoshi_water_qa.mjs`, headless Chrome, same camera, top + oblique): interior points of GSI polygons that OSM waterways.json area does NOT already cover: 88 usable; rendered as water 0 -> 88 (gsiwater OFF -> ON) in both views. JS errors 0, Google requests 0, 404 only favicon and the localhost-only `ext-3dtiles/index.json` probe.

Not done: no road *surface* (no PLATEAU tran / closed GSI road polygon exists in this window; road edge lines vs centreline kept distinct, nothing buffered). Not a human visual QA (headless, no basemap). The Mission 56 10-point images were not human-evaluated. Click / ward select / layer toggles were not re-run beyond the existing static tests (27/27 pass).
