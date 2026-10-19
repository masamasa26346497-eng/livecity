# Mission 41L: triage of the 41K content-scan result (offline, read-only)

Not run on real data. Tested with synthetic fixtures only (`node --test tests/mission41*.test.cjs`).
No network, no upload, no source file is changed/moved/deleted. No gate is opened (`autoApproved:false`).

## 1. State cache fix (41K)
`content-scan-state.json` used to be reused when only size+mtime matched, so a changed detector never re-checked old files.
Now the state stores `scannerVersion` (`SCANNER_VERSION`, currently `41L-1`) and `detectorFingerprint` (hash of every detector
regex + flags, the binary-extension sets and the chunk parameters). If either differs (or the state has none = legacy 41K state),
all old entries are dropped and everything is re-scanned; the console shows `stateInvalidated`. The OneDrive cloud-only skip is unchanged.
Next 41K run on your PC will therefore re-scan the 146 files once.

## 2. Commands (PowerShell 5.1, repository root)
```powershell
# anonymous list: the 3 files with detections (id/category/ext/count) + unscanned binaries by category/kind/ext
powershell -NoProfile -ExecutionPolicy Bypass -File tools\mission41l-triage.ps1
# shape CLASSES of the matches in one file (no value is printed)
powershell -NoProfile -ExecutionPolicy Bypass -File tools\mission41l-triage.ps1 -Mode Classify -Id <8hex>
# GLB JSON-chunk metadata only (BIN chunk not inspected; GLB stays unscanned)
powershell -NoProfile -ExecutionPolicy Bypass -File tools\mission41l-triage.ps1 -Mode GlbMeta -PathContains fukushima
```
Re-run 41K first (`tools\mission41k-content-scan.ps1`) so the report comes from the current detectors; Report warns if it is older.

## 3. Deciding the phone-number detections (owner-local, manual)
`classify` prints classes such as `shape 2-4-4 | landline-major-city(03/06) | inside-uuid-like-id`:
- `inside-uuid-like-id` / `inside-numeric-list` / `adjacent-to-letters`: shapes consistent with building ids, coordinates or
  numeric arrays (likely false positives). Still unconfirmed.
- `free-text-or-field`: look at it yourself.
Manual check (no command here prints the number): `node tools\mission41k-content-scan.cjs lookup --manifest <manifest> --id <id>` prints
ONE path on your PC only; open that file in your own editor and search `\d{2,4}-\d{2,4}-\d{4}`. Decide per file: public facility contact
(OSM/e-Stat field, may be OK to publish if the source licence allows), id/numeric artefact, or personal number (exclude).
Record the decision yourself; the tools never auto-mark safe/excluded and never publish.

## 4. False-positive classes (proposal, human decision required)
| class | typical source | how it looks |
|---|---|---|
| id/uuid fragment | PLATEAU gml:id | `inside-uuid-like-id` |
| numeric array | coordinates, heights | `inside-numeric-list` |
| public facility contact | OSM `phone=` tag in facilities | `free-text-or-field`, usually landline/toll-free |
| personal number | memos, exports | `free-text-or-field`, often mobile; exclude |

## 5. Binary files (29 unscanned)
`report` splits unscanned by kind (glb / 3dtiles-binary / image / archive / osm-binary / gis-binary / other). `glb-meta` reads only the
GLB header + JSON chunk (cap 8 MiB), runs the 41K detectors on it, and reports flags (extras, asset.copyright, data URI, external URI,
standard extension names). It never reads BIN chunks or textures. Images (EXIF), archives and other formats stay unscanned.

## 6. Next step proposal
After re-running Stage Fukushima: `tools\mission41k-content-scan.ps1 -Stage All -MaxFiles 5000` (resumable; repeat until
`notReached=0`) for the 43,258 files. Expect more phone/e-mail matches in CSV/JSON; use `report` (anonymous aggregate) to review.
