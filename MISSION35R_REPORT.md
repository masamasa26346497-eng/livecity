# Mission 35R — Zero-cost LOD2 experiments

## Purpose

Test three sub-500k-JPY approaches without touching production geometry:

A. Free public point cloud + aerial imagery
B. Lightweight synthetic roof geometry
C. Smartphone / photogrammetry replacement path

## Data used

- Osaka City Construction Bureau public LAS point cloud: Yodogawa-ku Niitaka 2–6 chome, A.las
- 8,870,514 source points; 2,217,629 sampled in the experiment
- OSM building footprints for building isolation
- PLATEAU Osaka ortho tile (2020, z17) for aerial-image availability check

All external data used by the experiment is free/open data. Experiment execution cost: 0 JPY.

## Important correction made during the experiment

The LAS sample contains classification values 1–5 but no LAS building class 6. Therefore, a first-pass 'densest elevated points = roof' method could confuse vegetation with buildings.

The final v2 experiment does NOT trust elevated points alone. It queries a real OSM building footprint, projects that footprint to EPSG:6674, clips LAS points to the footprint, and only then estimates roof elevation.

## Method A — point cloud + real footprint

Result: TECHNICAL_PROTOTYPE_PASS

Matched building:

- OSM way: 267613423
- building= residential
- footprint: 1,015.96 m2
- footprint vertices: 16
- LAS sampled points inside footprint: 47,194
- estimated height: 37.00 m
- output: `A_pointcloud_osm_matched_roof.obj`
- orthophoto tile download: success

This proves the zero-cost pipeline can match a real building footprint to a real Osaka City point cloud and produce replacement roof geometry.

Limitation: the current prototype estimates a conservative roof elevation but does not yet infer roof planes/type (gable/hip/steps) from the point cloud. It is therefore an engineering prototype, not yet PLATEAU-compliant LOD2.

## Method B — simple roof generation

Result: VISUAL_HEURISTIC_ONLY

- output: `B_simple_gable_preview.obj`
- uses building footprint + one height value
- adds a deterministic gable ridge
- extremely cheap to generate at city scale

However, the gable shape is fabricated. It must never be labelled official/observed LOD2. This method is only acceptable as a Live City visual enhancement layer if clearly separated from authoritative geometry.

## Method C — smartphone / photogrammetry

Result: adapter path prepared, real reconstruction not performed.

Generated contract:

- accepted mesh formats: OBJ / GLB / glTF
- required placement metadata: canonicalId, anchorLat, anchorLon, rotationDeg, scaleMeters
- LOD1 suppression is allowed only after placement validation
- production cutover remains false

A real Scaniverse/photogrammetry test requires an overlapping photo or exported mesh capture of a real building. No such capture set was supplied in this conversation, so fabricating one would not be a valid experiment.

## Cost

- Public LAS: 0 JPY
- PLATEAU ortho: 0 JPY
- OSM footprint: 0 JPY
- GitHub Actions experiment: no paid external LOD service used
- Total external data/service cost in this experiment: 0 JPY

## Conclusion

Method A is worth pursuing. The next technical step is roof-plane segmentation inside matched building footprints, then comparison against existing official PLATEAU LOD2 buildings as ground truth.

Method B is scalable but non-authoritative and should be treated as a visual approximation only.

Method C is likely best for a small set of landmark buildings, but a real capture must be provided before evaluating quality.

Production and `public/osaka_3d_buildings.fullward-v3.html` remain unchanged.

GitHub Actions run: 36123409356
