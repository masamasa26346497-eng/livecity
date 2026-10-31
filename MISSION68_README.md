# Mission 68 P0 - restore the 24-ward LOCAL 3D building view (no re-conversion, no upload)

Nothing in Git or Vercel changes. Public/Vercel still shows only the Git-tracked partial meshes (Sumiyoshi 9 tiles + 5 sample wards).
"3D not delivered" on Vercel for e.g. Abeno does NOT mean the local 24-ward conversion failed.

## 1. Check out this PR branch in a separate folder (do not pull/merge on main)
    git status --short --branch
    git fetch origin
    git worktree add --detach ..\livecity-pr24 origin/claude/issue-23-20261007-1424
    cd ..\livecity-pr24
(If `..\livecity-pr24` exists: `git -C ..\livecity-pr24 checkout --detach origin/claude/issue-23-20261007-1424`.)

## 2. Read-only verification (serves nothing, writes nothing)
    powershell -NoProfile -ExecutionPolicy Bypass -File tools\mission45e-preview.ps1 -LayersRoot "$env:LOCALAPPDATA\LiveCity-MapLayers-Out-24" -Plan
Defaults: output `%LOCALAPPDATA%\LiveCity-3DTiles-Out-24`, source `..\livecity-data-pipeline\public\map-data\osaka-city\buildings`
(override with `-OutRoot` / `-LegacyBuildings`). If the layers folder does not exist, omit `-LayersRoot` (buildings only).
Expect: 24/24 wards, sourceBuildings == convertedBuildings (574,213), 0 failures. If it fails, paste the `diagnostic:` line only (no paths/ids).
If the output folder is missing, run the 45D plan/convert/verify steps first (see MISSION45D_README.md); do not convert before confirming it is missing.

## 3. Serve and view
    powershell -NoProfile -ExecutionPolicy Bypass -File tools\mission45e-preview.ps1 -LayersRoot "$env:LOCALAPPDATA\LiveCity-MapLayers-Out-24"
Open http://127.0.0.1:8137/mission37g-osaka-24ward-mvp.html?ext45=1 and pick each ward in "3D building ward".

## 4. Acceptance per ward (record counts/status only; no ids, coordinates or paths)
building count == source count | source verified | tileset/GLB HTTP 200 (DevTools Network) | WebGL draws buildings |
switching ward unmounts the previous one | clicking a building shows a canonicalId in the right panel.
"24 wards displayed" only after all 24 pass; list any failing ward and the missing data.

## What CI verified (synthetic / Git-tracked fixtures only)
Existing 43G/45C/45D/45E/45I/45Z tests: 59/59 pass. CI has no real 24-ward data and no real-PC browser run.
## Publication
Needs separate owner approval (PLATEAU licence, OSM ODbL, secrets/PII review, transfer size). Gates stay false; `published.json` stays empty.
