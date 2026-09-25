#!/usr/bin/env python3
"""Mission 35U — source footprint を building part として扱い、屋根を平面で作り直す。

35T で OSM way 267613423 は canonical 建物**全体**ではなく、その内部の一部だと分かった
（sourceCoveredRatio 0.98 / candidateCoveredRatio 0.58 / IoU 0.58）。
そこで:

  §1 BUILDING_PART_CANDIDATE かどうかを 35T の指標で判定する
  §2 source footprint の中だけ点群を取り直す（地面・外れ値・樹木らしい点を落とす）
  §3 RANSAC で屋根を複数の平面に分ける
  §4 各平面を footprint を境界として polygon 化する
  §5 footprint 外周から壁を立て、上端を屋根に合わせる

これは実験であって公式 PLATEAU LOD2 ではない。出力の status にもそう書く。

実行:
  python tools/experiments/mission35u_build_part_roof_planes.py \
      --las .cache/mission35s/A.las \
      --out public/map-data/osaka-city/experimental/mission35u/part-roof-planes-267613423.json
"""
from __future__ import annotations
import argparse, json, math, urllib.request, xml.etree.ElementTree as ET
from pathlib import Path

import laspy
import numpy as np
from pyproj import Transformer
from shapely import contains_xy
from shapely.geometry import Point, Polygon, MultiPolygon
from shapely.ops import unary_union
from scipy.spatial import cKDTree

import sys, time
_T0 = time.time()


def log(msg: str):
    print(f'[35U {time.time() - _T0:6.1f}s] {msg}', flush=True)

OSM_WAY_ID = 267613423
CENTER_LAT = 34.604208
CENTER_LON = 135.52502
MPD = 111320.0
COS_LAT = math.cos(math.radians(CENTER_LAT))

# ── §1 building part 判定のしきい値 ────────────────────────────────────
PART_RULES = {
    'sourceCoveredRatioMin': 0.90,
    'candidateCoveredRatio': (0.25, 0.75),
    'secondIouMax': 0.20,          # second がこれ以上なら競合ありとみなす
}
# ── §2 点群フィルタ ────────────────────────────────────────────────────
GROUND_CLEARANCE_M = 2.5       # これ以下は地面・低い付属物として捨てる
OUTLIER_LOW_Q = 2.0            # 下側の外れ値を切る百分位
OUTLIER_HIGH_Q = 99.0          # 上側の外れ値（アンテナ・鳥）を切る百分位
ISOLATION_RADIUS_M = 1.5       # この半径に
ISOLATION_MIN_NEIGHBORS = 3    # これ未満しか無い点は孤立点として捨てる
MAX_ROOF_POINTS = 60_000       # 近傍探索が現実的に回る上限
# 屋根は「上から見た一番上の面」。XY 格子のセルごとに、最高点から下へこの厚みまでを屋根とみなす。
#   壁面の反射（同じ XY で下へ続く点）はこれで落ちる。
TOP_SURFACE_CELL_M = 1.0
TOP_SURFACE_BAND_M = 1.2
TOP_SURFACE_MIN_PTS = 3        # セルにこれ未満しか無ければ、そのセルは使わない
# セルの最高点が周りより極端に高いだけの点（アンテナ・鳥・樹冠）は落とす
CELL_SPIKE_M = 6.0             # 近隣セルの中央値からこれ以上高いセルは捨てる
# ── §3 RANSAC ──────────────────────────────────────────────────────────
RANSAC_ITERS = 600
RANSAC_TOL_M = 0.35            # 平面からこの距離以内を inlier とする
PLANE_MIN_SUPPORT = 60         # これ未満の平面はノイズとして捨てる
PLANE_MIN_SUPPORT_FRAC = 0.03  # 屋根点全体に対する最低割合
MAX_PLANES = 8
# ── §4 分類 ────────────────────────────────────────────────────────────
FLAT_SLOPE_DEG = 7.0           # これ未満は陸屋根扱い


def world(lat: float, lon: float):
    return [(lon - CENTER_LON) * COS_LAT * MPD, -((lat - CENTER_LAT) * MPD)]


