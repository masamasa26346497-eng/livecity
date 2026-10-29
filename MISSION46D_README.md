# Mission 46D-R1: independent accuracy check (GSI vector tiles vs Live City)

Core tool only. **No real 24-ward data has been collected or verified yet**; tests use synthetic fixture tiles.

```
node tools/mission46d-independent-accuracy.cjs --src <legacy osaka-city dir> --ref-dir <dir>/<wardId>/<z>_<x>_<y>.pbf [--wards a,b] [--out report.json]
node --test tests/mission46d-independent-accuracy.test.cjs
```

- Reference: GSI `optimal_bvmap-v1` layers `BldA` (building outlines) and `RdEdg` (road edges), decoded by `tools/lib/mission46d-mvt.cjs` (dependency-free MVT reader, gzip aware, web-mercator -> Live City local metres with the existing CLAT/CLON/MPD constants).
- Buildings: Live City footprint centroid must fall inside a GSI building; vertex-to-GSI-outline distance median/p95 and centroid offset are reported. Offsets are reported, never applied.
- Roads: centerline samples (10 m) must lie within a band of a GSI road edge (corridor containment). A centerline is NOT expected to coincide with an edge; `onEdgePct` is reported.
- Status per ward: `PASS` / `FAIL` / `INSUFFICIENT_DATA`. Missing reference tiles, low coverage, or too few samples is always `INSUFFICIENT_DATA`. `summary.allWardsPass` is true only if all 24 wards PASS.
- Schema: `livecity.mission46d.independent-accuracy/1` (thresholds and limits are embedded in the report).
- Read-only: no network, no writes besides `--out`, never touches `--src` / `--ref-dir`.

Next (separate short jobs): fetch GSI tiles for 24 wards into `<ref-dir>/<wardId>/`, run the tool, publish the per-ward result.
