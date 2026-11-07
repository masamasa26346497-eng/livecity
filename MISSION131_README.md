# Mission 131: fix the Mission129 false positive, one-job fetch -> verify -> browser acceptance

## Root cause of the false positive (run 42240020830)
`wards21.cjs --check` hard-coded `<root>/<ward>25/tileset.json` and treated "missing" as non-failing, so 21/21 extracted archives printed
`dataOk: 0, missing: 21` and the job was green. Now:
- `tools/mission131/layout.cjs` finds `tileset.json` at any depth <= 4 (real dirs only) and attributes it by exact path segment
  (`<ward>`, `<ward>25`, `plateau2025-<ward>`, `_x_<ward>`); sumiyoshi never matches higashisumiyoshi; ties report `ambiguous`.
  GLBs are taken from the tileset's own relative `content.uri` values (fallback `tiles/*.glb`).
- `wards21.cjs --check` exits 1 unless **all 21** are `data-ok` (`strictOk`). On failure it prints a names-only layout probe (file counts per extension, a few dir names).
- `accept-lib.cjs` / `accept21.mjs` use the same discovery, and the loopback server also serves exactly the URIs the discovered tileset references.

## What the owner does (one action)
Replace `.github/workflows/mission129-fetch-21.yml` on main with `tools/mission131/mission129-fetch-21.replacement.workflow.yml.template` (same file name, same
`LIVECITY_3D_DATA_READ_TOKEN`, same release; no secret re-registration), then dispatch it (`mode=full`). Later changes live in this PR branch, which the job checks out, so no further workflow install.
The job fetches into `RUNNER_TEMP/b21/_x_<ward>/`, runs the strict check, then the Mission130 browser acceptance on the same data, and uploads nothing
(summary has counts/verdicts only). Inputs: `mode` (full|data), optional `wards`.

## Not done / not proven
- No real 21-ward data was available here: the browser path has still run against **0** real wards. Tests are synthetic (layout, strictness, server whitelist, template safety).
- Per-ward table of 21 is produced by the first real run (columns: layout, data verdict, tileset/glb 200, 404, mounted, pixel diff, click id, coverage, verdict). Until then every ward is "not accepted / not run".
- The runner assumes the archive contains `attrs/*.json` (byId `[h, ?, x, z]`) and `ids/*.json`; if absent the ward reports `no tall in-ward building in attrs` and is not accepted.
- CI Chrome (preinstalled on ubuntu-latest, headless software GL) and the Cesium CDN are assumed available; unverified.
- 24/24 is not claimed; the three existing wards are not evaluated.
