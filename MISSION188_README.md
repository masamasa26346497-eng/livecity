# Mission 188 (PR #51 only): persistent local 2025 LOD1 build, one command

Problem: the 2025 LOD1 set (Mission 165 measured 615,234 buildings / 24 wards) was only ever built in runner `temp/`, which vanishes.
This adds a cross-platform CLI that builds it into a **folder you choose** (survives reboot), resumable per ward, verified, in the 37G `?ext45=1` layout.
It uses only the official free PLATEAU Range requests (rights gate from M156 unchanged; attribution kept in each ward's `source.json` and in `index.json`). No PAT, no upload, no paid API.

## One command (Windows PowerShell, from the repo root, Node 18.15+)
```
node tools\mission188\build-local-2025.mjs --out "$env:LOCALAPPDATA\LiveCity-3DTiles-Out-2025" --all
```
Re-run the same command after any failure/interruption: wards whose stored files re-hash to their manifest are skipped; the rest are rebuilt.
Other modes: `--plan` (offline, disk estimate), `--wards chuo,kita`, `--verify-only` (re-hash everything, rebuild index, no network),
`--max-mb` (default 1300, per ward raw GML cap), `--retries`, `--ward-timeout-min`.
Then read-only HTTP check / serve for 37G: `node tools\mission188\serve-check.mjs --out "<dir>" [--serve]` (loopback 127.0.0.1:8188, GET/HEAD only).

## Layout (`<out>`)
`.livecity-2025-lod1-root.json` marker · `build-report.json` · `ext-3dtiles/index.json` · `ext-3dtiles/<ward>/{tileset.json,source.json,alignment.json,tiles/,attrs/}` · `ext-3dtiles/_manifest/<ward>.json` (counts, bytes, treeSha256, ETag; not served).

## Guarantees
- Legacy `LiveCity-3DTiles-Out-24` (and any `-Out-24`/`-LOD0-24` path) is refused; a non-empty dir without our marker is refused. Nothing existing is overwritten.
- A ward is built in `<out>/.staging`, hardened (M164), verified (tileset files exist, no empty parent that stops refinement, ids unique, attrs count == source count, ETag == source-lock, attribution present) and only then renamed into place and added to the index.
- Cross-ward duplicate `gml:id` removes the affected wards from the index and exits 1.
- `index.json` lists only verified wards. `runtimeBuildings` is the sum of verified wards; 615,234 is printed only as a reference (`declaredReference2025`). Wards not run are counted as not done.
- Free disk is checked before generating (largest raw GML + ~80 MB/ward, +10%).

## Not claimed
`index.json` keeps `verified:false`, `ui37gVerified:false`, `roadRiverAlignmentVerified:false`, `published:false`. This tool does **not** run the 37G page or compare roads/rivers. LOD2 (`--exclude-ids`, M182A) is untouched and not used here.
