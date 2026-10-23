# Mission 43: per-ward rebuild, fail-closed (offline)

`tools/mission43-ward-rebuild.cjs`

| command | what it does |
|---|---|
| `manifest [--write]` | per-ward migration manifest (24 wards) -> `data/reports/mission43/ward-migration-manifest.json` |
| `rebuild --ward <id> --out <NEW dir>` | legacy tiles -> 3D Tiles (40B converter) -> verify. Fail-closed (exit 3) unless every source tile is Git-tracked. Refuses non-empty/tracked output. |
| `verify --dir <tileset>` | tileset.json -> every uri exists, GLB header/length valid, ids == build-report == attrs, no dup ids, wardCode, size cap 60MB |
| `preflight --src <buildings dir> [--gates g.json]` | owner-PC pre-check: per-ward file/byte counts, other-folder aggregate, archive counts. No names/paths/values. `eligibleForUpload` and `uploadAllowed` are always 0. |
| `sources [--online] [--write]` | HEAD-only reachability of PLATEAU policy / OSM copyright / Osaka 2024 dataset page. Reachability is not licence approval. |

Gates (`licenceApproved`, `noSecretsReviewed`, `noPersonalDataReviewed`) stay false; this tool never opens them, uploads, packs or deletes.

Licence notes: general PLATEAU site policy and OSM ODbL (attribution "© OpenStreetMap contributors") are general terms. The Osaka 2024 dataset page terms must be read per dataset by a human (other Osaka datasets, e.g. Expo 2025 site, can differ). Until recorded, no third-party data is committed.

Owner-PC (only if public re-fetch is not approved): `tools/mission40c-run-local.ps1 -Mode validate|convert -Wards <id>`, then `preflight`.
