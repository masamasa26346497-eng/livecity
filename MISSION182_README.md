# Mission 182A: LOD2-complement LOD1 tiles (opt-in, LOD1-only output untouched)

Goal: stop LOD1/LOD2 double drawing by not generating LOD1 for buildings that have LOD2, instead of runtime ClippingPolygon.

## Usage (all local, temp only; nothing fetched beyond the existing free Range reader)
1. `node tools/mission79-run.mjs --ward chuo --work W --final LOD1 --max-mb 1300` (unchanged; LOD1-only output kept)
2. `node tools/mission182/extract-lod2-ids.mjs --input W/bldg --out lod2-ids.json` (gml:id of every top-level `bldg:Building` having `lod2Solid`/`lod2MultiSurface`, same 2025 GML)
3. `node tools/mission79-build-ward-2025.cjs --ward chuo --jsonl W/chuo.jsonl --out COMPLEMENT --exclude-ids lod2-ids.json`
   writes `lod2-complement-audit.json` + `lod2-excluded-ids.json`. Then `node tools/mission164/harden-tileset.mjs COMPLEMENT`.
4. `node tools/mission182/audit-complement.mjs --full LOD1 --complement COMPLEMENT --lod2-ids lod2-ids.json` (exit 1 on any loss / leftover)
5. `node tools/mission182/compare-views.mjs --full LOD1 --complement COMPLEMENT --standin STANDIN` (STANDIN = step 3 with `--invert-ids`; a LOD1 extrusion proxy of the LOD2 buildings, NOT real LOD2 meshes)

Rules: only exact `gml:id` + same vintage (2025) is skipped. Id-set with another vintage -> nothing excluded, all LOD1 kept (warned). No id -> never listed. The ids file is the only input; output tileset/attrs/URL layout is identical to the LOD1 build, so the 37G `ext-3dtiles` contract is unchanged.

Reports: `data/reports/mission182/*.json`.
