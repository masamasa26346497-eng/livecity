#!/usr/bin/env python3
"""Mission 35R - zero-cost LOD2 experiments.

A) Derive a roof patch from a real Osaka City LAS point cloud.
B) Build a lightweight gable roof from only the detected footprint bbox + height.
C) Produce a photogrammetry replacement manifest/adaptor contract; the smoke test
   uses the generated OBJ as a stand-in because real reconstruction requires a
   user-supplied overlapping photo set.

This is experiment-only. It does not mutate Live City production/dev geometry.
"""
from __future__ import annotations
import argparse, json, math, os, statistics, urllib.request
from pathlib import Path

import laspy
import numpy as np
from pyproj import Transformer
from shapely.geometry import MultiPoint


def write_obj(path: Path, verts, faces, comment):
    with path.open('w', encoding='utf-8') as f:
        f.write('# ' + comment + '\n')
        for x, y, z in verts:
            f.write(f'v {x:.3f} {z:.3f} {-y:.3f}\n')  # Live City-ish x/up/-north preview convention
        for face in faces:
            f.write('f ' + ' '.join(str(i + 1) for i in face) + '\n')


def slippy(lat, lon, z):
    n = 2 ** z
    x = int((lon + 180.0) / 360.0 * n)
    latr = math.radians(lat)
    y = int((1.0 - math.asinh(math.tan(latr)) / math.pi) / 2.0 * n)
    return x, y


