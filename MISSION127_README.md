# Mission 127: private 3D data auth repair (minimal, read-only)

Status: **diagnostic proposal only.** No token was used, read, shown or recreated. Nothing was downloaded.

## Findings (from files, verified)
- Issue-comment runs use the workflow on the **default branch (main)**, so the PR-branch copy of `claude.yml` does not affect `@claude` runs.
- Main's `claude.yml` differs from the PR branch: it adds `concurrency`, `GH_TOKEN: ${{ secrets.LIVECITY_3D_DATA_READ_TOKEN }}` on the Claude step, and `--allowedTools` including `gh release list/view`.
- Main's mission94/95/105/108 workflows use a different secret, `LIVECITY_3D_DATA_TOKEN`. Only `claude.yml` uses `LIVECITY_3D_DATA_READ_TOKEN`.
- mission94's check requires `push=true`, so it never tests the READ token.

## Likely causes of the Mission126 failure (UNVERIFIED; the Mission126 output was not seen)
1. `gh release list/view` from the livecity checkout defaults to repo `livecity`, not `livecity-3d-data`. Needs `-R masamasa26346497-eng/livecity-3d-data`.
2. If the READ secret is missing, `GH_TOKEN` is an empty string and `gh` has no auth.
3. A fine-grained PAT needs the `livecity-3d-data` repository selected (resource owner = the user) with **Contents: Read** and Metadata: Read to see private releases/assets.
4. The Claude step receives the token in env, so any allowed `gh` command can use it. Acceptable only for a read-only, single-repo token.

## Owner steps (minimum)
1. On `main`, copy `tools/mission127/private-read-check.workflow.yml.template` to `.github/workflows/mission127-private-read-check.yml`.
2. Actions > "Mission127 private read check" > Run workflow (default branch).
3. The log shows HTTP codes and counts per secret only. Interpret:
   - READ leg OK: keep `claude.yml`; use `-R masamasa26346497-eng/livecity-3d-data` in gh commands.
   - READ leg 404: the PAT is not granted that repo; fix the PAT's repository access in GitHub settings.
   - READ leg "empty or missing": the secret is not set on this repo.
   - Only the `LIVECITY_3D_DATA_TOKEN` leg OK: either fix the READ token, or (owner decision, wider scope since it has push) point `claude.yml` `GH_TOKEN:` at that secret.

## Next step (only after the check passes)
West ward 2025 on localhost, one command: a read-only tool that downloads `plateau2025-nishi.tar.gz` into an empty directory outside the repo, verifies the hash, extracts, and starts `tools/mission40f-serve-local` with `--ext`. Not implemented; needs explicit owner approval for the download.
