#!/usr/bin/env python3
"""Mission 35R - zero-cost LOD2 experiments.

A) Match real Osaka LAS points to a real OSM building footprint and derive a roof mesh.
B) Build a lightweight gable roof from the same real footprint + one height value.
C) Produce a photogrammetry replacement manifest/adaptor contract; real reconstruction
   still requires a user-supplied overlapping photo/Scaniverse capture set.

Experiment only. Never mutates Live City production/dev geometry.
"""
from __future__ import annotations
import argparse, json, math, os, urllib.parse, urllib.request
from pathlib import Path

import laspy
import numpy as np
from pyproj import Transformer
from shapely.geometry import Polygon
from shapely import contains_xy

UA = 'LiveCity-Mission35R/1.1'


def write_obj(path: Path, verts, faces, comment):
    with path.open('w', encoding='utf-8') as f:
        f.write('# ' + comment + '\n')
        for x, y, z in verts:
            f.write(f'v {x:.3f} {z:.3f} {-y:.3f}\n')
        for face in faces:
            f.write('f ' + ' '.join(str(i + 1) for i in face) + '\n')


def slippy(lat, lon, z):
    n = 2 ** z
    x = int((lon + 180.0) / 360.0 * n)
    latr = math.radians(lat)
    y = int((1.0 - math.asinh(math.tan(latr)) / math.pi) / 2.0 * n)
    return x, y


def get_json(url, data=None, timeout=60):
    headers = {'User-Agent': UA}
    if data is not None:
        data = urllib.parse.urlencode(data).encode('utf-8')
        headers['Content-Type'] = 'application/x-www-form-urlencoded'
    req = urllib.request.Request(url, data=data, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode('utf-8'))


def fetch_osm_buildings(lat, lon, radius_m=180):
    q = f'''[out:json][timeout:40];way(around:{radius_m},{lat},{lon})[building];out geom tags;'''
    endpoints = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter']
    last = None
    for ep in endpoints:
        try:
            j = get_json(ep, {'data': q}, 60)
            out = []
            for e in j.get('elements', []):
                geom = e.get('geometry') or []
                if len(geom) < 4: continue
                ll = [(p['lon'], p['lat']) for p in geom]
                out.append({'osmId': e.get('id'), 'tags': e.get('tags', {}), 'lonlat': ll})
            if out: return out
        except Exception as exc:
            last = str(exc)
    raise RuntimeError('OSM building query failed: ' + str(last))


def try_ortho(outdir: Path, lat: float, lon: float):
    z = 17
    x, y = slippy(lat, lon, z)
    url = f'https://gic-plateau.s3.ap-northeast-1.amazonaws.com/2020/ortho/tiles/{z}/{x}/{y}.png'
    dst = outdir / f'ortho_z{z}_{x}_{y}.png'
    ok, err = False, None
    try:
        req = urllib.request.Request(url, headers={'User-Agent': UA})
        with urllib.request.urlopen(req, timeout=30) as r: data = r.read()
        if data.startswith(b'\x89PNG'): dst.write_bytes(data); ok = True
        else: err = f'not PNG ({len(data)} bytes)'
    except Exception as e: err = str(e)
    return {'url': url, 'tile': [z, x, y], 'downloaded': ok, 'error': err, 'path': str(dst) if ok else None}


