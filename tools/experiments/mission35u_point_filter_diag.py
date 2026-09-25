#!/usr/bin/env python3
"""Mission 35U — 点群フィルタが何を落としているかを確かめる。

樹木らしさの判定（近傍の高さのばらつき）で 99% 落ちたので、
落ちた点と残った点の高さ分布を見て、それが妥当か確かめる。
"""
from __future__ import annotations
import argparse, math, json
from pathlib import Path

import laspy
import numpy as np
from pyproj import Transformer
from shapely import contains_xy
from shapely.geometry import Polygon
from scipy.spatial import cKDTree

import sys
sys.path.insert(0, str(Path(__file__).parent))
from mission35u_build_part_roof_planes import (  # noqa: E402
    fetch_osm_way, OSM_WAY_ID, GROUND_CLEARANCE_M, OUTLIER_LOW_Q, OUTLIER_HIGH_Q,
    ISOLATION_RADIUS_M, ISOLATION_MIN_NEIGHBORS, TREE_LOCAL_STD_M, MAX_ROOF_POINTS,
)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--las', required=True)
    ap.add_argument('--out', default='data/reports/mission35u-building-part-roof-planes/point-filter-diag.json')
    args = ap.parse_args()

    ll, tags, _ = fetch_osm_way(OSM_WAY_ID)
    to_plane = Transformer.from_crs(4326, 6674, always_xy=True)
    poly = Polygon([to_plane.transform(lon, lat) for lat, lon in ll])
    if not poly.is_valid:
        poly = poly.buffer(0)

    las = laspy.read(args.las)
    xs = np.asarray(las.x, dtype=np.float64)
    ys = np.asarray(las.y, dtype=np.float64)
    minx, miny, maxx, maxy = poly.bounds
    box = (xs >= minx - 15) & (xs <= maxx + 15) & (ys >= miny - 15) & (ys <= maxy + 15)
    bx, by = xs[box], ys[box]
    bz = np.asarray(las.z, dtype=np.float64)[box]
    bc = np.asarray(las.classification, dtype=np.uint8)[box]
    near_ground = bz[bc == 2]
    ground = float(np.median(near_ground)) if len(near_ground) >= 30 else float(np.percentile(bz, 10))

    inside = contains_xy(poly, bx, by)
    iz = bz[inside]
    ix, iy = bx[inside], by[inside]

    keep = iz > ground + GROUND_CLEARANCE_M
    px, py, pz = ix[keep], iy[keep], iz[keep]
    lo, hi = np.percentile(pz, OUTLIER_LOW_Q), np.percentile(pz, OUTLIER_HIGH_Q)
    keep2 = (pz >= lo) & (pz <= hi)
    px, py, pz = px[keep2], py[keep2], pz[keep2]

    if len(pz) > MAX_ROOF_POINTS:
        sel = np.linspace(0, len(pz) - 1, MAX_ROOF_POINTS).astype(np.int64)
        px, py, pz = px[sel], py[sel], pz[sel]

    xy = np.column_stack([px, py])
    tree = cKDTree(xy)
    n_neigh = tree.query_ball_point(xy, r=ISOLATION_RADIUS_M, return_length=True) - 1
    keep_iso = n_neigh >= ISOLATION_MIN_NEIGHBORS
    _, nn = tree.query(xy, k=min(9, len(pz)))
    local_std = np.std(pz[nn], axis=1)
    keep_tree = local_std <= TREE_LOCAL_STD_M

    rel = pz - ground
    q = lambda a, p: (round(float(np.percentile(a, p)), 2) if len(a) else None)  # noqa: E731
    kept = keep_iso & keep_tree
    out = {
        'groundAltitudeM': round(ground, 3),
        'points': {'inFootprint': int(len(iz)), 'afterGround': int(keep.sum()),
                   'afterOutlier': int(len(pz)), 'kept': int(kept.sum()), 'droppedTreeLike': int((~keep_tree).sum())},
        'localStdM': {'p50': q(local_std, 50), 'p90': q(local_std, 90), 'p99': q(local_std, 99),
                      'max': round(float(local_std.max()), 2), 'threshold': TREE_LOCAL_STD_M},
        'heightAboveGroundM': {
            'all': {'p10': q(rel, 10), 'p50': q(rel, 50), 'p90': q(rel, 90), 'max': round(float(rel.max()), 2)},
            'kept': {'p10': q(rel[kept], 10), 'p50': q(rel[kept], 50), 'p90': q(rel[kept], 90),
                     'max': round(float(rel[kept].max()), 2) if kept.sum() else None},
            'droppedTreeLike': {'p10': q(rel[~keep_tree], 10), 'p50': q(rel[~keep_tree], 50),
                                'p90': q(rel[~keep_tree], 90),
                                'max': round(float(rel[~keep_tree].max()), 2) if (~keep_tree).sum() else None},
        },
        'note': ('落ちた点の高さ分布が残った点よりはっきり高ければ、'
                 'footprint の中に立っている高い構造物（壁面や塔）の点を外せていることになる。'),
    }
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(out, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
