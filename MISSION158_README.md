# Mission 158 – private Release store for generated 3D Tiles

Branch `mission156-osaka24-fresh-plateau` (PR #51). Not merged, not published. PR #24 / #50 / `public/` untouched.

## Facts and limits
- `livecity` is public → workflow artifacts and its `GITHUB_TOKEN` are not suitable for tiles. `GITHUB_TOKEN` cannot see `livecity-3d-data`
  (auth test from the Actions job: **HTTP 404**, so no read/write was possible from here).
- Existing Release `plateau2025-converted` (24 archives) is **protected in code** (`PROTECTED_TAGS`); writes only go to new tags `m158-<id>`.

## Tools
| Command | What |
|---|---|
| `node tools/mission158-private-release.mjs auth-test` | prints status/permissions only, never the token |
| `... audit [--tag T] [--inspect <ward>\|all]` | read-only: assets, size, digest, GitHub-digest vs downloaded sha256, tileset/GLB/missing-tile count |
| `... put --ward W --dir D --tag m158-X [--confirm-write]` | dry-run by default; check-before-write, no overwrite, round-trip sha256 check, deletes only its own partial uploads |
| `... get --tag T --ward W` | download + digest/manifest check + extract |
| `node tools/mission158-private-preview.mjs --tag T --ward W` | token stays in Node; browser sees only `http://127.0.0.1:8158/tileset.json` |

## Credential setup (one-time, human)
1. Create a fine-grained PAT: resource owner = you, **only** repository `livecity-3d-data`, Repository permission *Contents: Read* (add *Write* only for `put`).
2. Add it as repo secret `LIVECITY_3D_DATA_TOKEN` in `livecity`. Never echo it. Rotate/expire ≤90 days.
3. Local use: `export LIVECITY_3D_DATA_TOKEN=...` then run the commands above.

## Workflow
Claude cannot write `.github/workflows`. **One manual step:** copy `tools/mission156/mission156-fresh-plateau.workflow.yml.txt` to `.github/workflows/mission156-fresh-plateau.yml`
(manual dispatch, `contents: read`, tiles go to the private Release only, public artifact holds small reports only).

## Strict browser check
`strictBrowserOk` now requires `drawCommands > 0` (max over ~40 frames + tileset statistics). Kita (Mission 157: drawCommands=0 but "complete") must be re-verified.

## LOD2 readiness (design only; PR #50 not touched)
Storage is a prerequisite, not sufficient. Still needed: (1) identify CityGML with `bldg:lod2Solid`/`lod2MultiSurface` (Osaka 2025 package contents unverified here);
(2) join to LOD1 by `gml:id` (canonical id kept verbatim); (3) LOD2 mesh conversion + roof/wall check; (4) per-building LOD1 fallback; (5) viewer switch.
Manifest extension: `lod: {level: 2, lod2: true, lod2Coverage: {buildingsWithLod2, buildingsLod1Only}, joinKey: "gml:id", fallback: "lod1"}` stored as a separate tag/asset (`m158-<id>-lod2`).
Wards without LOD2 stay LOD1.
