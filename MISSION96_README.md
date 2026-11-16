# Mission 96 P0: Mission95 persist workflow, pinned to an audited SHA

## Problem
`main` has `.github/workflows/mission95-persist-ward.yml` but not the tools it runs
(`tools/mission80-batch.mjs`, `tools/mission95-persist-ward.mjs`, `tools/mission87-persist.mjs`, ...).
It checks out the default branch, so it fails. Merging the whole PR into main is not allowed.

## Fix (owner copies ONE file)
Replace the workflow on main with `tools/mission96/persist-ward.pinned.workflow.yml`
(same path: `.github/workflows/mission95-persist-ward.yml`). GitHub UI: open that path on main, Edit, paste, commit.
Claude's GitHub App cannot write `.github/workflows`, so this manual step is required.

Safety properties (checked by `tests/mission96-pinned.test.cjs`):
- checkout is `ref: 530446ea243b042f43bea0265a23d3b5211307dc` (full SHA, no branch tip). Reviewed code: https://github.com/masamasa26346497-eng/livecity/tree/530446ea243b042f43bea0265a23d3b5211307dc/tools
- before anything runs: `git rev-parse HEAD == PIN`, clean tree, `sha256sum -c` against 13 hashes embedded in the
  main-resident workflow (so a tampered checkout fails even if the SHA were somehow swapped). Hashes are re-checked
  right before the token step, because the convert step runs pinned code.
- token only in two steps: read-only `curl` connect check (no repo code) and the single persist step.
  Convert / strict check / verify steps have no token. Data repo is hard-coded `masamasa26346497-eng/livecity-3d-data`,
  private is mandatory, `--allow-public` is rejected, sha256 re-download verification is mandatory.
- owner-only `workflow_dispatch`, default branch only. Ward input is a choice: `nishi` only (first run).
- preflight: ward exists in N03 polygons, not expo 27999, source lock is `plateau-27100-osaka-shi-2025` with license and
  attribution, unique ward codes. Strict output check later rejects non-2025, duplicate IDs, skipped > 0.
- cost: 0 yen added (public CDN range reads, free runner minutes on a public repo, private-repo release assets).
  Private-repo storage/LFS quotas were not verified.

## Regenerate / audit
```
node tools/mission96/pin-audit.mjs list     # code + data closure (13 files, all tracked)
node tools/mission96/pin-audit.mjs hashes
node tools/mission96/pin-audit.mjs render   # rebuild the workflow from the template
node --test tests/mission96-pinned.test.cjs
```
To pin a new SHA: change `PIN_SHA` in pin-audit.mjs, review the diff of the closure, render, re-copy.

## Not verified
- The workflow was not executed (GitHub Actions cannot be triggered by Claude). Static checks only.
- Code at the pin was read (`persist` uses `gh` with the dedicated token; GITHUB_TOKEN removed from env), not sandbox-run.
- `actions/checkout@v4` and `setup-node@v4` are tag-pinned, not SHA-pinned.
- Mission94 connect-job logs were not inspected (no run id available). Stored wards: 0 / 24 until the owner runs this.