def fetch_osm_way(way_id: int):
    url = f'https://api.openstreetmap.org/api/0.6/way/{way_id}/full'
    req = urllib.request.Request(url, headers={'User-Agent': 'LiveCity-Mission35U/1.0'})
    with urllib.request.urlopen(req, timeout=60) as r:
        root = ET.fromstring(r.read())
    nodes = {n.attrib['id']: (float(n.attrib['lat']), float(n.attrib['lon'])) for n in root.findall('node')}
    way_el = next(w for w in root.findall('way') if int(w.attrib['id']) == way_id)
    refs = [nd.attrib['ref'] for nd in way_el.findall('nd')]
    ll = [nodes[r] for r in refs if r in nodes]
    if len(ll) < 4:
        raise RuntimeError('OSM footprint missing/too short')
    if ll[0] == ll[-1]:
        ll = ll[:-1]
    tags = {t.attrib['k']: t.attrib['v'] for t in way_el.findall('tag')}
    return ll, tags, url


def decide_building_part(metrics: dict) -> dict:
    """§1 35T の指標から building part かどうかを決める。断定できなければ PART_UNCERTAIN。"""
    s = metrics.get('sourceCoveredRatio')
    c = metrics.get('candidateCoveredRatio')
    second_iou = metrics.get('secondIou') or 0.0
    src_area = metrics.get('sourceAreaM2') or 0.0
    cand_area = metrics.get('candidateAreaM2') or 0.0
    centroid_inside = bool(metrics.get('sourceCentroidInsideCandidate'))
    checks = {
        'sourceCoveredRatio>=0.90': s is not None and s >= PART_RULES['sourceCoveredRatioMin'],
        'candidateCoveredRatio 0.25-0.75': c is not None and PART_RULES['candidateCoveredRatio'][0] <= c <= PART_RULES['candidateCoveredRatio'][1],
        'source centroid inside candidate': centroid_inside,
        'second candidate weak': second_iou <= PART_RULES['secondIouMax'],
        'source area < candidate area': src_area > 0 and cand_area > 0 and src_area < cand_area,
    }
    ok = all(checks.values())
    return {
        'verdict': 'BUILDING_PART_CANDIDATE' if ok else 'PART_UNCERTAIN',
        'checks': checks,
        'failed': [k for k, v in checks.items() if not v],
        'rules': PART_RULES,
        'note': ('source は candidate の中にほぼ収まり、candidate 側は部分的にしか覆われていない。'
                 'つまり OSM way は建物全体ではなく building part を指している。'
                 if ok else '条件を満たさないので building part とは断定しない。'),
    }


