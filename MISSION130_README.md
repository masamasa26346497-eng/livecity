# Mission 130: private 21-ward Cesium browser acceptance

## What Mission 129 run 42240020830 actually showed (from the job log; no secret values)
- release GET HTTP 200; **21/21 archives fetched and extracted** (7.0-21.6 MB each, about 270 MB total).
- The data-level check printed `dataOk: 0`, **`missing` = all 21 wards**, `problems: []`. The step was green only because "missing" is not a failure in `wards21.cjs`.
  So the archives did **not** extract to `<ward>25/tileset.json` (the layout the check, and the Mission116 server, assume). The real layout is unknown to me.
- `tar: stdout: write error` on most wards = `tar -tzf | grep -q` SIGPIPE; harmless noise.
- No artifact (by design). 0 wards have HTTP/GLB/WebGL/click/coverage evidence.

## What this adds
`tools/mission130/accept21.mjs` (+ `accept-lib.cjs`, template, test). Per ward it **discovers the real layout** (names only are logged), serves the data read-only on 127.0.0.1,
and records: source found, tileset/GLB HTTP 200, 404 count, Cesium3DTileset mounted+ready, real WebGL pixel diff (buildings on/off), a **real CDP mouse click** that selects the target
canonicalId (in the ids sidecar, inside the N03 ward polygon), and coverage vs the 2024 manifest count (`full-candidate`/`partial`/`unknown`, never a proof).
A ward with any missing evidence is **NOT ACCEPTED**. The existing three wards are not inferred; `twentyFourOfTwentyFourProven` is always false from this tool.

```
node tools/mission130/accept21.mjs --root <extracted-dir> --discover-only      # layout only, no browser
node tools/mission130/accept21.mjs --root <extracted-dir> [--wards a,b] [--out new.json]
node --test tests/mission130-accept21.test.cjs
```
No upload, no screenshots written, `--out` is create-only. Owner-installed template: `tools/mission130/accept21.workflow.yml.template`
(same READ-token curl fetch as 129, each archive extracted into `_x_<ward>/`, then the runner; summary only).

## Not done
The browser path has not been run against any data (this environment has none). Unit tests cover discovery, verdict, coverage, server whitelist and template safety only.
