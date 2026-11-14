# Mission 105 - 3-ward chunked persist workflow candidate (ikuno, abeno, yodogawa) - NOT executed, NOT installed

Code + offline/synthetic-fixture tests only. No CityGML conversion, no real data fetch/upload, no Actions dispatch, no `.github/workflows` change,
no main change, no publication, no paid API, no permission gate removed. Latest HEAD before this mission: `604451b`.

## What was added (new files only; audited files untouched, test-enforced)
| File | Purpose |
|---|---|
| `tools/mission105/chunked-batch.mjs` | Drop-in for `mission80-batch --wards X --max-wards 1`. Accepts ONLY `ikuno/abeno/yodogawa` (the 21 stored wards are refused by code). Calls `tools/mission104/chunked-run.mjs` (<=300MB inflated GML per chunk; the 1200MB gate is not raised), then writes the same `<root>/out/<ward>-2025` dir and the same manifest entry (via audited `summarizeWard`). Skips a ward already `ok`. Touches only its own ward entry. |
| `tools/mission105/render.mjs` | Renders the workflow from the audited Mission103 template/steps with asserted substitutions. sha256 values are computed from **git objects at the pin**. |
| `tools/mission105/three-wards.pinned.workflow.yml` | The workflow candidate (owner installs; see below). Pin = `86264e6c539bd9fbe6abcea7c4e03b760d61e1e3` (commit containing `chunked-batch.mjs`; test checks it is a real ancestor of HEAD). 15 sha256 = the audited 13 (byte-identical) + `chunked-batch.mjs` + `mission104/chunked-run.mjs`. |
| `tests/mission105-chunked-workflow.test.cjs` | 13 tests (strict YAML parse, job graph, owner gate, pin/hash vs git objects, ward scope, token exposure, no forbidden-path changes since 604451b, synthetic manifest check, dry-run plans from the real source lock). |