def filter_roof_points(px, py, pz, ground):
    """§2 屋根候補点を取り出す。落とした理由ごとの件数も返す。

    上空から撮った点群には壁面の反射も入っている。近傍の高さのばらつきで切ると
    高い棟そのものを捨ててしまうので（実測: ばらつき中央値 9.72m）、
    **XY 格子のセルごとに最高点から一定の厚みだけ**を屋根として取る。
    """
    stats = {'inFootprint': int(len(pz))}
    keep = pz > ground + GROUND_CLEARANCE_M
    stats['droppedGround'] = int((~keep).sum())
    px, py, pz = px[keep], py[keep], pz[keep]
    if len(pz) < 30:
        return px, py, pz, stats
    lo = np.percentile(pz, OUTLIER_LOW_Q)
    hi = np.percentile(pz, OUTLIER_HIGH_Q)
    keep = (pz >= lo) & (pz <= hi)
    stats['droppedHeightOutlier'] = int((~keep).sum())
    px, py, pz = px[keep], py[keep], pz[keep]
    if len(pz) < 30:
        return px, py, pz, stats

    # ── 上面の抽出 ──────────────────────────────────────────────
    cell = TOP_SURFACE_CELL_M
    ci = np.floor(px / cell).astype(np.int64)
    cj = np.floor(py / cell).astype(np.int64)
    key = ci * 1_000_003 + cj
    order = np.argsort(key, kind='stable')
    key_s = key[order]
    uniq, start = np.unique(key_s, return_index=True)
    ends = np.append(start[1:], len(key_s))
    cell_top = {}
    cell_pts = {}
    for u, a, b in zip(uniq, start, ends):
        idx = order[a:b]
        if len(idx) < TOP_SURFACE_MIN_PTS:
            continue
        cell_top[int(u)] = float(pz[idx].max())
        cell_pts[int(u)] = idx
    stats['cells'] = len(cell_top)
    if not cell_top:
        return px[:0], py[:0], pz[:0], stats

    # 周りのセルより極端に高いセルは落とす（アンテナ・樹冠・鳥）
    tops = np.array(list(cell_top.values()))
    med = float(np.median(tops))
    spike = {u: t for u, t in cell_top.items() if t - med > CELL_SPIKE_M}
    # ただし屋根そのものが高いこともあるので、外れ値が全体の 1 割を超えるなら落とさない
    if len(spike) > 0.10 * len(cell_top):
        spike = {}
    stats['droppedSpikeCells'] = len(spike)

    sel = []
    dropped_facade = 0
    for u, idx in cell_pts.items():
        if u in spike:
            continue
        top = cell_top[u]
        band = pz[idx] >= top - TOP_SURFACE_BAND_M
        dropped_facade += int((~band).sum())
        sel.append(idx[band])
    stats['droppedBelowTopSurface'] = dropped_facade
    if not sel:
        return px[:0], py[:0], pz[:0], stats
    sel = np.concatenate(sel)
    px, py, pz = px[sel], py[sel], pz[sel]
    stats['topSurfacePoints'] = int(len(pz))

    if len(pz) > MAX_ROOF_POINTS:
        thin = np.linspace(0, len(pz) - 1, MAX_ROOF_POINTS).astype(np.int64)
        stats['thinnedFrom'] = int(len(pz))
        px, py, pz = px[thin], py[thin], pz[thin]

    # 孤立点を落とす（件数だけ数えるのでメモリが立たない）
    if len(pz) >= 10:
        xy = np.column_stack([px, py])
        tree = cKDTree(xy)
        n_neigh = tree.query_ball_point(xy, r=ISOLATION_RADIUS_M, return_length=True) - 1
        keep_iso = n_neigh >= ISOLATION_MIN_NEIGHBORS
        stats['droppedIsolated'] = int((~keep_iso).sum())
        px, py, pz = px[keep_iso], py[keep_iso], pz[keep_iso]
    stats['roofCandidatePoints'] = int(len(pz))
    return px, py, pz, stats


def fit_plane(pts):
    """最小二乗で平面 z = a*x + b*y + d。"""
    A = np.column_stack([pts[:, 0], pts[:, 1], np.ones(len(pts))])
    coef, *_ = np.linalg.lstsq(A, pts[:, 2], rcond=None)
    return coef  # a, b, d


def plane_metrics(coef, pts):
    a, b, d = coef
    pred = a * pts[:, 0] + b * pts[:, 1] + d
    resid = pts[:, 2] - pred
    n = np.array([-a, -b, 1.0])
    n = n / np.linalg.norm(n)
    slope = math.degrees(math.acos(min(1.0, abs(float(n[2])))))
    return {
        'normal': [round(float(v), 5) for v in n],
        'slopeDeg': round(slope, 3),
        'a': round(float(a), 6), 'b': round(float(b), 6), 'd': round(float(d), 4),
        'rmsErrorM': round(float(np.sqrt(np.mean(resid ** 2))), 4),
        'maxAbsErrorM': round(float(np.max(np.abs(resid))), 4),
    }


