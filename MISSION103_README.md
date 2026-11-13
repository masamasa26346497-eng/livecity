# Mission 103: one-dispatch, all-24-ward persist workflow (nothing executed here)

Final workflow (rendered, pinned): `tools/mission103/all-wards.pinned.workflow.yml`
(sources: `all-wards.pinned.workflow.template.yml`, `steps.part.yml`; regenerate with `node tools/mission103/render.mjs`).
Code pin is unchanged from Mission100-102 (`c4b79150067bba5acd37fbbf05c1e5af8b0af5b0`, 13 sha256 identical to the audited Mission101 closure; test-enforced).

## Flow
`plan` (owner-only, default branch; validates input; re-downloads stored wards, recomputes sha256, nishi vs recorded) ->
`pilot` (fukushima, if not stored) -> `rest` (remaining wards, `max-parallel: 1`, `fail-fast: false`, one fresh runner per ward;
only if pilot succeeded or was already stored) -> `summary` (aggregates per-ward result artifacts; fails the run if any ward failed).
Concurrency group `mission103-persist-all-wards` (no cancel) prevents overlapping runs. No automatic retry; re-dispatch resumes
(stored wards are verified and skipped, failed ones are retried once per dispatch). Input `wards`: `ALL` (default) or a comma subset.
Failure classes per ward: `generate-failed` (convert/strict check, nothing uploaded) vs `persist-failed` (re-verify/upload/sha256 check).
Token appears only in plan, connect check, persist. No `overwrite` input exists.

## Install (owner, once; GitHub App cannot write .github/workflows)
Copy `tools/mission103/all-wards.pinned.workflow.yml` to `.github/workflows/mission95-persist-ward.yml` on `main`
(edit URL: https://github.com/masamasa26346497-eng/livecity/new/main?filename=.github/workflows/mission95-persist-ward.yml ;
raw source at the pushed commit: `https://raw.githubusercontent.com/masamasa26346497-eng/livecity/<commit-sha>/tools/mission103/all-wards.pinned.workflow.yml`).
Then Actions -> "Mission95 persist ward to private repo" -> Run workflow with `wards = ALL`. Nothing more per ward.

## Counts (separate)
generated/stored: reported by the run summary (0 verified until the owner runs it; only nishi is known stored). HTTP fetch of stored data: 0.
CI browser render: 0 for new wards (existing Mission81 e2e covers nishi only). Device acceptance: 0. Storage is not acceptance.

## Verification done
`node --test tests/mission103-all-wards-workflow.test.cjs`: a strict block-YAML parser in the test (no YAML library available; python/ruby
not permitted) parses the file; structure, job graph, owner gate, pin, token exposure, 24 unique wards, hash closure checked.
Not proven: GitHub's own schema/expression validation, runtime behaviour of `fromJSON` matrices, artifact upload/download, 90-min/ward limits.
Expect ~22 wards x up to 90 min sequentially (roughly a day); public repo runner minutes are free (confirm repo visibility).
