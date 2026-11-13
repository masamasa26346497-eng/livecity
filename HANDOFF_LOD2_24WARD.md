# HANDOFF: 24-ward restore / click QA (PR #50, branch mission152-lod2-parallel)

Status as of 8bd0085 (nothing here was executed by this document).

## 1. Re-run the real click QA (needs ONE owner browser action)
GitHub App cannot write `.github/workflows`, so the workflow must be registered by the owner (or ChatGPT connector):
1. Open https://github.com/masamasa26346497-eng/livecity/branches -> New branch `ci/mission217-qa-once` from `main`.
2. On that branch: Add file -> Create new file `.github/workflows/mission217-qa-once.yml`.
   Paste VERBATIM: https://github.com/masamasa26346497-eng/livecity/blob/8bd0085/tools/lod2/cloud-workflow/mission217-qa-once.yml (use "Raw").
3. Commit directly to `ci/mission217-qa-once`. The push triggers the run. Do NOT open a PR / merge to main.
- Code run is pinned to TOOLS_SHA cbd5353 (real `__mission37dQA` hook, localhost + ?qa=1).
- Uses existing secret LIVECITY_3D_DATA_READ_TOKEN only in the fixed curl fetch step; no artifact/cache/deploy.
- Confirm no other ci/* run is in progress first (Actions tab).

## 2. 24-ward Preview on Vercel: minimal blockers
- Merged tree = 942.2 MiB (lod-only 328.5, tiles 465.9). A single Vercel static deploy of this is not plausible on Hobby (limits unverified here) and would upload private PLATEAU-derived data externally. NOT done.
- `rights.confirmedByHuman` is still false; no rights approval was given by this task (approval covered QA re-run and preparing an auth-protected non-production preview only).
- Existing Vercel preview is behind auth (302) and contains no 24-ward data; the team scope checked via connector had 0 projects, so the earlier PR #55-59 previews likely live in another account/scope. No URL is claimed.
- Realistic options (need owner decision, none executed):
  a. Keep 24-ward verification on the Actions runner only (current method, no external upload).
  b. Preview = kita+chuo LOD2 bundle + other wards' `lod/` only; still ~330 MiB, needs owner to confirm Vercel plan limits and an explicit OK to upload PLATEAU-derived data to an auth-protected project.
  c. Serve from the private Release via an authenticated proxy (needs new infra; not built).
- Partial display must not be reported as 24-ward complete.

## 3. Acceptance still pending
Real-click PASS for LOD2 (kita, chuo) and LOD1 (sumiyoshi, hirano, ikuno); colour (blue-grey); ward selection. Unverified: whether LOD2 gml:id starts with `bldg_` (37G treats only `^bldg_` as buildings).
