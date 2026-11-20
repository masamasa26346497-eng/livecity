# Mission 58 P0: do the building / road / water / ground "plates" mesh?

Result: no physical ground plate exists in the Cesium viewer; no mis-join was reproduced. Not proven absent in a real-basemap view (see limits).

- Ground: `Cesium.Viewer` with `baseLayer:false`, ellipsoid terrain (imageryLayers=0 in `renderInfo`), flat `baseColor #e9eef4`, `depthTestAgainstTerrain=false`. No ground mesh, no tileset.transform on the ground. Old Three.js `gnd` has no counterpart here.
- Buildings (3D Tiles, ENU frame per tile from the same znorth-neg-v1 inverse), roads/water/parks/rail (`toCart`, same inverse): one frame, ellipsoid height 0; layer heights water 0.5 < park 0.9 < road casing 1.3 < road 1.4 < rail 2.0.
- Depth read-back (`tools/experiments/mission58_plate_join_qa.mjs`, headless, range 120 m top-down, 27 samples = 10 roofs / 7 road verts / 5 OSM water / 5 GSI water, globe ON and OFF): road vertex h=1.399..1.400 vs 1.4 expected; roof h=10.000 vs 10 expected (globe OFF). With globe ON the roof read-back returned the globe (h~-0.18), and translucent water polygons write no depth (null with globe OFF, ~0 with globe ON): this is a limit of `pickPosition`, not a drawn offset.
- Horizontal deviation: NOT measured independently. Top-down depth read-back returns the point on the projected ray, so dxz~1e-7 is tautological. The only independent horizontal check remains Mission 55 (offline data) and Mission 56/57 visuals.
- Park/water order (`mission58_layer_order_qa.mjs`): 74 points inside both a pond and a park; water on top at 50/61 (top) and 46/61 (oblique) usable pixels, park on top 1. Both are translucent (no depth write), so order is camera-distance dependent; no defect reproduced, no code change.
- Basemap comparison not possible: GSI tiles return 404 in this sandbox (`gsipale-result.json`). Screenshots are imagery-less (`none-*`).
- Only code change: localhost+`?qa=1` hooks `setGlobe` / `renderInfo` in the 37G page.
- Images: `data/reports/mission58-plates/` (spot*-top/obl x all/globeOFF/vecOFF).
