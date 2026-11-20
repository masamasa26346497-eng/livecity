# Mission 160 (PR #51 branch only)

- `node tools/mission158-private-release.mjs setup` prints the minimal-permission PAT steps (fine-grained, one private repo, Contents read; write only for `put`). Value is never printed.
- `auth-test` is read-only and returns `READ-OK` only if the private repo AND the `plateau2025-converted` Release are readable with `LIVECITY_3D_DATA_TOKEN`; without the secret it says `NOT-TESTED`.
- `tools/mission160-local-serve.mjs`: loopback-only multi-ward tile server (+ `/manifest.json`, `/adapter.mjs`). Attach to the existing viewer from devtools without editing its HTML: `(await import('http://127.0.0.1:8160/adapter.mjs')).attach(viewer, Cesium)`.
- Size guard (`--max-mb`, default 900) is now a non-retried failure. Kita needs `--max-mb 1300` (958 MB inflated).
- Browser check is stricter: tileset-only counters (`tileVisible`/`tileLoad` events) must be > 0. Globe/skybox draw commands no longer count.
  **Open issue:** with this check, headless SwiftShader + CesiumJS 1.121.1 shows 0 visible/loaded tiles for Chuo and Kita (HTTP 200 for all 119 URIs, bounds OK, camera frustum intersects the tileset). Root cause not found. Earlier "complete" results were therefore not proof of drawing. Status is `served` until fixed.