def ransac_planes(px, py, pz, rng):
    """§3 RANSAC で平面を順に取り出す。support が足りない面は捨てる。"""
    pts = np.column_stack([px, py, pz])
    remaining = np.ones(len(pts), dtype=bool)
    min_support = max(PLANE_MIN_SUPPORT, int(PLANE_MIN_SUPPORT_FRAC * len(pts)))
    planes = []
    dropped = 0
    while planes.__len__() < MAX_PLANES and remaining.sum() >= min_support:
        sub = pts[remaining]
        best_inl, best_coef = None, None
        for _ in range(RANSAC_ITERS):
            idx = rng.choice(len(sub), size=3, replace=False)
            p0, p1, p2 = sub[idx]
            v1, v2 = p1 - p0, p2 - p0
            n = np.cross(v1, v2)
            if abs(n[2]) < 1e-6:
                continue
            a = -n[0] / n[2]
            b = -n[1] / n[2]
            d = p0[2] - a * p0[0] - b * p0[1]
            pred = a * sub[:, 0] + b * sub[:, 1] + d
            inl = np.abs(sub[:, 2] - pred) <= RANSAC_TOL_M
            if best_inl is None or inl.sum() > best_inl.sum():
                best_inl, best_coef = inl, (a, b, d)
        if best_inl is None or best_inl.sum() < min_support:
            dropped += 1
            break
        # inlier だけで最小二乗し直す
        inl_pts = sub[best_inl]
        coef = fit_plane(inl_pts)
        pred = coef[0] * sub[:, 0] + coef[1] * sub[:, 1] + coef[2]
        refined = np.abs(sub[:, 2] - pred) <= RANSAC_TOL_M
        if refined.sum() < min_support:
            dropped += 1
            break
        inl_pts = sub[refined]
        m = plane_metrics(coef, inl_pts)
        planes.append({
            'support': int(refined.sum()),
            'coef': [float(coef[0]), float(coef[1]), float(coef[2])],
            'points': inl_pts,
            **m,
            'bbox': {
                'minX': round(float(inl_pts[:, 0].min()), 2), 'maxX': round(float(inl_pts[:, 0].max()), 2),
                'minY': round(float(inl_pts[:, 1].min()), 2), 'maxY': round(float(inl_pts[:, 1].max()), 2),
                'minZ': round(float(inl_pts[:, 2].min()), 2), 'maxZ': round(float(inl_pts[:, 2].max()), 2),
            },
        })
        # 使った点を消す
        gidx = np.where(remaining)[0][refined]
        remaining[gidx] = False
    return planes, min_support, dropped


def classify_roof(planes):
    """§4 分かる範囲で屋根の型を言う。決められないときは UNKNOWN_PLANAR_ROOF。"""
    if not planes:
        return 'NO_PLANE'
    slopes = [p['slopeDeg'] for p in planes]
    if len(planes) == 1:
        return 'FLAT_ROOF' if slopes[0] < FLAT_SLOPE_DEG else 'UNKNOWN_PLANAR_ROOF'
    if all(s < FLAT_SLOPE_DEG for s in slopes):
        # 平らな面が複数 = 段差のある陸屋根
        elev = [p['bbox']['maxZ'] for p in planes]
        return 'STEPPED_FLAT_ROOF' if (max(elev) - min(elev)) > 1.0 else 'FLAT_ROOF'
    return 'UNKNOWN_PLANAR_ROOF'


def voronoi_like_assign(poly, planes, cell=1.0):
    """§4 footprint を格子で刻み、各セルを一番近い平面へ割り当てて polygon 化する。"""
    from shapely.geometry import box as shbox
    minx, miny, maxx, maxy = poly.bounds
    nx = max(1, int(math.ceil((maxx - minx) / cell)))
    ny = max(1, int(math.ceil((maxy - miny) / cell)))
    # 各平面の inlier 点で KDTree を作り、セル中心の最近傍を一度に引く
    trees = [cKDTree(p['points'][:, :2]) for p in planes]
    centers, cells = [], []
    for i in range(nx):
        for j in range(ny):
            x0, y0 = minx + i * cell, miny + j * cell
            c = shbox(x0, y0, x0 + cell, y0 + cell)
            inter = c.intersection(poly)
            if inter.is_empty or inter.area < cell * cell * 0.15:
                continue
            centers.append((x0 + cell / 2, y0 + cell / 2))
            cells.append(inter)
    if not centers:
        return {}
    C = np.array(centers)
    dists = np.stack([t.query(C, k=1)[0] for t in trees], axis=1)
    owners = np.argmin(dists, axis=1)
    owner = {}
    for k, inter in zip(owners, cells):
        owner.setdefault(int(k), []).append(inter)
    out = {}
    for k, parts in owner.items():
        merged = unary_union(parts)
        if merged.is_empty:
            continue
        merged = merged.simplify(0.35, preserve_topology=True)
        out[k] = merged
    return out


