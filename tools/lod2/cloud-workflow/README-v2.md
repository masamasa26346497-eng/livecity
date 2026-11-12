# LOD2 cloud preview workflow v2 (Mission 201) — review/copy artifact

Status: **NOT ACTIVE, NOT RUN.** Nothing here deploys, creates a Vercel project, or approves rights.
The Vercel GitHub bot "Ready" on PR #62 and the ChatGPT-plugin API 404 are **unresolved**; no preview URL is treated as a success.

## Files
- `lod2-cloud-preview.v2.yml` — complete workflow, copy as-is (after the two steps below).
- `verify-pins.mjs` — checks each pinned action SHA against its tag (needs network; run on your PC).
- `tests/mission201-workflow-v2.test.mjs` — offline policy tests (7 pass in the sandbox).

## Pins: what is and is not verified
**Verified (Mission 202, in the Claude Code Actions runner, `git ls-remote` against upstream tags):** all four pins match their tag commit:
`checkout v4.2.2`, `setup-node v4.4.0`, `upload-artifact v4.6.2`, `download-artifact v4.3.0`.
`verify-pins.mjs` can be re-run in any environment with git + network.
**Vercel CLI version: still unverified.** The runner could not query the npm registry (`npm view`/`curl`/WebFetch were denied), and I will not invent a number.
Instead of a file placeholder, it is now the run-time input `vercel_cli_version` (exact `X.Y.Z`). The deploy job checks that it exists on npm
(`npm view`, no secrets in that step) before the token step. Nothing needs editing in the file; deploy=false does not need it.

## Behaviour
| | deploy=false (default) | deploy=true |
|---|---|---|
| source | `source_sha` (40 hex) must be an ancestor of `origin/mission152-lod2-parallel` | same |
| secrets | none referenced | only the final step; needs `VERCEL_TOKEN/ORG_ID/PROJECT_ID` |
| rights | not needed | must type `CONFIRMED` |
| result | build + tests + audit + 3-day private artifact | additionally: dispatched from `main`, Environment `lod2-preview-approval` reviewer approval, artifact re-audit, `--target=preview` (no `--prod`) |

## Constraints to know
- `workflow_dispatch` only shows in the Actions UI once the file is on the **default branch (main)**. Merging it needs your explicit decision; I did not do it. (An alternative: `gh workflow run` also requires the file on default branch for dispatch.)
- Because the workflow is read from `main` but builds `source_sha`, a changed build script on the branch is *not* used unless you pass its SHA. Re-run with the new SHA.
- The artifact is only visible to people with repo access; it is not a public URL.
- The re-audit reuses `lod2-cloud-audit.mjs` from the same fixed SHA, which checks size, secret-like strings, and `rights.confirmedByHuman === false`. It runs without secrets, and `src/` is deleted before the token step.
- GitHub secret masking is not a substitute for scoping: use a token limited to one project.

## Minimum user operations
1. (none: pins verified; no PC commands needed)
2. (none: Vercel CLI version is given at deploy time as `vercel_cli_version`)
3. Copy the file (GitHub web UI "Add file" is enough, or `cp tools/lod2/cloud-workflow/lod2-cloud-preview.v2.yml .github/workflows/lod2-cloud-preview.yml` and commit via a PR to `main` (needs your approval).
4. For deploy only: create Environment `lod2-preview-approval` (required reviewers, branches: main) and add the three secrets there.
5. Run with `source_sha`, `deploy=false` first.
