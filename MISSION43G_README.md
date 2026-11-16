# Mission 43G: read-only verification and loopback preview of 43F output

All gates stay false (`licenceApproved`, `noSecretsReviewed`, `noPersonalDataReviewed`, `uploadAllowed: 0`). Nothing here uploads, publishes, copies into `public/`, or changes the viewer.

## Tools
- `tools/mission43g-verify-local.cjs` (+ `tools/mission43g-verify.ps1`, ASCII, PowerShell 5.1): re-verifies every ward in a 43F output root **from the files on disk**; `status.json` is never trusted alone. Output = ward ids, counts, reason kinds only. Writes nothing.
  - Root must be outside the repo, a real directory (no link/junction), carry the 43F marker, and hold only 43F entries.
  - Per ward: link scan, 43 `verifyDir` (tileset refs, GLB headers/length, id/attrs counts, duplicates, wardCode), ids/attrs identity per tile, `verify-report.json` ok and not claiming publication, status count equals disk count.
  - With `--src`: also the 43D audit (must be ready) and canonical-id identity with the read-only source (catches a self-consistent id swap that the structural check alone cannot see).
  - `ok` = every ward in scope verified. `complete` = all 23 PC-only wards verified (default scope).
- `tools/mission43g-local-preview.cjs`: default is **plan** (verifies, serves nothing). `--serve` is the explicit opt-in. Binds `127.0.0.1` only, GET/HEAD only, Host/Origin must be loopback, no CORS headers, no directory listing, links never followed. Only verified wards, and only `tileset.json`, `source.json`, `build-report.json`, `tiles|lod/*.glb`, `ids|attrs/*.json` are served under `/ext-3dtiles/<ward>/`. The viewer (`public/mission37g-osaka-24ward-mvp.html?ext=<ward>`) is the unchanged repo file.

## "Local" means the data is not uploaded
The existing 37G page loads CesiumJS from the jsDelivr CDN and base-map tiles from external tile servers, so the browser makes external connections while viewing. Only the building data stays on the PC.

## 43F audit result (minimal fix)
- Fixed: a link planted in a resumed output root (e.g. `status.json.tmp` pointing elsewhere) made `writeFileSync` follow it. `checkOutRoot` now refuses any link in the root.
- Checked, no change needed: `L.convertWard(force:true)` (its builder does `rmSync(out)`) is only ever handed a freshly created, empty attempt directory (non-recursive `mkdir`, attempt number never reused); the source fingerprint is re-checked after conversion; a stale or forged `ok` status cannot pass the 43G verifier.

## Not done
No real 23-ward conversion, no run on the owner PC, no browser check of the preview, no PowerShell 5.1 run.
