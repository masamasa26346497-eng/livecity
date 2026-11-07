# Mission 107 — real-render verification status

## What was actually run (runner, headless Chrome 156, free)
- `node tools/experiments/mission37h_multiward_qa.mjs` against the PUBLIC 2024 samples in the repo.
  kita/chuo/tennoji/nishi: pass (3/3 real clicks each); naniwa 5/6 (known overlap mis-pick, pre-existing).
  jsErrors 0, Google requests 0. Evidence: `data/reports/mission107/public-2024-render-qa.json`.
- This is 2024 data. It is NOT 2025 acceptance and does not move the 0/24 counter.

## What could not be done
- Nishi/Fukushima/Yodogawa 2025 tileset HTTP 200, pixel diff, N03 containment, road/water alignment:
  the private release is not reachable from this runner (no token, no temp/ data). Status: unverified.
- Workflow file: the GitHub App cannot write .github/workflows, so no candidate was added there.

## Owner PC, minimal steps
1. `node tools/mission81-local-preview.mjs --ward nishi` (reuses existing 2025 output; repeat for fukushima, yodogawa)
2. `node tools/mission88-collect-evidence.mjs --ward nishi` (writes evidence JSON; origin is auto-detected as local-pc)
3. `node tools/mission86-acceptance.mjs --json` to judge. Commit only the evidence JSON, never tilesets.
