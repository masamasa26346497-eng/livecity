# Mission 129: 21 unrendered wards, and why `gh release view` failed in Claude runs

Target = 24 wards minus the three the owner has seen rendered (nishi, fukushima, yodogawa) = **21**:
`node tools/mission129/wards21.cjs --list` (miyakojima, konohana, minato, taisho, tennoji, naniwa, nishiyodogawa, higashiyodogawa, higashinari, ikuno, asahi, joto, abeno, sumiyoshi, higashisumiyoshi, nishinari, tsurumi, suminoe, hirano, kita, chuo).

## Root cause of "release not found" (verified in the action source, no token values seen)
`anthropics/claude-code-action` sets `process.env.GH_TOKEN = <GitHub App token>` (and `GITHUB_TOKEN`) inside the Claude step
(`src/entrypoints/run.ts:191`; `git-config.ts:115` too). `GH_TOKEN: ${{ secrets.LIVECITY_3D_DATA_READ_TOKEN }}` on the step `env:` is therefore
overwritten before any `gh` call. The App token only covers `livecity`, so `gh release view -R masamasa26346497-eng/livecity-3d-data` returns not found.
The Mission127 diagnostic job passed because it used the READ secret directly in its own `curl` step. So: secret and PAT are fine; the env pass-through is the problem.
Re-asking for the same secret setting will not fix it. Do not rely on `gh` inside Claude for private data.

## Fix (owner install, once)
Copy `tools/mission129/fetch-21-readonly.workflow.yml.template` to `.github/workflows/mission129-fetch-21.yml` on main and dispatch it.
READ token only in one `curl` GET step; data goes to `RUNNER_TEMP`; nothing is uploaded; then `wards21.cjs --check` runs a data-level check.
Not run by Claude. Unverified assumption: archives extract to `<ward>25/` (the layout the Mission116 server expects).

## What this does NOT prove
`--check` is file-level only (tileset parses, GLB headers, ids, root transform inside ward bbox). **WebGL/pixel rendering of the 21 wards is not done: 0/21 browser-accepted.**
Rendering needs the data on a machine with Chrome (owner PC via Mission116 `-Mode serve`, or a later CI step once the fetch works).
