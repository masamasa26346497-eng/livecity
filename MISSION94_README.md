# Mission 94 P0: safe private-repo connection check

## Design
- `.github/workflows/claude.yml` (the workflow triggered by PR/issue comments) does NOT receive `LIVECITY_3D_DATA_TOKEN`, so prompt injection via comments cannot reach the PAT. Test-enforced.
- The connection check is a separate `workflow_dispatch`-only workflow: `tools/mission94/private-connect-check.workflow.yml`.
  No checkout (no untrusted code runs), runs only on the default branch and only when the actor is the repo owner, token exists only in one step env and is masked, GET requests only, stops on any failure (no fallback to other credentials or public repo).
- Claude's GitHub App cannot write `.github/workflows`, so the owner installs it.

## Owner steps
1. Copy the file to `.github/workflows/mission94-private-connect-check.yml` on `main` (workflows must exist on the default branch to be dispatched; this is a workflow-only change, no data).
2. Actions > "Mission94 private connect check" > Run workflow. Expected: `visibility=private token_push=true`, `stored wards 0 / 24`.
3. Paste the log (it contains no token).

## Status
- Connection result: NOT run (Claude cannot run workflows or read secrets). Stored wards: 0/24.
- PLATEAU 2025 licence terms and Releases size/billing limits: unverified (no web access). No real data uploaded.
