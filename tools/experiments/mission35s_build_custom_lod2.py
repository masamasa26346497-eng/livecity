#!/usr/bin/env python3
"""Mission 35S — build one experimental Live City custom high-LOD building.

Sources:
- Osaka City open LAS (Niitaka)
- real OSM building footprint way/267613423

The roof elevations are measured from the LAS. This output is explicitly
EXPERIMENTAL_POINT_CLOUD_ROOF and must not be called official PLATEAU LOD2.
"""
from __future__ import annotations
import argparse, json, math, urllib.request, xml.etree.ElementTree as ET
from pathlib import Path

import laspy
import numpy as np
from pyproj import Transformer
from scipy.spatial import Delaunay
from shapely.geometry import Point, Polygon

OSM_WAY_ID = 267613423
CENTER_LAT = 34.604208
CENTER_LON = 135.52502
MPD = 111320.0
COS_LAT = math.cos(math.radians(CENTER_LAT))


def world(lat: float, lon: float):
    return [(lon - CENTER_LON) * COS_LAT * MPD, -((lat - CENTER_LAT) * MPD)]


def fetch_osm_way(way_id: int):
    url = f'https://api.openstreetmap.org/api/0.6/way/{way_id}/full'
    req = urllib.request.Request(url, headers={'User-Agent': 'LiveCity-Mission35S/1.0'})
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


