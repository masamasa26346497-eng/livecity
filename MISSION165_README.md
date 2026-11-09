# Mission 165 (PR #51 only)
All 24 wards fetched fresh from PLATEAU Osaka 2025 on an empty runner, hardened, and strictly verified in headless Chrome (tileLoad>0, tileVisible>0, ON/OFF pixel diff>0, 0 JS errors). 615,234 LOD1 buildings, 0 duplicate gml:id across wards, 942.5 MB tiles (temp/, not committed, not persisted).
Small audit manifest: data/reports/mission156/audit-manifest.json (per-ward counts, bytes, tree sha256). Regenerate: node tools/mission165/audit-manifest.mjs.
Not verified: road/river overlay in the canonical viewer, private Release (LIVECITY_3D_DATA_TOKEN not set), storage not performed. 615,234 is the 2025 source count, not the same population as the old 574,213.