def try_ortho(outdir: Path, lat: float, lon: float):
    # PLATEAU 2020 Osaka ortho tile template documented by the Update Priority Map tutorial.
    z = 17
    x, y = slippy(lat, lon, z)
    url = f'https://gic-plateau.s3.ap-northeast-1.amazonaws.com/2020/ortho/tiles/{z}/{x}/{y}.png'
    dst = outdir / f'ortho_z{z}_{x}_{y}.png'
    ok, err = False, None
    try:
        req = urllib.request.Request(url, headers={'User-Agent': 'LiveCity-Mission35R/1.0'})
        with urllib.request.urlopen(req, timeout=30) as r:
            data = r.read()
        if data.startswith(b'\x89PNG'):
            dst.write_bytes(data); ok = True
        else:
            err = f'not PNG ({len(data)} bytes)'
    except Exception as e:
        err = str(e)
    return {'url': url, 'tile': [z, x, y], 'downloaded': ok, 'error': err, 'path': str(dst) if ok else None}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--las', required=True)
    ap.add_argument('--out', default='data/reports/mission35r')
    ap.add_argument('--sample-cap', type=int, default=2500000)
    args = ap.parse_args()
    outdir = Path(args.out); outdir.mkdir(parents=True, exist_ok=True)

    las = laspy.read(args.las)
    n = len(las.points)
    step = max(1, math.ceil(n / args.sample_cap))
    xs = np.asarray(las.x[::step], dtype=np.float64)
    ys = np.asarray(las.y[::step], dtype=np.float64)
    zs = np.asarray(las.z[::step], dtype=np.float64)
    cls = np.asarray(las.classification[::step], dtype=np.uint8) if hasattr(las, 'classification') else np.zeros(len(xs), np.uint8)

    finite = np.isfinite(xs) & np.isfinite(ys) & np.isfinite(zs)
    xs, ys, zs, cls = xs[finite], ys[finite], zs[finite], cls[finite]
    ground = float(np.percentile(zs, 10))
    high = zs > ground + 4.0

    # Densest 10m high-point cell: a pragmatic real-data roof candidate.
    gx = np.floor(xs[high] / 10).astype(np.int64)
    gy = np.floor(ys[high] / 10).astype(np.int64)
    keys = np.stack([gx, gy], axis=1)
    uniq, counts = np.unique(keys, axis=0, return_counts=True)
    best = uniq[int(np.argmax(counts))]
    cx, cy = (best[0] + .5) * 10, (best[1] + .5) * 10
    roi = high & (np.abs(xs - cx) <= 15) & (np.abs(ys - cy) <= 15)
    rx, ry, rz = xs[roi], ys[roi], zs[roi]
    if len(rx) < 30:
        raise RuntimeError('not enough candidate roof points')

    hull = MultiPoint(np.column_stack([rx, ry])).convex_hull
    if hull.geom_type != 'Polygon':
        raise RuntimeError('candidate roof hull is not a polygon')
    ring = list(hull.exterior.coords)[:-1]
    roof_z = float(np.median(rz))
    minx, miny, maxx, maxy = hull.bounds
    width, depth = maxx-minx, maxy-miny

    # A: point-cloud-derived flat/planar roof polygon (fan triangulation).
    a_verts = [(x-cx, y-cy, roof_z-ground) for x,y in ring]
    a_faces = []
    for i in range(1, len(a_verts)-1): a_faces.append((0, i, i+1))
    a_obj = outdir / 'A_pointcloud_roof_preview.obj'
    write_obj(a_obj, a_verts, a_faces, 'Mission35R A: roof hull derived from real Osaka LAS points')

    # B: very cheap simple LOD2-like gable from bbox + one height value.
    h = max(3.0, roof_z-ground)
    ridge = min(3.5, max(0.8, 0.18*h))
    # ridge along longer axis
    if width >= depth:
        b_verts = [
            (minx-cx,miny-cy,h),(maxx-cx,miny-cy,h),(maxx-cx,maxy-cy,h),(minx-cx,maxy-cy,h),
            (minx-cx,(miny+maxy)/2-cy,h+ridge),(maxx-cx,(miny+maxy)/2-cy,h+ridge)]
        b_faces = [(0,1,5,4),(4,5,2,3),(0,4,3),(1,2,5)]
    else:
        b_verts = [
            (minx-cx,miny-cy,h),(maxx-cx,miny-cy,h),(maxx-cx,maxy-cy,h),(minx-cx,maxy-cy,h),
            ((minx+maxx)/2-cx,miny-cy,h+ridge),((minx+maxx)/2-cx,maxy-cy,h+ridge)]
        b_faces = [(0,4,5,3),(4,1,2,5),(0,1,4),(3,5,2)]
    b_obj = outdir / 'B_simple_gable_preview.obj'
    write_obj(b_obj, b_verts, b_faces, 'Mission35R B: heuristic gable roof from footprint bbox + height')

    # Transform the LAS candidate centre assuming JGD2011 / Japan Plane Rectangular CS VI (EPSG:6674),
    # the CRS used by Osaka PLATEAU orthophotos. Record plausibility instead of silently trusting it.
    lat = lon = None; transform_ok = False
    try:
        tr = Transformer.from_crs(6674, 4326, always_xy=True)
        lon, lat = tr.transform(cx, cy)
        transform_ok = 34.0 < lat < 35.5 and 134.5 < lon < 136.5
    except Exception:
        pass
    ortho = try_ortho(outdir, lat, lon) if transform_ok else {'downloaded': False, 'error': 'CRS transform not plausible'}

    # C: contract for a future Scaniverse/photogrammetry mesh. Smoke-tested with A OBJ as a stand-in only.
    c_manifest = {
        'version': 1,
        'mission': '35R',
        'kind': 'photogrammetry-building-replacement',
        'status': 'adapter-smoke-test-only',
        'realPhotoReconstructionPerformed': False,
        'reason': 'No overlapping user photo/Scaniverse capture set was supplied in this conversation.',
        'acceptedFormats': ['obj', 'glb', 'gltf'],
        'requiredPlacement': ['canonicalId', 'anchorLat', 'anchorLon', 'rotationDeg', 'scaleMeters'],
        'standInMesh': a_obj.name,
        'rules': {'suppressLOD1OnlyAfterValidatedPlacement': True, 'productionCutover': False}
    }
    (outdir/'C_photogrammetry_adapter_manifest.json').write_text(json.dumps(c_manifest, ensure_ascii=False, indent=2), encoding='utf-8')

    vals, cnts = np.unique(cls, return_counts=True)
    classifications = {str(int(k)): int(v) for k,v in zip(vals,cnts)}
    report = {
        'mission': '35R', 'source': {'las': os.path.basename(args.las), 'points': int(n), 'sampled': int(len(xs)), 'sampleStep': int(step)},
        'bounds': {'x': [float(np.min(xs)),float(np.max(xs))], 'y':[float(np.min(ys)),float(np.max(ys))], 'z':[float(np.min(zs)),float(np.max(zs))]},
        'classificationSampleCounts': classifications,
        'groundEstimateM': ground,
        'candidate': {'samplePoints': int(len(rx)), 'centerXY':[float(cx),float(cy)], 'latLon':[lat,lon] if transform_ok else None,
                      'footprintHullVertices': len(ring), 'bboxM':[float(width),float(depth)], 'roofMedianM':roof_z, 'heightAboveGroundM':roof_z-ground},
        'methodA': {'obj': a_obj.name, 'usesRealPointCloud': True, 'usesAerialImage': bool(ortho.get('downloaded')), 'ortho': ortho},
        'methodB': {'obj': b_obj.name, 'usesPointCloudForRoofShape': False, 'usesOnlyFootprintAndHeightAfterCandidateSelection': True, 'ridgeExtraM':ridge},
        'methodC': c_manifest,
        'costJPY': 0,
        'productionModified': False,
        'protectedModified': False,
    }
    (outdir/'RESULT.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    md = f"""# Mission 35R experiment result\n\n- LAS points: **{n:,}** (sampled {len(xs):,})\n- Candidate roof points: **{len(rx):,}**\n- Candidate footprint bbox: **{width:.1f}m × {depth:.1f}m**\n- Estimated building height: **{roof_z-ground:.1f}m**\n- Method A: real point-cloud-derived roof OBJ generated: `{a_obj.name}`\n- Method B: heuristic gable roof OBJ generated: `{b_obj.name}`\n- Method C: photogrammetry adapter contract generated; **real reconstruction not performed because no photo set was supplied**.\n- Ortho tile: {'downloaded' if ortho.get('downloaded') else 'not downloaded'}\n- Cost: **0 JPY**\n- Production/protected: **unchanged**\n"""
    (outdir/'SUMMARY.md').write_text(md, encoding='utf-8')
    print(md)

if __name__ == '__main__':
    main()
