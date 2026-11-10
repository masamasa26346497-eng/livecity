# Mission 101 P0: multi-ward owner-run persist workflow (official PLATEAU 2025, Osaka City 27100)

## Status (separate counts)
| Item | Count | Evidence |
|---|---|---|
| Private storage verified (sha256 re-downloaded) | **1 / 24** (nishi) | Mission95 run 41544102363: 12,603 buildings, sha256 `0232c89f...a078c4` |
| Other 23 wards generated | **0** (not run yet) | needs the owner to dispatch this workflow |
| Browser (Cesium) accepted | **0 / 24** | storage is not browser acceptance |

## What changed
Workflow only. Code pin stays `c4b79150067bba5acd37fbbf05c1e5af8b0af5b0`; the 13 embedded sha256 are unchanged (test checks the tree still equals them).
`tools/mission101/persist-wards.pinned.workflow.yml` (rendered by `node tools/mission101/render.mjs`):
- Input `wards` = comma list, at most 6, only the 24 official ward ids (expo 27999 rejected, duplicates rejected). `overwrite` default false.
- `plan` job (curl only, no repo code): checks private repo + push, lists release assets, **re-downloads every already-stored requested ward and recomputes sha256**; nishi must equal the recorded sha256 or the run fails. Stored wards are skipped (no reconversion).
- `persist` matrix: one ward per fresh runner, `max-parallel: 1`, `fail-fast: false`. A failed ward leaves all stored wards untouched (assets are per ward, no delete, no `--clobber` by the workflow; the existing persist code only re-uploads when remote sha differs).
- Each ward keeps all Mission96-100 gates: hash-verified checkout, preflight (N03, not 27999, source lock 27100/2025 + licence), strict check (2025, ids unique, skipped 0), manifest diff, 2 GiB asset cap (in `mission87-persist`), private mandatory, token only in plan / connect check / persist, sha256 re-download verification.

## Owner steps (one-time swap)
1. Copy `tools/mission101/persist-wards.pinned.workflow.yml` to `.github/workflows/mission95-persist-ward.yml` on `main` (GitHub UI, one file).
2. Actions -> dispatch with `wards` = e.g. `fukushima,naniwa,kita` (start small; check one ward's time/size first).
3. Run summary shows per-ward strict result, buildings, sha256, `browserAccepted: 0`.
4. Repeat for the remaining wards in batches of up to 6. Re-running is safe: stored wards are skipped after sha256 re-check.

## Not verified / limits
- The workflow was not executed (Claude cannot trigger it); static tests only (`tests/mission101-wards-workflow.test.cjs`). YAML syntax was not parsed by a YAML library here.
- Large wards (more buildings than nishi) may exceed the 60 min ward timeout / `--max-mb 1200`; such a ward fails alone and is reported, nothing is lost.
- Private release storage quota and Actions minutes were not verified (public repo runner minutes assumed free). Stop if the owner's plan differs.
- PLATEAU terms are recorded in `source-lock.json` (licence/attribution checked by preflight); not re-reviewed here. No 3D data is committed to this public repo.
- Cesium display of stored wards (loading the private asset into the viewer) is a separate, not-yet-built step.
