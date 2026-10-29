# Mission 46D: independent accuracy check (GSI vector tiles vs Live City)

## Tools
```
# 1. fetch GSI tiles (free, no key, sequential, capped; cache must be git-ignored: temp/ or data/cache/ or outside repo)
node tools/mission46d-fetch-gsi-tiles.cjs --out temp/gsi46d --wards sumiyoshi --sample 12   # SAMPLE of tiles inside the ward polygon
node tools/mission46d-fetch-gsi-tiles.cjs --out temp/gsi46d --plan                           # count only, no requests
# 2. check
node tools/mission46d-independent-accuracy.cjs --src <legacy osaka-city dir> --ref-dir temp/gsi46d --out report.json
node --test tests/mission46d-independent-accuracy.test.cjs tests/mission46d-fetch-gsi-tiles.test.cjs
```
- Fetcher: `https://cyberjapandata.gsi.go.jp/xyz/optimal_bvmap-v1/{z}/{x}/{y}.pbf` -> `<out>/<wardId>/<z>_<x>_<y>.pbf`. Defaults: zoom 16, <=40 tiles/ward, <=200 requests, 15 s timeout, 3 retries with backoff (429/5xx), 404 = no tile, responses size-checked and MVT-decoded, atomic writes, existing tiles skipped. Source: GSI (cite when publishing). GSI data changes over time; `fetch-manifest.json` records fetch time.
- Full z16 coverage of all 24 wards is ~2,000+ tiles; `--sample N` is NOT full coverage and the report shows evaluated coverage per ward.

## Judgement rules
- Buildings: centroid must fall in a GSI building (holes respected, malformed rings excluded); vertex-to-outline distance median/p95.
- Shared lineage guard: centimetre-level agreement over many vertices => `suspectedSharedLineage` => `INSUFFICIENT_DATA` (agreement with the source the data came from is not independent evidence).
- Roads: a centerline sample counts only if a GSI edge exists within the band on BOTH sides (bracketed). One-sided proximity never gives PASS. Thresholds (60% / 50 samples) are provisional and not calibrated.
- Missing reference tiles, missing Live City source, low coverage => `INSUFFICIENT_DATA`. `allWardsPass` only if all 24 PASS.
- GSI vs PLATEAU/OSM differ in survey date and outline definition; no claim better than GSI nominal accuracy.

## R2 result (data/reports/mission46d-r2/)
Aggregate only. Only `sumiyoshi` has Live City building tiles tracked in Git; 12 sample GSI tiles were fetched. All other wards and all roads: INSUFFICIENT_DATA (source not in Git). Result: PASS 0 / FAIL 0 / INSUFFICIENT_DATA 24.