def poly_rings(geom):
    """shapely の Polygon / MultiPolygon から外周リング（穴は無視）を取り出す。"""
    if geom.is_empty:
        return []
    geoms = geom.geoms if isinstance(geom, MultiPolygon) else [geom]
    rings = []
    for g in geoms:
        if g.area < 1.0:
            continue
        rings.append([(float(x), float(y)) for x, y in list(g.exterior.coords)[:-1]])
    return rings


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--las', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--report', default='data/reports/mission35u-building-part-roof-planes')
    ap.add_argument('--match', default='data/reports/mission35t-custom-lod2-matching/candidates.json')
    ap.add_argument('--sample-cap', type=int, default=8_000_000)
    ap.add_argument('--seed', type=int, default=20350)
    args = ap.parse_args()
    rng = np.random.default_rng(args.seed)
    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    rep_dir = Path(args.report)
    rep_dir.mkdir(parents=True, exist_ok=True)

    # ── source footprint ────────────────────────────────────────────
    ll, tags, osm_url = fetch_osm_way(OSM_WAY_ID)
    to_plane = Transformer.from_crs(4326, 6674, always_xy=True)
    to_ll = Transformer.from_crs(6674, 4326, always_xy=True)
    ring_xy = [to_plane.transform(lon, lat) for lat, lon in ll]
    poly = Polygon(ring_xy)
    if not poly.is_valid:
        poly = poly.buffer(0)
    if not poly.is_valid or poly.area < 20:
        raise RuntimeError('invalid OSM building polygon')

    # ── §1 building part 判定（35T の実測を読む）──────────────────────
    m35t = json.loads(Path(args.match).read_text(encoding='utf-8'))
    best = m35t.get('best') or {}
    second = m35t.get('second') or {}
    src_centroid_world = m35t['source']['centroid']
    part = decide_building_part({
        'sourceCoveredRatio': best.get('sourceCoveredRatio'),
        'candidateCoveredRatio': best.get('candidateCoveredRatio'),
        'secondIou': second.get('iou'),
        'sourceAreaM2': best.get('sourceAreaM2'),
        'candidateAreaM2': best.get('candidateAreaM2'),
        # source 重心が candidate の中か = source 被覆率がほぼ 1 なら中にある
        'sourceCentroidInsideCandidate': (best.get('sourceCoveredRatio') or 0) >= 0.90,
    })
    part['bestCanonicalId'] = best.get('canonicalId')
    part['mission35tConfidence'] = m35t.get('matchConfidence')

    # ── §2 点群再抽出 ────────────────────────────────────────────────
    log(f'LAS を読む: {args.las}')
    las = laspy.read(args.las)
    total_points = int(len(las.points))
    log(f'LAS 点数 {total_points:,}')
    # ScaledArrayView のスライスは遅いので、一度 numpy にしてから間引く
    xs_all = np.asarray(las.x, dtype=np.float64)
    ys_all = np.asarray(las.y, dtype=np.float64)
    log('x/y を numpy 化した')
    minx, miny, maxx, maxy = poly.bounds
    # footprint の周りだけ先に絞る（ここで 99.9% が落ちる）
    box = (xs_all >= minx - 15) & (xs_all <= maxx + 15) & (ys_all >= miny - 15) & (ys_all <= maxy + 15)
    nbox = int(box.sum())
    log(f'footprint 周辺の点 {nbox:,}')
    if nbox == 0:
        raise RuntimeError('footprint の周りに点が無い')
    bx = xs_all[box]
    by = ys_all[box]
    bz = np.asarray(las.z, dtype=np.float64)[box]
    bc = np.asarray(las.classification, dtype=np.uint8)[box]
    del xs_all, ys_all
    step = 1
    if nbox > args.sample_cap:
        step = math.ceil(nbox / args.sample_cap)
        bx, by, bz, bc = bx[::step], by[::step], bz[::step], bc[::step]
        log(f'{step} 点に 1 つへ間引き → {len(bz):,}')
    near_ground = bz[bc == 2]
    ground = float(np.median(near_ground)) if len(near_ground) >= 30 else float(np.percentile(bz, 10))
    log(f'地面高 {ground:.3f} m（class2 {len(near_ground):,} 点）')

    # ベクトル化した内外判定（Point を 1 つずつ作ると桁違いに遅い）
    inside = contains_xy(poly, bx, by)
    ix, iy, iz = bx[inside], by[inside], bz[inside]
    log(f'footprint の中 {len(iz):,} 点')
    rx, ry, rz, pstats = filter_roof_points(ix, iy, iz, ground)
    log(f'屋根候補点 {len(rz):,}')
    pstats['lasTotalPoints'] = total_points
    pstats['sampleStep'] = step
    pstats['nearFootprintPoints'] = int(nbox)
    pstats['sampledNearFootprint'] = int(len(bz))
    pstats['groundAltitudeM'] = round(ground, 3)
    if len(rz) < PLANE_MIN_SUPPORT:
        raise RuntimeError(f'roof candidate points too few: {len(rz)}')

    # ── §3 RANSAC ───────────────────────────────────────────────────
    log('RANSAC で平面を検出する…')
    planes, min_support, dropped = ransac_planes(rx, ry, rz, rng)
    log(f'平面 {len(planes)} 面（最低 support {min_support}）')
    if not planes:
        raise RuntimeError('no roof plane detected')
    planes.sort(key=lambda p: -p['support'])
    roof_type = classify_roof(planes)

    # ── §4 平面ごとの polygon ────────────────────────────────────────
    log('平面ごとに polygon を作る…')
    assign = voronoi_like_assign(poly, planes, cell=1.0)
    log(f'polygon {len(assign)} 面ぶん')

    vertices = []
    roof_idx = []
    wall_idx = []
    vmap = {}

    def add_vertex(x_plane, y_plane, alt):
        key = (round(x_plane, 3), round(y_plane, 3), round(alt, 3))
        if key in vmap:
            return vmap[key]
        lon, lat = to_ll.transform(float(x_plane), float(y_plane))
        wx, wz = world(lat, lon)
        vertices.append([round(wx, 4), round(max(0.1, alt - ground), 4), round(wz, 4)])
        vmap[key] = len(vertices) - 1
        return vmap[key]

    plane_out = []
    for k, p in enumerate(planes):
        geom = assign.get(k)
        rings = poly_rings(geom) if geom is not None else []
        a, b, d = p['coef']
        tri_count = 0
        for ring in rings:
            if len(ring) < 3:
                continue
            # 扇状に三角形化（simplify 済みで凸に近い形になっている）
            idxs = [add_vertex(x, y, a * x + b * y + d) for x, y in ring]
            for t in range(1, len(idxs) - 1):
                roof_idx.extend([idxs[0], idxs[t], idxs[t + 1]])
                tri_count += 1
        plane_out.append({
            'index': k,
            'support': p['support'],
            'normal': p['normal'],
            'slopeDeg': p['slopeDeg'],
            'interceptM': round(p['coef'][2] - ground, 3),
            'elevationMinM': round(p['bbox']['minZ'] - ground, 3),
            'elevationMaxM': round(p['bbox']['maxZ'] - ground, 3),
            'rmsErrorM': p['rmsErrorM'],
            'maxAbsErrorM': p['maxAbsErrorM'],
            'bbox': p['bbox'],
            'polygonRingCount': len(rings),
            'polygonAreaM2': round(float(geom.area), 2) if geom is not None else 0.0,
            'triangles': tri_count,
        })

    roof_triangles = len(roof_idx) // 3

    # ── §5 壁（source footprint の外周だけ）──────────────────────────
    plane_trees = [cKDTree(p['points'][:, :2]) for p in planes]

    def roof_alt_at(x, y):
        """その位置を覆っている平面の高さ。どの平面にも属さなければ一番近い平面。"""
        q = np.array([[x, y]])
        dists = [float(t.query(q, k=1)[0][0]) for t in plane_trees]
        best_k = int(np.argmin(dists))
        a, b, d = planes[best_k]['coef']
        return a * x + b * y + d

    log('壁を作る…')
    ext = list(poly.exterior.coords)[:-1]
    # 長い辺は分割して、上端が屋根の形に追従するようにする
    dense = []
    for i in range(len(ext)):
        x0, y0 = ext[i]
        x1, y1 = ext[(i + 1) % len(ext)]
        seg = math.hypot(x1 - x0, y1 - y0)
        n = max(1, int(seg // 3.0))
        for s in range(n):
            t = s / n
            dense.append((x0 + (x1 - x0) * t, y0 + (y1 - y0) * t))
    for i in range(len(dense)):
        x0, y0 = dense[i]
        x1, y1 = dense[(i + 1) % len(dense)]
        a0 = roof_alt_at(x0, y0)
        a1 = roof_alt_at(x1, y1)
        b0 = add_vertex(x0, y0, ground + 0.1)
        b1 = add_vertex(x1, y1, ground + 0.1)
        t0 = add_vertex(x0, y0, a0)
        t1 = add_vertex(x1, y1, a1)
        wall_idx.extend([b0, b1, t1, b0, t1, t0])
    wall_triangles = len(wall_idx) // 3

    indices = roof_idx + wall_idx
    groups = [
        {'kind': 'roof', 'start': 0, 'count': len(roof_idx)},
        {'kind': 'wall', 'start': len(roof_idx), 'count': len(wall_idx)},
    ]

    # ── footprint containment（§8/§9）────────────────────────────────
    poly_buf = poly.buffer(0.75)
    outside = 0
    for (x_plane, y_plane, _alt), _ in [((k[0], k[1], k[2]), v) for k, v in vmap.items()]:
        if not poly_buf.covers(Point(x_plane, y_plane)):
            outside += 1
    containment = {
        'vertices': len(vertices),
        'outsideFootprint': outside,
        'toleranceM': 0.75,
        'ok': outside == 0,
    }

    heights = [v[1] for v in vertices]
    doc = {
        'version': 1,
        'mission': '35U',
        'status': 'EXPERIMENTAL_POINT_CLOUD_PLANAR_ROOF',
        'officialPlateauLod2': False,
        'note': ('OSM building part の範囲だけを、実測点群から平面分割して作った実験的な屋根。'
                 '公式 PLATEAU LOD2 ではない。canonical 建物全体を置き換えるものでもない。'),
        'coordinateConvention': 'znorth-neg-v1',
        'source': {
            'pointCloud': 'Osaka City Niitaka A.las',
            'pointCloudPoints': total_points,
            'sampleStep': step,
            'osmWayId': OSM_WAY_ID,
            'osmUrl': osm_url,
            'buildingTag': tags.get('building'),
            'name': tags.get('name'),
        },
        'buildingPart': part,
        'match': {
            'canonicalId': part.get('bestCanonicalId'),
            'relation': 'PART_OF_CANONICAL' if part['verdict'] == 'BUILDING_PART_CANDIDATE' else 'UNCERTAIN',
            'lod1SuppressionAllowed': False,
            'suppressionNote': 'building part なので canonical 建物全体の LOD1 は消さない（§7）。',
            'sourceCentroid': src_centroid_world,
            'sourceFootprintAreaM2': round(float(poly.area), 3),
            'sourceRing': [[round(v, 4) for v in world(*to_ll.transform(x, y)[::-1])] for x, y in ext],
        },
        'pointCloud': pstats,
        'roof': {
            'type': roof_type,
            'planeCount': len(planes),
            'minSupport': min_support,
            'droppedPlanes': dropped,
            'ransac': {'iterations': RANSAC_ITERS, 'toleranceM': RANSAC_TOL_M, 'seed': args.seed},
            'planes': plane_out,
        },
        'geometry': {
            'vertices': vertices,
            'indices': indices,
            'groups': groups,
            'triangleCount': len(indices) // 3,
            'roofTriangles': roof_triangles,
            'wallTriangles': wall_triangles,
        },
        'measurement': {
            'localGroundAltitudeM': round(ground, 3),
            'roofCandidatePoints': int(len(rz)),
            'heightMedianM': round(float(np.median(heights)), 3),
            'heightMaxM': round(float(np.max(heights)), 3),
            'roofType': roof_type,
        },
        'containment': containment,
        'provenance': {
            'roofElevation': 'LAS observed returns inside the OSM building part footprint; RANSAC plane fitting',
            'footprint': 'OpenStreetMap way polygon (treated as building part)',
            'warning': 'Experimental Live City custom roof; not official PLATEAU LOD2 and not survey-certified.',
        },
    }
    out_path.write_text(json.dumps(doc, ensure_ascii=False), encoding='utf-8')
    (rep_dir / 'planes.json').write_text(json.dumps({
        k: v for k, v in doc.items() if k != 'geometry'
    } | {'geometrySummary': {k: v for k, v in doc['geometry'].items() if k not in ('vertices', 'indices')}},
        ensure_ascii=False, indent=2), encoding='utf-8')
    print(f'[35U] part={part["verdict"]} roofPoints={len(rz)} planes={len(planes)} '
          f'roofTri={roof_triangles} wallTri={wall_triangles} containment={"ok" if containment["ok"] else "NG"}')
    print(f'[35U] out {out_path}')
    return doc


if __name__ == '__main__':
    main()
