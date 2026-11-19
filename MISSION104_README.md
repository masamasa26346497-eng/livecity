# Mission 104 - bounded chunked conversion for the 3 wards over the 1200MB gate

Code + static/fixture tests only. No conversion, persist, workflow dispatch, secrets, data publication or paid API was run.

## Diagnosis (run 41656252617, logs read)
- 21/24 wards stored (Nishi earlier + 20 new). Failed at "Convert ward": ikuno (1251MB), abeno (1275MB), yodogawa (1224MB).
- Failure text `FAILED inflated NNNNMB exceeds --max-mb 1200` is the PRE-FLIGHT gate in `tools/mission79-run.mjs`
  (`if (infl > maxMb) throw`). It sums bldg+tran inflated bytes from the source lock BEFORE any download, so nothing was fetched or uploaded.
- Compressed transfer is only 52-69MB per ward; 94% of inflated bytes are bldg GML. The CityGML->JSONL converter already streams per file;
  the cost the gate protects is on-runner disk holding all inflated GML at once. Largest single mesh is ~111MB.
- `summary` failing is by design: it exits 1 whenever any ward is generate-failed. Its log correctly reported
  `generate-failed: abeno ikuno yodogawa`, `persist-failed: none`. No summary bug found; no change made.

## Fix (new files only)
`tools/mission104/chunked-run.mjs`: fetch tran whole, then per chunk of meshes (<= `--chunk-mb`, default 300) fetch bldg -> convert ->
delete that chunk's scratch GML -> concatenate JSONL -> existing `mission79-build-ward-2025.cjs` unchanged.
- The 1200MB gate is NOT raised or bypassed: `--max-mb` bounds PEAK on-disk inflated bytes (all tran + one chunk).
- A new hard ceiling `HARD_TOTAL_MB=1500` bounds TOTAL inflated bytes (cannot be raised from the CLI).
- Dry-run plans (from the real source lock): all three wards give peak ~350MB (tran ~60MB + <=300MB chunk), total 1224-1275MB, 4-5 chunks.
- Resumable per chunk (`.done` markers); refuses non-empty `--final`; deletion confined to `<work>/chunk-N`.
- Audited files (`mission79-*`, `mission80-batch`, `mission87/95-persist`) are untouched, so the Mission101/103 pinned
  hash closure, the pinned SHA and the 21 stored wards' sha256 re-verification are unaffected. Tests: 32/32 (104 new + 101/102/103).

## Expected resources (estimates, not measured here)
- Disk peak ~350MB (was ~1.25GB); Node memory bounded by one GML file stream, tran file parse (<=~111MB) and the JSONL merge/build (same as successful wards).
- Network ~52-69MB compressed per ward, same as before. Time: not measured; similar to other wards (fetch + convert), bounded by 60 min ward timeout in the existing workflow.
- Cost: 3 jobs on standard runners; free on a public repo, otherwise billable minutes - owner decides. No paid API, no secrets.

## NOT done / owner steps for a 3-ward-only rerun (needs approval, not executed)
`chunked-run.mjs` writes a ward output dir only; it is not yet wired into the pinned batch/persist workflow, because wiring means editing
audited files and re-pinning. Required, after review of this commit: (1) approve a Mission105 that adds a pinned step calling
`chunked-run.mjs --chunk-mb 300 --max-mb 1200` for ikuno/abeno/yodogawa and re-renders the hash closure with a new PIN_SHA
(`.github/workflows` edits must be done by the owner); (2) approve billable-minutes if applicable; (3) dispatch with `wards=ikuno,abeno,yodogawa`
(stored wards stay re-verified and skipped). Licence/PII gates are unchanged.

## Status reminders
- Cesium browser acceptance of the 24 wards: still **0/24** (only Nishi data persisted earlier plus 20 new private results; none browser-verified).
- Safe Nishi localhost preview: serve with `tools/mission40f-serve-local.ps1 -ExtRoot <Nishi tileset dir>` (127.0.0.1 only, read-only, `?ext=` is
  localhost-only), then open `/mission37g-osaka-24ward-mvp.html?ext=<ward>`. Private results stay private; nothing is published.
