# Mission 35S — Live City custom LOD2 integration

Goal: integrate one real Osaka point-cloud-derived building replacement into the dev page only.

Safety:
- production `public/osaka_3d_buildings.html`: unchanged
- protected `public/osaka_3d_buildings.fullward-v3.html`: unchanged
- canonical geometry: unchanged
- dev only
- no production cutover

Target prototype source:
- Osaka City Niitaka LAS
- matched real OSM building way/267613423
- real footprint + point-cloud-derived observed elevation
- do not label as official PLATEAU LOD2

The first step is a read-only probe of existing high-LOD suppression/render/picking hooks so the implementation can reuse the established canonicalId path instead of adding a second incompatible renderer.
