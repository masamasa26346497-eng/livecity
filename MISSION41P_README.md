# Mission 41P: online-first source registry and fail-closed transfer gate

Offline and read-only. No network, no upload, no paid API. Tested with synthetic fixtures and repo files only. No PC path, key, e-mail, phone number, tar, manifest or raw data is in this change. All gates stay false.

## 1. Source registry (`config/source-registry.json`)
18 entries: which data can be rebuilt from a public source and which exists only on the owner's machine.

| reconstructability | meaning | count |
|---|---|---|
| confirmed | URL + script + a record inside this repo of a past successful fetch | 3 |
| candidate | URL and/or script exist, but no in-repo record of a successful fetch, or the URL is resolved at run time | 9 |
| unknown | no usable public source recorded in the repo | 6 |

Rules enforced by `node tools/mission41p-registry-check.cjs`:
- a `sourceUrl` must be https and the exact string must appear in the repo file named in `urlEvidence` (no guessed URLs)
- every script must exist; `dependsOn` must resolve with no cycles
- `approved` must be false and `licenceClaim.verifiedAgainstPrimary` must be false: licence texts are claims copied from repo config, not approvals. Approval stays a manual gate (41H ledger)
- no absolute/local path and no e-mail text

Not shown: that a source is still reachable today, that re-fetching reproduces the owner's bytes (OSM and Wikidata change over time; PLATEAU archive URLs are resolved at run time), or that any licence permits redistribution.

What this suggests: PLATEAU, OSM layers, e-Stat/Osaka statistics, Commons metadata and the photo index have public sources, so those do not have to be moved from a PC (the PLATEAU archive is about 1.3GB per earlier reports). Locally only: the legacy 24-ward building tiles (until regenerated and compared), OSM-fallback and unclassified folders, the OSM PBF input, and everything in `owner-local-unclassified`. Derived Cesium tiles are rebuildable from those inputs.

## 2. Transfer gate (`tools/mission41p-transfer-gate.cjs`)
`propose` (41O) only lists hold candidates. "Not a hold candidate" never meant "safe to pack/upload", and the proposal now says so (`transfer.uploadAllowed:false`, `notHoldCandidateMeansSafe:false`).

Classes: hold candidate (findings, `e6b68bd7`, `--hold-id`), unreviewed (binary, archive, cloud-only, over-size, never reached, stale state, size changed), scanned-no-pattern (still not approved), allowlisted.

A file is only "eligible for owner approval" when it is in an owner-reviewed allowlist (reviewer and date filled, ids only), is scanned-no-pattern under the current detectors, is not a hold candidate, and all three gates are literally `true` in a gates file. With the default (all gates false) the eligible count is always 0. `uploadAllowed` is always false: transfer is a separate phase.

```
node tools/mission41p-transfer-gate.cjs allowlist-template --out <NEW dir>
node tools/mission41p-transfer-gate.cjs evaluate --manifest m.json [--state s.json] [--allowlist a.json] [--gates g.json]
```

41O fixes: a file whose size differs from the manifest no longer counts as "reached" in `progress`.

Scan cache limits (documented, not fixed): validity is size + mtimeMs only, no content hash. An in-place edit that keeps both keeps its old result. Detectors are regexes; a clean result is not a review. A hold list from an incomplete scan is a minimum. Binary, archive and GLB content is not scanned (GLB JSON chunk is a separate 41L stage).

## 3. CI
`node --test tests/mission41*.test.cjs` runs everything (127 tests). `node tools/mission41p-registry-check.cjs --markdown` prints a table for the Actions job summary. I cannot edit `.github/workflows`, and existing workflows are untouched. A job to add by hand, if wanted:
```yaml
on: { workflow_dispatch: {} }   # manual only; add pull_request only if you decide so
jobs:
  registry:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: node --test tests/mission41p-registry-gate.test.cjs
      - run: node tools/mission41p-registry-check.cjs --markdown >> "$GITHUB_STEP_SUMMARY"
```

## 4. PR checklist (no PowerShell needed from the owner)
- [ ] Review `config/source-registry.json`: any `candidate` you can confirm against the primary source? Any wrong label?
- [ ] Decide per source family whether online re-fetch replaces transfer (needs a separate approved fetch job; large downloads and paid APIs are not part of 41P)
- [ ] Licence ledger (41H) stays manual: PLATEAU, OSM, N03, e-Stat, Commons per-file
- [ ] Nothing is uploaded; OneDrive cloud-only placeholders (1,341) are a local listing and prove nothing about cloud access

Later phase (separate owner approval, not started): one-off owner-approved transfer from PC/OneDrive, only for allowlisted files, after all three gates are opened by hand.