## Safety properties of the workflow
- `workflow_dispatch` only; plan job runs only if `actor` and `triggering_actor` are the repo owner and ref is the default branch; `permissions: contents: read`.
- Input `wards`: `ALL` (= the 3) or a subset of the 3. Anything else (incl. any of the 21 stored wards, expo) is rejected in plan and again in the preflight step. No `overwrite` input/flag exists.
- Stored target wards are re-downloaded, sha256 recomputed, and skipped (never reconverted). The 21 other wards are not listed or touched at all. (Nishi's recorded-sha check is therefore not in this workflow; it stays in the Mission103 one.)
- Checkout of the pinned SHA, clean-tree check and `sha256sum -c` run before any token use and again before persist (re-verify step also enforces "other ward entries unchanged").
- Token only in plan, connect check and persist. Private-repo + push check. Persist is `--execute` only, after the strict output check. Failure of any step stops that ward (`generate-failed` vs `persist-failed` recorded); sequential, `max-parallel: 1`, `fail-fast: false`, no retry.
- **Resource preflight before any download**: >= 6 GB free disk, >= 3000 MB RAM, and `chunked-run --dry-run` (plan from the committed source lock; peak ~350MB inflated, total 1224-1275MB under the 1500MB hard ceiling).
- Job timeout 100 min, ward timeout 80 min.

## Free-tier / capacity pre-check (estimates, not measured)
Compressed transfer 52-69 MB/ward; peak inflated on disk ~350 MB; output a few tens of MB; standard ubuntu-latest runner (~14 GB disk, ~7 GB RAM) is enough by estimate.
3 wards sequentially: up to ~5 h worst case by timeouts, likely far less. Public repo => runner minutes free; private repo => billable minutes (owner decides; confirm repo visibility). Storage goes to the existing private release (no new service).

## Not proven
GitHub's own schema/expression validation (`fromJSON` matrices, artifacts), real conversion of the 3 wards (memory/time unmeasured), strict-check result on real output, upload/sha256 round trip. The in-test YAML parser is a strict subset parser, not GitHub's validator.

## Owner steps (needs your approval; I did not do any of this)
1. Review this commit. Confirm the repo visibility / runner-minute cost.
2. Install (GitHub App cannot write workflows): copy `tools/mission105/three-wards.pinned.workflow.yml` to `.github/workflows/mission105-persist-3-wards.yml` on `main` (new file name, so the Mission103 workflow stays as is).
3. Actions -> "Mission105 persist 3 oversized wards (chunked)" -> Run workflow, `wards = ALL`. Expected: plan (3 todo) -> rest (3 sequential) -> summary (storage only).
4. If a ward fails, read the `generate-failed` / `persist-failed` line in the summary and re-dispatch (stored wards skip).
Optional dry check without any download: `node tools/mission104/chunked-run.mjs --ward ikuno --chunk-mb 300 --max-mb 1200 --dry-run` (reads only the committed source lock).

## Nishi 2025 (12,603 buildings): one-command localhost view (owner PC)
```powershell
node tools\mission81-local-preview.mjs --ward nishi          # add --no-fetch to forbid any download and reuse an existing temp output only
```
Opens a **127.0.0.1-only, read-only** server; open `http://127.0.0.1:8137/mission37g-osaka-24ward-mvp.html?nobuiltin=1&ext=nishi25`.
It reuses `temp/mission81|80|79/.../nishi-2025` if present, else Range-fetches the needed PLATEAU 2025 meshes (free, capped by `--max-mb`/`--min-free-gb`) and converts locally; nothing under `public/` is written, nothing is uploaded. To view the stored private Nishi archive instead: download `plateau2025-nishi.tar.gz` from the private release yourself, extract to `<dir>\nishi25\`, and run `powershell -NoProfile -ExecutionPolicy Bypass -File tools\mission40f-serve-local.ps1 -ExtRoot "<dir>"` then `...?ext=nishi25`.
Prior evidence (headless software rendering, not device values): `data/reports/mission81/e2e.json` - buildings 12,603 in HUD, tileset HTTP 200, 3 real mouse clicks selected, top-down pixel diff 251,799 / oblique 560,494 of 1,410,000 px, no JS errors, Google requests 0, 3 expected-404 on optional files (`index.json`, layers-report, favicon). This is **headless evidence only; no device acceptance**.

## 24-ward acceptance: NOT met (evidence: `data/reports/mission105/acceptance-gap.json`, from `node tools/mission86-acceptance.mjs`, read-only)
`strictAcceptedWards = 0 / 24`. Item totals across 24 wards (pass count is 0 for every item):
| Item | Status across 24 wards |
|---|---|
| sourceLock2025 | 23 missing (no browser evidence), 1 fail |
| coverage (mesh accounting vs lock) | 4 fail (e.g. miyakojima manifest meshes 12 != lock 21), 20 missing |
| HTTP 200 of tileset/GLB | 24 missing on this checkout (no local tileset) |
| WebGL pixel diff | 24 missing |
| real click | 24 missing |
| ward coordinates inside N03 polygon (>=95%) | 24 missing |
| road/water | 24 missing |
Separate facts: committed `data/reports/mission80/batch-manifest.json` is an old snapshot (miyakojima 17,651 / fukushima 13,412 / minato 17,200 ok; konohana failed). Headless e2e exists only for nishi/minato/fukushima (`data/reports/mission80-ward2025/e2e.json`, `mission81/e2e.json`; the mission80 file's top-level `pass` is `false`) and is not device acceptance. Per Mission103/104: 21/24 wards stored privately (storage != acceptance); ikuno/abeno/yodogawa not generated. Counts: stored 21, browser-accepted 0, device-accepted 0.

## Next
After owner approval: dispatch (above) -> the 3 wards become stored (24/24 storage, still 0 browser acceptance) -> run `node tools/mission45e-preview.cjs` / Mission86 evidence collection on the owner PC per ward.
