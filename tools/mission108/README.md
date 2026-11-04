# Mission 108 - read-only verification of the PRIVATE PLATEAU 2025 tilesets (nishi / fukushima / yodogawa)

Status: code + offline tests only. The workflow candidate was **never run**; the private release was **never reached** from the dev environment.
Cesium acceptance stays **0/24**. Nothing here is acceptance; the summaries are `acceptance:false`.

## Files
| File | Role |
|---|---|
| `lib.mjs` | ward allow-list (3), tar listing policy (regular files/dirs only, no links/devices/abs/`..`), empty-dir-only extraction + post-walk symlink check, tileset/GLB integrity, release GET (token only in `Authorization` to `api.github.com`; signed redirect fetched without it) |
| `fetch-verify.mjs` | download exactly-one asset per ward, sha256, extract, verify. Writes `<dest>/<ward>25/`. Summary = counts/sha only. Refuses a non-empty `--dest`. |
| `qa.mjs` | 127.0.0.1-only server + headless Chrome: HTTP 200 of tileset/GLB, WebGL readback pixel delta, 3 real mouse clicks, N03 containment >= 95%, Google 0, JS errors 0, road/water state (reported, never claimed) |
| `local-run.mjs` | owner-PC one command: fetch+verify then serve on 127.0.0.1 |
| `qa-private-2025.workflow.yml` | owner-installed workflow candidate (pinned; see below) |

## Owner PC (PowerShell 5.1)
```powershell
$env:LIVECITY_3D_DATA_TOKEN = Read-Host "read-only token for livecity-3d-data"
node tools\mission108\local-run.mjs --wards nishi,fukushima,yodogawa
# open http://127.0.0.1:8137/mission37g-osaka-24ward-mvp.html?ext=nishi25,fukushima25,yodogawa25
# then pick the ward in the left "3D buildings ward" selector (only the selected ward is mounted)
```
Reuse later without a token: `node tools\mission108\local-run.mjs --reuse`. Headless QA on the same data:
`node tools\mission108\qa.mjs --root temp\mission108\root --wards nishi,fukushima,yodogawa --summary qa-summary.json`.
Token scope: fine-grained PAT, repository `livecity-3d-data` only, **Contents: read** only. Close the shell afterwards.

### Windows notes (Mission 110)
`local-run.mjs` resolves its own location with `fileURLToPath`, so Japanese folders (e.g. `ドキュメント`), spaces and `%` work. `--reuse` first checks `<root>\<ward>25\tileset.json` and stops with exit code 2 (nothing deleted or overwritten) if it is missing. A failing server child propagates its exit code.
Recommended:
```powershell
node tools\mission108\local-run.mjs --reuse
```
Direct start (workaround; same server, 127.0.0.1 only):
```powershell
node tools\mission40f-serve-local.cjs --ext temp\mission108\root --port 8137
# http://127.0.0.1:8137/mission37g-osaka-24ward-mvp.html?ext=nishi25,fukushima25,yodogawa25
```

## CI (owner installs once)
1. Copy `tools/mission108/qa-private-2025.workflow.yml` to `.github/workflows/mission108-private-2025-qa.yml` on `main` (the GitHub App cannot write workflows; owner auth is not bypassed).
2. Actions -> "Mission108 private 2025 QA" -> Run workflow, `wards` = `nishi,fukushima,yodogawa` (or a subset).
3. Result: the step summary and one artifact `mission108-summary` (JSON counts only). No archive, tileset, GLB or screenshot is uploaded.
Secret `LIVECITY_3D_DATA_TOKEN` is used only by the fetch step (read access to the private data repo is enough).
Gates: owner actor + triggering actor + default branch; `contents: read`; pinned checkout + sha256 list of the tool files checked before the token is used; extraction only into an empty runner temp dir, which is wiped in an `always()` step.
If the data repo license/privacy review does not allow redistribution, nothing here publishes: no release, no Pages, no public artifact.

## Phase B (prepared, not run)
`PHASE_B_VIEWS` in `qa.mjs` fixes two identical camera views (top 2500 m, oblique 1200 m) for buildings / roads / water. Archives contain no `layers/`, so roads/water stay `unverified`.
No coordinate shift or ground switch is applied anywhere. A shift may only be proposed after same-view evidence from real layer data exists.

## Not proven
Real archive layout (assumed `tileset.json` at root or under one folder), real tar listing format on the runner (GNU tar), real render of 2025 tiles, workflow acceptance by GitHub's validator.

## Mission 112: Windows bsdtar / PowerShell 5.1
- Tar listing: names come from `tar -tzf`; type/size from `tar -tzvf` (GNU or bsdtar layout). Every verbose line must end with the plain name; mismatch, unknown layout, links, or odd names fail closed. Extraction retries without `--no-same-owner/--no-same-permissions` only if this tar rejects them before writing anything (empty dest, post-extract symlink/escape walk unchanged).
- `fetch-summary.json` is now ASCII-safe JSON (non-ASCII as `\uXXXX`). For summaries written by older versions use:
  `Get-Content .\temp\mission108\fetch-summary.json -Raw -Encoding UTF8 | ConvertFrom-Json`
- A failed run leaves its `--root` untouched. Retry with a NEW root (read-only fetch from the private Release; no deletes):
  `node tools\mission108\local-run.mjs --wards nishi,fukushima,yodogawa --root temp\mission108\root4`
- Fetching and sha256 matching of the 2025 assets is confirmed by the owner's run; rendering is NOT yet verified. Never use the old pc23 data.