def fan_faces(n):
    return [(0, i, i+1) for i in range(1, n-1)]


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

    # CRS: the published dataset is JGD2011; this Osaka engineering dataset matches
    # Japan Plane Rectangular CS VI coordinates in practice. Verify via plausible lat/lon.
    to_ll = Transformer.from_crs(6674, 4326, always_xy=True)
    to_xy = Transformer.from_crs(4326, 6674, always_xy=True)
    midx, midy = (float(np.min(xs)+np.max(xs))/2, float(np.min(ys)+np.max(ys))/2)
    midlon, midlat = to_ll.transform(midx, midy)
    crs_ok = 34.0 < midlat < 35.5 and 134.5 < midlon < 136.5
    if not crs_ok: raise RuntimeError(f'EPSG:6674 transform not plausible: {midlat},{midlon}')

    ground = float(np.percentile(zs, 10))
    high = zs > ground + 4.0

    # Locate a dense elevated area only to decide where to query OSM buildings.
    gx = np.floor(xs[high] / 10).astype(np.int64); gy = np.floor(ys[high] / 10).astype(np.int64)
    uniq, counts = np.unique(np.stack([gx,gy], axis=1), axis=0, return_counts=True)
    best = uniq[int(np.argmax(counts))]
    seedx, seedy = (best[0]+.5)*10, (best[1]+.5)*10
    seedlon, seedlat = to_ll.transform(seedx, seedy)

    osm = fetch_osm_buildings(seedlat, seedlon, 220)
    candidates = []
    for b in osm:
        coords = [to_xy.transform(lon,lat) for lon,lat in b['lonlat']]
        try: poly = Polygon(coords)
        except Exception: continue
        if not poly.is_valid: poly = poly.buffer(0)
        if poly.is_empty or poly.area < 20 or poly.area > 10000: continue
        minx,miny,maxx,maxy = poly.bounds
        box = (xs>=minx)&(xs<=maxx)&(ys>=miny)&(ys<=maxy)
        idx = np.flatnonzero(box)
        if len(idx) < 20: continue
        inside_local = contains_xy(poly, xs[idx], ys[idx])
        idx = idx[inside_local]
        if len(idx) < 20: continue
        zinside = zs[idx]
        elevated = int(np.count_nonzero(zinside > ground+3))
        if elevated < 15: continue
        roofness = elevated / len(idx)
        # Prefer many points, substantial elevated ratio, and reasonable footprint size.
        score = elevated * min(1.0, roofness*2) / (1.0 + max(0, poly.area-2500)/2500)
        candidates.append((score,b,poly,idx))
    if not candidates: raise RuntimeError('No OSM building with sufficient LAS points was found')
    candidates.sort(key=lambda x:x[0], reverse=True)
    score,bldg,poly,idx = candidates[0]

    cx,cy = poly.centroid.x, poly.centroid.y
    ring = list(poly.exterior.coords)[:-1]
    zinside = zs[idx]
    local_ground = float(np.percentile(zinside, 5))
    # upper half is a robust first roof estimate; avoids facade/ground returns.
    roof_cut = float(np.percentile(zinside, 65))
    roof_pts = zinside[zinside >= roof_cut]
    roof_z = float(np.median(roof_pts))
    height = max(3.0, roof_z-local_ground)
    minx,miny,maxx,maxy = poly.bounds
    width,depth=maxx-minx,maxy-miny
    clon,clat = to_ll.transform(cx,cy)

    # A: actual footprint + roof height measured from actual point cloud.
    # This is a conservative LOD2-like flat roof trial, not a claim of roof-type reconstruction.
    a_verts=[(x-cx,y-cy,height) for x,y in ring]
    a_obj=outdir/'A_pointcloud_osm_matched_roof.obj'
    write_obj(a_obj,a_verts,fan_faces(len(a_verts)),'Mission35R A: real OSM footprint + real Osaka LAS roof height')

    # B: cheap heuristic gable, using exactly the same footprint bbox and building height.
    h=height; ridge=min(3.5,max(0.8,.18*h))
    if width>=depth:
        b_verts=[(minx-cx,miny-cy,h),(maxx-cx,miny-cy,h),(maxx-cx,maxy-cy,h),(minx-cx,maxy-cy,h),
                 (minx-cx,(miny+maxy)/2-cy,h+ridge),(maxx-cx,(miny+maxy)/2-cy,h+ridge)]
        b_faces=[(0,1,5,4),(4,5,2,3),(0,4,3),(1,2,5)]
    else:
        b_verts=[(minx-cx,miny-cy,h),(maxx-cx,miny-cy,h),(maxx-cx,maxy-cy,h),(minx-cx,maxy-cy,h),
                 ((minx+maxx)/2-cx,miny-cy,h+ridge),((minx+maxx)/2-cx,maxy-cy,h+ridge)]
        b_faces=[(0,4,5,3),(4,1,2,5),(0,1,4),(3,5,2)]
    b_obj=outdir/'B_simple_gable_preview.obj'
    write_obj(b_obj,b_verts,b_faces,'Mission35R B: heuristic gable from footprint + height; roof type is NOT observed')

    ortho=try_ortho(outdir,clat,clon)
    c_manifest={'version':1,'mission':'35R','kind':'photogrammetry-building-replacement','status':'adapter-smoke-test-only',
      'realPhotoReconstructionPerformed':False,'reason':'No overlapping user photo/Scaniverse capture set was supplied in this conversation.',
      'acceptedFormats':['obj','glb','gltf'],'requiredPlacement':['canonicalId','anchorLat','anchorLon','rotationDeg','scaleMeters'],
      'standInMesh':a_obj.name,'rules':{'suppressLOD1OnlyAfterValidatedPlacement':True,'productionCutover':False}}
    (outdir/'C_photogrammetry_adapter_manifest.json').write_text(json.dumps(c_manifest,ensure_ascii=False,indent=2),encoding='utf-8')

    vals,cnts=np.unique(cls,return_counts=True)
    report={'mission':'35R','source':{'las':os.path.basename(args.las),'points':int(n),'sampled':int(len(xs)),'sampleStep':int(step)},
      'crs':{'assumed':'EPSG:6674','verifiedPlausible':crs_ok,'sampleCenterLatLon':[midlat,midlon]},
      'classificationSampleCounts':{str(int(k)):int(v) for k,v in zip(vals,cnts)},
      'warning':'LAS does not expose a building class 6 in the sampled classifications; OSM footprint matching is therefore mandatory for this experiment.',
      'matchedBuilding':{'osmWayId':bldg['osmId'],'name':bldg['tags'].get('name'),'buildingTag':bldg['tags'].get('building'),
        'centerLatLon':[clat,clon],'footprintAreaM2':float(poly.area),'footprintVertices':len(ring),'bboxM':[float(width),float(depth)],
        'samplePointsInside':int(len(idx)),'localGroundM':local_ground,'roofEstimateM':roof_z,'heightM':height,'selectionScore':float(score)},
      'methodA':{'obj':a_obj.name,'usesRealPointCloud':True,'usesRealBuildingFootprint':True,'roofTypeReconstructed':False,
        'usesAerialImage':bool(ortho.get('downloaded')),'ortho':ortho,'status':'TECHNICAL_PROTOTYPE_PASS'},
      'methodB':{'obj':b_obj.name,'usesObservedRoofType':False,'usesPointCloudForRoofShape':False,'ridgeExtraM':ridge,
        'status':'VISUAL_HEURISTIC_ONLY','warning':'gable shape is fabricated and must never be labeled official LOD2'},
      'methodC':c_manifest,'costJPY':0,'productionModified':False,'protectedModified':False}
    (outdir/'RESULT.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    md=f'''# Mission 35R experiment result v2\n\n- LAS points: **{n:,}** (sampled {len(xs):,})\n- Real OSM building matched: **way/{bldg['osmId']}** {bldg['tags'].get('name') or ''}\n- Footprint: **{poly.area:.1f} m²**, {len(ring)} vertices\n- LAS points inside footprint: **{len(idx):,}**\n- Estimated height from point cloud: **{height:.1f} m**\n- Method A: **PASS as technical prototype** — real footprint + real point-cloud roof elevation. Roof type itself is not reconstructed yet.\n- Method B: generated, but **heuristic only** — the gable is fabricated and cannot be treated as official LOD2.\n- Method C: adapter path prepared; **real photogrammetry reconstruction not run because no photo set was supplied**.\n- Ortho tile: **{'downloaded' if ortho.get('downloaded') else 'not downloaded'}**\n- Cost: **0 JPY**\n- Production/protected: **unchanged**\n'''
    (outdir/'SUMMARY.md').write_text(md,encoding='utf-8')
    print(md)

if __name__=='__main__': main()
