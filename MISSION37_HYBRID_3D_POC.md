# Mission 37 | Live City Hybrid 3D Engine POC

## Purpose
Validate a hybrid rendering path without interrupting Mission 36L building-photo linkage.

## Isolation rules
- Branch: `feature/mission-37-hybrid-3d-poc`
- Do not modify production HTML:
  - `public/osaka_3d_buildings.html`
  - `public/osaka_3d_buildings.fullward-v3.html`
- Do not modify canonical building IDs, building geometry, or photo-link datasets.
- Do not commit API keys.

## POC A
- CesiumJS as the streaming 3D renderer.
- Google Photorealistic 3D Tiles as the visual city layer.
- Umeda as the initial test area.
- Attribution remains on-screen.
- Runtime diagnostic: `window.__MISSION37_HYBRID_3D_POC__()`.

## Performance intent
The POC deliberately tests:
1. hierarchical 3D Tiles streaming,
2. skip-LOD behavior,
3. mobile/desktop responsiveness,
4. ability to overlay Live City data later without loading the full current map stack.

## Next steps
1. Add a Live City building-ID overlay/picking adapter.
2. Reuse current building-photo linkage through building IDs.
3. Compare current Three.js page vs Cesium POC for:
   - first meaningful 3D render,
   - FPS / frame time,
   - JS heap / GPU-memory proxy,
   - transferred bytes,
   - interaction latency.
4. Only after measurement, decide whether to migrate more rendering responsibility from Three.js.
