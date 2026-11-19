# Mission 102: Mission101 persist workflow validation (static, free; nothing executed)

## Scope / what was NOT done
No real conversion, no upload/persist, owner workflow not invoked, no Vercel/R2/main/Windows changes, no paid API, no Actions minutes
consumed by this change (only local `node --test`). Stored data untouched. Licence/secret/PII gates unchanged.

## Findings
| Check | Result |
|---|---|
| YAML parse | **Not proven with a real parser.** No YAML library is installed here and python/ruby were not permitted. `tests/mission102-workflow-validation.test.cjs` checks a YAML subset structurally (spaces, even indent, block scalars, top-level keys, job names, heredoc termination). Owner must confirm schema when installing (GitHub shows a parse error on the file and in Actions if invalid). |
| Triggers | `workflow_dispatch` only (no push/PR/schedule/issue_comment). |
| Permissions | `contents: read` only. Token `LIVECITY_3D_DATA_TOKEN` used in 3 steps only (plan, connect check, persist). |
| Owner-only | `plan` gated on `github.actor` **and now `github.triggering_actor`** == repository owner, and default branch. `persist` needs `plan`; a skipped plan skips persist (no `always()`). *Fixed in this step: a re-run by another actor previously kept the original actor.* |
| Pinning | Full 40-char SHA checkout, `persist-credentials: false`, 13 embedded sha256 checked against the tree (twice, before and after convert). Actions are `actions/checkout@v4` / `setup-node@v4` (tag-pinned, not SHA-pinned; GitHub-owned, accepted risk, noted for owner). |
| Input allowlist | `wards` only; env-passed, `^[a-z]+$`, must be one of 24 official ids (expo 27999 excluded), no duplicates, max 6. |
| Idempotent resume | Stored wards are re-downloaded, must contain `tileset.json`, sha256 recomputed; nishi must equal the recorded hash; then skipped. **Fixed: the `overwrite` input is removed** (fail closed - the workflow can no longer re-convert/replace a stored ward). Failure of one ward does not touch others (`fail-fast: false`, `max-parallel: 1`, per-ward asset). |
| Per-ward integrity | strict output check (2025, unique ids, skipped 0), manifest-diff, sha256 re-download after upload (in pinned persist code). |

## Free-tier / fail-closed estimates (estimates, not measured)
- Runner minutes: repo is public, standard runners are free. Worst case per dispatch: plan 45 + 6 wards x 90 = 585 min cap (timeouts are hard stops; ward conversion itself is capped at 60 min). If the repo were private this would consume the plan's minutes - confirm before installing.
- Storage: private release assets are per-file capped at 2 GiB (enforced in `mission87-persist`). Nishi (12,603 buildings) is the only measured ward; the 3D Tiles output scale of ~1.1-1.2 KB/building gives roughly 0.6-0.7 GB for ~574k buildings (extrapolation, unverified for 2025 data). Release-asset total quota is not verified.
- Plan job re-downloads stored wards each run (egress on runner only, small).

## Nishi 2025 localhost preview (existing, Mission81)
```
node tools/mission81-local-preview.mjs --ward nishi
```
Open the printed `http://127.0.0.1:8137/mission37g-osaka-24ward-mvp.html?nobuiltin=1&ext=nishi25`. Options: `--no-fetch`, `--check-only`, `--max-mb 800`.
Existing evidence (`MISSION81_README.md`, `data/reports/mission81/e2e.json`): headless Chrome on a GitHub runner, 12,603 buildings / 30 tiles, 3/3 real-mouse picks, 0 JS errors, 0 Google requests. Software rendering: FPS/time not real-device values.
**Status: 1 ward (nishi) previewed/E2E in headless CI; 0 / 24 strict-accepted; 23 wards not generated. Windows device, road overlay, and real-device FPS unverified.**

## Owner approval / manual-install checklist (nothing below was done)
1. Review this README and the workflow diff; confirm the actions/minutes plan (public repo => free).
2. Confirm `LIVECITY_3D_DATA_TOKEN` is a fine-grained token scoped to `livecity-3d-data` only (contents write) and the data repo is private.
3. Confirm PLATEAU redistribution/private-storage terms for the stored derivative (source-lock records licence; not re-reviewed).
4. Copy `tools/mission101/persist-wards.pinned.workflow.yml` to `.github/workflows/mission95-persist-ward.yml` on `main` (one file, GitHub UI). Check the Actions tab shows no workflow parse error.
5. Dispatch first with ONE ward (e.g. `fukushima`); check run time, size, sha256 in the summary. Then batches of up to 6.
6. Browser acceptance (Mission86/88) is a separate step per ward; storage is not acceptance.