def local_percentile(points_xy, points_z, x, y, radius=5.0, q=75):
    d2 = (points_xy[:, 0]-x)**2 + (points_xy[:, 1]-y)**2
    vals = points_z[d2 <= radius*radius]
    if len(vals) < 6:
        idx = np.argpartition(d2, min(20, len(d2)-1))[:min(20, len(d2))]
        vals = points_z[idx]
    return float(np.percentile(vals, q))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--las', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--sample-cap', type=int, default=4_000_000)
    ap.add_argument('--grid-m', type=float, default=4.0)
    args = ap.parse_args()
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)

    ll, tags, osm_url = fetch_osm_way(OSM_WAY_ID)
    to_plane = Transformer.from_crs(4326, 6674, always_xy=True)
    to_ll = Transformer.from_crs(6674, 4326, always_xy=True)
    ring_xy = [to_plane.transform(lon, lat) for lat, lon in ll]
    poly = Polygon(ring_xy)
    if not poly.is_valid:
        poly = poly.buffer(0)
    if not poly.is_valid or poly.area < 20:
        raise RuntimeError('invalid OSM building polygon')

    las = laspy.read(args.las)
    n = len(las.points)
    step = max(1, math.ceil(n / args.sample_cap))
    xs = np.asarray(las.x[::step], dtype=np.float64)
    ys = np.asarray(las.y[::step], dtype=np.float64)
    zs = np.asarray(las.z[::step], dtype=np.float64)
    cls = np.asarray(las.classification[::step], dtype=np.uint8)

    minx, miny, maxx, maxy = poly.bounds
    box = (xs >= minx-12) & (xs <= maxx+12) & (ys >= miny-12) & (ys <= maxy+12)
    bx, by, bz, bc = xs[box], ys[box], zs[box], cls[box]
    inside = np.array([poly.covers(Point(float(x), float(y))) for x, y in zip(bx, by)], dtype=bool)
    if inside.sum() < 100:
        raise RuntimeError('too few LAS points inside OSM footprint')

    # Ground: prefer LAS class 2 around the building, fall back to low percentile.
    near_ground = bz[bc == 2]
    if len(near_ground) >= 30:
        ground = float(np.median(near_ground))
    else:
        ground = float(np.percentile(bz, 10))

    rx, ry, rz = bx[inside], by[inside], bz[inside]
    roof_mask = rz > ground + 2.5
    rx, ry, rz = rx[roof_mask], ry[roof_mask], rz[roof_mask]
    if len(rz) < 100:
        raise RuntimeError('too few roof candidate points')
    roof_xy = np.column_stack([rx, ry])

    # Interior support points: grid cells inside footprint, robust 75th percentile.
    support = []
    g = args.grid_m
    gx = np.arange(math.floor(minx/g)*g + g/2, maxx, g)
    gy = np.arange(math.floor(miny/g)*g + g/2, maxy, g)
    for x in gx:
        for y in gy:
            if not poly.covers(Point(float(x), float(y))):
                continue
            cell = (np.abs(rx-x) <= g/2) & (np.abs(ry-y) <= g/2)
            if cell.sum() >= 5:
                support.append((float(x), float(y), float(np.percentile(rz[cell], 75))))

    # Boundary support ensures the roof terminates exactly at the real footprint.
    boundary = []
    for x, y in list(poly.exterior.coords)[:-1]:
        boundary.append((float(x), float(y), local_percentile(roof_xy, rz, x, y, radius=6.0, q=70)))

    points = boundary + support
    if len(points) < 6:
        raise RuntimeError('not enough roof support points')
    xy = np.array([[p[0], p[1]] for p in points], dtype=np.float64)
    heights = np.array([p[2] for p in points], dtype=np.float64)
    tri = Delaunay(xy)

    # Convert support points to exact Live City world convention.
    vertices = []
    for (x, y), alt in zip(xy, heights):
        lon, lat = to_ll.transform(float(x), float(y))
        wx, wz = world(lat, lon)
        vertices.append([round(wx, 4), round(max(0.1, alt-ground), 4), round(wz, 4)])

    roof_indices = []
    for a, b, c in tri.simplices:
        cx = float((xy[a,0]+xy[b,0]+xy[c,0])/3)
        cy = float((xy[a,1]+xy[b,1]+xy[c,1])/3)
        if poly.covers(Point(cx, cy)):
            roof_indices.extend([int(a), int(b), int(c)])

    indices = list(roof_indices)
    groups = [{'kind': 'roof', 'start': 0, 'count': len(roof_indices)}]

    # Walls use the same real footprint. Top vertices take measured local roof elevation.
    wall_start = len(indices)
    ring_world = []
    for i, (x, y) in enumerate(list(poly.exterior.coords)[:-1]):
        lon, lat = to_ll.transform(float(x), float(y))
        wx, wz = world(lat, lon)
        ring_world.append([round(wx,4), round(wz,4)])
    for i in range(len(boundary)):
        j = (i+1) % len(boundary)
        bi = len(vertices); vertices.append([ring_world[i][0], 0.0, ring_world[i][1]])
        bj = len(vertices); vertices.append([ring_world[j][0], 0.0, ring_world[j][1]])
        ti = len(vertices); vertices.append([ring_world[i][0], round(max(0.1,boundary[i][2]-ground),4), ring_world[i][1]])
        tj = len(vertices); vertices.append([ring_world[j][0], round(max(0.1,boundary[j][2]-ground),4), ring_world[j][1]])
        indices.extend([bi,bj,tj, bi,tj,ti])
    groups.append({'kind':'wall','start':wall_start,'count':len(indices)-wall_start})

    # Ground cap triangulated from footprint only.
    ground_start = len(indices)
    ground_base = len(vertices)
    ground_xy = np.array(list(poly.exterior.coords)[:-1], dtype=np.float64)
    for wx, wz in ring_world:
        vertices.append([wx, 0.0, wz])
    gt = Delaunay(ground_xy)
    for a,b,c in gt.simplices:
        cx = float((ground_xy[a,0]+ground_xy[b,0]+ground_xy[c,0])/3)
        cy = float((ground_xy[a,1]+ground_xy[b,1]+ground_xy[c,1])/3)
        if poly.covers(Point(cx,cy)):
            indices.extend([ground_base+int(a),ground_base+int(c),ground_base+int(b)])
    groups.append({'kind':'ground','start':ground_start,'count':len(indices)-ground_start})

    centroid = poly.centroid
    clon, clat = to_ll.transform(centroid.x, centroid.y)
    cxw, czw = world(clat, clon)
    ring_area_world = abs(sum(ring_world[i][0]*ring_world[(i+1)%len(ring_world)][1] - ring_world[(i+1)%len(ring_world)][0]*ring_world[i][1] for i in range(len(ring_world)))/2)

    doc = {
        'version': 1,
        'mission': '35S',
        'status': 'EXPERIMENTAL_POINT_CLOUD_ROOF',
        'officialPlateauLod2': False,
        'coordinateConvention': 'znorth-neg-v1',
        'source': {
            'pointCloud': 'Osaka City Niitaka A.las',
            'pointCloudPoints': int(n),
            'sampleStep': int(step),
            'osmWayId': OSM_WAY_ID,
            'osmUrl': osm_url,
            'buildingTag': tags.get('building'),
            'name': tags.get('name'),
        },
        'match': {
            'canonicalId': None,
            'method': 'runtime-footprint-spatial-match',
            'maxCentroidShiftM': 20,
            'sourceCentroid': [round(cxw,4), round(czw,4)],
            'sourceFootprintAreaM2': round(ring_area_world,3),
            'sourceRing': ring_world,
        },
        'measurement': {
            'localGroundAltitudeM': round(ground,4),
            'roofCandidatePoints': int(len(rz)),
            'roofSupportPoints': int(len(points)),
            'heightMedianM': round(float(np.median(rz)-ground),3),
            'heightP90M': round(float(np.percentile(rz,90)-ground),3),
            'roofMinM': round(float(np.min(heights)-ground),3),
            'roofMaxM': round(float(np.max(heights)-ground),3),
            'roofType': 'measured-triangulated-surface',
        },
        'geometry': {
            'vertices': vertices,
            'indices': indices,
            'groups': groups,
            'triangleCount': len(indices)//3,
        },
        'provenance': {
            'roofElevation': 'LAS observed returns within OSM building footprint; robust per-grid percentiles',
            'footprint': 'OpenStreetMap way polygon',
            'wallFootprint': 'same OSM polygon',
            'warning': 'Experimental Live City custom high-LOD; not official PLATEAU LOD2 and not survey-certified.',
        },
    }
    out.write_text(json.dumps(doc, ensure_ascii=False, separators=(',',':')), encoding='utf-8')
    print(json.dumps({
        'out': str(out), 'vertices': len(vertices), 'triangles': len(indices)//3,
        'roofSupport': len(points), 'heightMedianM': doc['measurement']['heightMedianM'],
        'centroid': doc['match']['sourceCentroid'], 'footprintAreaM2': doc['match']['sourceFootprintAreaM2']
    }, ensure_ascii=False, indent=2))

if __name__ == '__main__':
    main()
