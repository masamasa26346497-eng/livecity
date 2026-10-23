# Mission 41O: staged full scan, fail-closed HOLD proposal, tar cross-check (offline, read-only)

Not run on real data. Tested with synthetic fixtures only (`node --test tests/mission41*.test.cjs`).
No network, no upload. No source file or existing tar is changed, moved or deleted. All gates stay false.

## One command (Windows PowerShell 5.1, repository root)
```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools\mission41o-batch.ps1 -MaxSlices 0
```
Runs the existing 41K scan in slices of 5000 files (resumable; run again to continue), prints anonymous progress, then a hold-proposal summary.
Default `-MaxSlices 1` = one slice per run. Other modes: `-Mode Progress | Propose | TarCheck | UuidShape | Approve` (see the ps1 header).
GLB metadata (JSON chunk only) is a separate stage that already exists: `tools\mission41l-triage.ps1 -Mode GlbMeta`.

## Rules (fail closed)
- Only "scanned by the CURRENT detectors, nothing found" is `scanned-no-pattern`, and it is still not safe or approved.
- Findings, unscanned (binary/archive/cloud-only/oversize), not reached, stale state (old scanner/detector version), size changed: all **unreviewed**.
- Every file with a 41K detection is a **hold candidate**. `e6b68bd7` is always on the hold list.
- A proposal is not accepted by 41F. `-Mode Approve ... -ConfirmHold` writes a 41N-compatible ids-only plan; it only holds files back.
- A hold list from an incomplete scan is a minimum (`complete:false`).
- `TarCheck` never calls a tar safe (`safe:false`); a tar with hold candidates must be re-created into a NEW folder; old tars are left to the owner.
- `UuidShape` labels building-tiles detections (`uuid-shape-only`, `id-or-numeric-shape-only`, `free-text-or-field-present`) as candidates only; nothing is approved or removed from the hold list.
- Licence ledger (PLATEAU/OSM/N03/e-Stat) and secrets/personal-data ledger stay manual gates.
