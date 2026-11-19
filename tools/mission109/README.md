# Mission 109 - private PLATEAU 2025 QA, extended to the 24 Osaka wards

Status: code + offline tests + workflow candidate. **Nothing was run against the private release from the dev environment.**
Mission108 tools are unchanged (its pinned workflow still works). Mission109 wraps them with the 24-ward whitelist.

| File | Role |
|---|---|
| `wards.mjs` | 24 official N03 codes (27102..27128 as in Mission106), `ALL` or subset, rejects unknown/duplicate/27999/malformed, batch planner (1-6, default 4) |
| `fetch-verify.mjs` | per-ward isolated fetch+verify (one failure never stops others), checks `source.json` vintage 2025 **and** wardCode == expected, counts/sha only, no paths in summary |
| `qa.mjs` | headless Chrome QA (Mission108 `qaWard`) per ward on 127.0.0.1, per-ward isolation |
| `merge-matrix.mjs` | read-only join with Mission106 matrix: `storedVerified` / `ciBrowserQaPass` / `ownerDeviceAccepted` kept separate; prior run 41776480060 only for nishi, fukushima, yodogawa; everything else `unverified` |
| `gen-workflow.mjs` | builds the owner-only workflow from a pin commit (sha256 of git objects) |
| `qa-private-2025-24ward.workflow.yml` | generated candidate (not installed) |

## Safety design
- Owner-only gate (actor, triggering actor, default branch), `contents: read`, pinned checkout + sha256 check **before** the token is used.
- plan job (no repo code, no token) validates input against the whitelist and builds batches; QA job matrix `fail-fast:false`, `max-parallel:2`, 60 min/job, <=6 wards/job (1.5 GB unpack cap per archive => <=9 GB worst case; default 4).
- Token only in the fetch step; archives deleted after extraction; runner temp wiped in `always()`; artifact = counts-only JSON (no bytes, coordinates, screenshots).
- Re-run: pass only the failed wards (`failedWards` in the summary); `--skip-verified prev.json` flags unchanged-sha wards locally.
- Free: standard GitHub-hosted runner minutes only; no paid API.

## Roads / water (Phase B, unverified)
Archives carry no `layers/`, so road/water alignment stays `unverified` for every ward. Plan: owner exports per-ward `layers/` (from the local `livecity-data-pipeline`
via `tools/mission40g-build-ward-layers.cjs --check-only` first) into a separate private release asset `plateau2025-layers-<ward>.tar.gz`; reuse the same
safe-extract + read-only GET route; compare under identical `PHASE_B_VIEWS` cameras. No global coordinate shift is allowed; only a demonstrated cause may be fixed.

## Owner install (one time)
1. Copy `tools/mission109/qa-private-2025-24ward.workflow.yml` to `.github/workflows/mission109-private-2025-qa.yml` on `main` (the GitHub App cannot write workflows).
2. Actions -> "Mission109 private 2025 QA (24 wards)" -> Run workflow: `wards` = `nishi,fukushima,yodogawa` (regression) then `ALL`, `batch_size` = 4.
3. Download the `mission109-summary-*` artifacts and run
   `node tools/mission109/merge-matrix.mjs --fetch <fetch-summary.json> --qa <qa-summary.json> --run-id <id> --out data/reports/mission109/matrix-2025.json`.

Stored-pass is not render-pass; CI render-pass is not owner acceptance (0/24).
