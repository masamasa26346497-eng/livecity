#!/usr/bin/env node
'use strict';
// Mission 37B: 既存 Live City 建物 tile JSON → 3D Tiles 1.1 tileset（glTF/GLB content）変換。
//   既存 500m tile 1つ = 1 leaf content(GLB)。4×4 tile の group ごとに簡略 LOD の親 content(GLB) を置く。
//   canonicalId（building.id = "bldg_<uuid>"）は新規採番せず、そのまま
//     (a) glTF EXT_mesh_features(_FEATURE_ID_0) + EXT_structural_metadata の文字列プロパティ `canonicalId`
//     (b) 同名の sidecar JSON（ids/*.json、featureId 順の配列。クライアント側の照合・フォールバック用）
//   に保持する。入力（public/map-data/osaka-city/buildings/{dataset}/）は読み取り専用。
//
// 使い方（ネットワーク不要）:
//   node tools/mission37b-build-3dtiles.cjs                       # 既定: osaka-sumiyoshi の 9 tile (tx -6..-4, tz -3..-1)
//   node tools/mission37b-build-3dtiles.cjs --all                 # manifest 全 52 tile
//   オプション: --dataset --tx0 --tx1 --tz0 --tz1 --out <dir> --group 4 --coarse-error 40 --coarse-min-area 100
// 座標: znorth-neg-v1。geoToThree() (osaka_3d_buildings.html) の厳密な逆変換
//   lon = CLON + x/(cos(CLAT)*MPD), lat = CLAT - z/MPD を使い、WGS84 楕円体 → ECEF → tile ローカル ENU。
const fs = require('fs');
const path = require('path');

// ── geoToThree() と同一定数（変更禁止）──
const CLAT = 34.604208, CLON = 135.525020, MPD = 111320;
const COS_CLAT = Math.cos(CLAT * Math.PI / 180);
const localToLon = (x) => CLON + x / (COS_CLAT * MPD);
const localToLat = (z) => CLAT - z / MPD;
const D2R = Math.PI / 180;
const TILE = 500;

// ── WGS84 / ENU ──
const WA = 6378137, WE2 = 0.00669437999014;
function ecef(lonDeg, latDeg, h) {
  const l = lonDeg * D2R, p = latDeg * D2R, s = Math.sin(p), c = Math.cos(p);
  const N = WA / Math.sqrt(1 - WE2 * s * s);
  return [(N + h) * c * Math.cos(l), (N + h) * c * Math.sin(l), (N * (1 - WE2) + h) * s];
}
function enuBasis(lonDeg, latDeg) {
  const l = lonDeg * D2R, p = latDeg * D2R;
  return {
    e: [-Math.sin(l), Math.cos(l), 0],
    n: [-Math.sin(p) * Math.cos(l), -Math.sin(p) * Math.sin(l), Math.cos(p)],
    u: [Math.cos(p) * Math.cos(l), Math.cos(p) * Math.sin(l), Math.sin(p)],
  };
}
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
function makeFrame(lonDeg, latDeg) {
  const b = enuBasis(lonDeg, latDeg);
  return { lon: lonDeg, lat: latDeg, b, t: ecef(lonDeg, latDeg, 0) };
}
function frameMatrix(f) { // 3D Tiles transform（column-major）
  return [...f.b.e, 0, ...f.b.n, 0, ...f.b.u, 0, ...f.t, 1];
}
// 子の transform = inv(親) * 子（親子とも剛体変換）
function relativeMatrix(parent, child) {
  const R = (f) => [f.b.e, f.b.n, f.b.u]; // 列ベクトル
  const pc = R(parent), cc = R(child);
  const out = [];
  for (const c of cc) out.push(dot(pc[0], c), dot(pc[1], c), dot(pc[2], c), 0);
  const d = [child.t[0] - parent.t[0], child.t[1] - parent.t[1], child.t[2] - parent.t[2]];
  out.push(dot(pc[0], d), dot(pc[1], d), dot(pc[2], d), 1);
  return out;
}
function toEnu(f, lonDeg, latDeg, h) {
  const p = ecef(lonDeg, latDeg, h);
  const d = [p[0] - f.t[0], p[1] - f.t[1], p[2] - f.t[2]];
  return [dot(f.b.e, d), dot(f.b.n, d), dot(f.b.u, d)];
}

// ── footprint 前処理 / 三角形分割（ear clipping）──
function cleanRing(fp) {
  const out = [];
  let px = null, pz = null;
  for (const p of fp) {
    if (p[0] === px && p[1] === pz) continue;
    out.push([p[0], p[1]]); px = p[0]; pz = p[1];
  }
  if (out.length > 1 && out[0][0] === out[out.length - 1][0] && out[0][1] === out[out.length - 1][1]) out.pop();
  return out.length >= 3 ? out : null;
}
// 平面座標は (east, north) = (x, -z)
function signedArea(r) {
  let a = 0;
  for (let i = 0; i < r.length; i++) { const p = r[i], q = r[(i + 1) % r.length]; a += p[0] * q[1] - q[0] * p[1]; }
  return a / 2;
}
const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
function inTri(p, a, b, c) {
  return cross(a, b, p) >= 0 && cross(b, c, p) >= 0 && cross(c, a, p) >= 0;
}
// pts は CCW 前提。戻り値: { tris:[i,j,k...], fallback:bool }
function triangulate(pts) {
  const n = pts.length;
  const idx = Array.from({ length: n }, (_, i) => i);
  const tris = [];
  let guard = 0, fallback = false;
  while (idx.length > 3 && guard++ < n * n) {
    let clipped = false;
    for (let i = 0; i < idx.length; i++) {
      const ia = idx[(i + idx.length - 1) % idx.length], ib = idx[i], ic = idx[(i + 1) % idx.length];
      const a = pts[ia], b = pts[ib], c = pts[ic];
      if (cross(a, b, c) <= 1e-9) continue; // 凸でない/退化
      let ok = true;
      for (const j of idx) {
        if (j === ia || j === ib || j === ic) continue;
        if (inTri(pts[j], a, b, c)) { ok = false; break; }
      }
      if (!ok) continue;
      tris.push(ia, ib, ic); idx.splice(i, 1); clipped = true; break;
    }
    if (!clipped) { // 自己交差等: 退化頂点を捨てて続行、それも無理なら残りを fan で閉じる
      let removed = false;
      for (let i = 0; i < idx.length; i++) {
        const a = pts[idx[(i + idx.length - 1) % idx.length]], b = pts[idx[i]], c = pts[idx[(i + 1) % idx.length]];
        if (Math.abs(cross(a, b, c)) <= 1e-9) { idx.splice(i, 1); removed = true; break; }
      }
      if (!removed) { fallback = true; break; }
    }
  }
  if (idx.length === 3) tris.push(idx[0], idx[1], idx[2]);
  else if (fallback) for (let i = 1; i + 1 < idx.length; i++) tris.push(idx[0], idx[i], idx[i + 1]);
  return { tris, fallback };
}

function colorFor(h) { // Primitive 版 POC (colorFor) と同一
  const t = Math.min(h / 60, 1);
  return [Math.round(190 - 70 * t), Math.round(200 - 50 * t), Math.round(215 - 20 * t)];
}

// ── GLB 生成 ──
// features: [{ id, fp:[[x,z]...], z0, top, h }]（ローカル m）、frame: makeFrame()
// 戻り値: { glb, ids, stats:{buildings, skipped, fallbacks, vertices, triangles}, ext:{w,e,s,n,minH,maxH} }
function buildGlb(features, frame) {
  const pos = [], col = [], fid = [], idxs = [];
  const ids = [];
  const st = { buildings: 0, skipped: 0, fallbacks: 0, vertices: 0, triangles: 0 };
  const ext = { w: Infinity, e: -Infinity, s: Infinity, n: -Infinity, minH: Infinity, maxH: -Infinity };
  let vcount = 0;
  const pushV = (enu, rgb, f) => { // ENU(E,N,U) → glTF Y-up (E, U, -N)。Cesium が Y-up→Z-up へ戻す
    pos.push(enu[0], enu[2], -enu[1]); col.push(rgb[0], rgb[1], rgb[2], 255); fid.push(f); return vcount++;
  };
  for (const b of features) {
    let ring = cleanRing(b.fp);
    if (!ring) { st.skipped++; continue; }
    let planar = ring.map(p => [p[0], -p[1]]);
    let area = signedArea(planar);
    if (Math.abs(area) < 0.01) { st.skipped++; continue; }
    if (area < 0) { ring = ring.slice().reverse(); planar = planar.reverse(); }
    const { tris, fallback } = triangulate(planar);
    if (!tris.length) { st.skipped++; continue; }
    if (fallback) st.fallbacks++;
    const f = ids.length; ids.push(b.id);
    const roof = colorFor(b.h), wall = roof.map(v => Math.round(v * 0.78));
    const lonlat = ring.map(p => [localToLon(p[0]), localToLat(p[1])]);
    for (const [lo, la] of lonlat) {
      if (lo < ext.w) ext.w = lo; if (lo > ext.e) ext.e = lo;
      if (la < ext.s) ext.s = la; if (la > ext.n) ext.n = la;
    }
    ext.minH = Math.min(ext.minH, b.z0); ext.maxH = Math.max(ext.maxH, b.top);
    // 屋根
    const base = vcount;
    for (const [lo, la] of lonlat) pushV(toEnu(frame, lo, la, b.top), roof, f);
    for (const t of tris) idxs.push(base + t);
    st.triangles += tris.length / 3;
    // 側面
    for (let i = 0; i < lonlat.length; i++) {
      const [l0, a0] = lonlat[i], [l1, a1] = lonlat[(i + 1) % lonlat.length];
      const v0 = pushV(toEnu(frame, l0, a0, b.z0), wall, f), v1 = pushV(toEnu(frame, l1, a1, b.z0), wall, f);
      const v2 = pushV(toEnu(frame, l1, a1, b.top), wall, f), v3 = pushV(toEnu(frame, l0, a0, b.top), wall, f);
      idxs.push(v0, v1, v2, v0, v2, v3);
      st.triangles += 2;
    }
    st.buildings++;
  }
  st.vertices = vcount;
  if (!ids.length) return null;

  // 文字列プロパティ（canonicalId）
  const strBufs = ids.map(s => Buffer.from(s, 'utf8'));
  const offs = new Uint32Array(ids.length + 1);
  strBufs.forEach((b, i) => { offs[i + 1] = offs[i] + b.length; });
  const strBytes = Buffer.concat(strBufs);

  // バッファ連結（各 bufferView は 4 byte 境界）
  const chunks = []; const views = []; let off = 0;
  const addView = (buf, target) => {
    const pad = (4 - (off % 4)) % 4; if (pad) { chunks.push(Buffer.alloc(pad)); off += pad; }
    views.push({ buffer: 0, byteOffset: off, byteLength: buf.length, ...(target ? { target } : {}) });
    chunks.push(buf); off += buf.length; return views.length - 1;
  };
  const posA = new Float32Array(pos), fidA = new Float32Array(fid), idxA = new Uint32Array(idxs);
  const vPos = addView(Buffer.from(posA.buffer), 34962);
  const vCol = addView(Buffer.from(Uint8Array.from(col).buffer), 34962);
  const vFid = addView(Buffer.from(fidA.buffer), 34962);
  const vIdx = addView(Buffer.from(idxA.buffer), 34963);
  const vStr = addView(strBytes, null);
  const vOff = addView(Buffer.from(offs.buffer), null);

  let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < posA.length; i += 3) for (let k = 0; k < 3; k++) { if (posA[i + k] < mn[k]) mn[k] = posA[i + k]; if (posA[i + k] > mx[k]) mx[k] = posA[i + k]; }

  const json = {
    asset: { version: '2.0', generator: 'livecity mission37b-build-3dtiles' },
    extensionsUsed: ['KHR_materials_unlit', 'EXT_mesh_features', 'EXT_structural_metadata'],
    scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{
      attributes: { POSITION: 0, COLOR_0: 1, _FEATURE_ID_0: 2 }, indices: 3, material: 0, mode: 4,
      extensions: { EXT_mesh_features: { featureIds: [{ featureCount: ids.length, attribute: 0, propertyTable: 0 }] } },
    }] }],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 1 },
      doubleSided: true, extensions: { KHR_materials_unlit: {} } }],
    accessors: [
      { bufferView: vPos, componentType: 5126, count: vcount, type: 'VEC3', min: mn, max: mx },
      { bufferView: vCol, componentType: 5121, normalized: true, count: vcount, type: 'VEC4' },
      { bufferView: vFid, componentType: 5126, count: vcount, type: 'SCALAR' },
      { bufferView: vIdx, componentType: 5125, count: idxs.length, type: 'SCALAR' },
    ],
    bufferViews: views, buffers: [{ byteLength: off + ((4 - (off % 4)) % 4) }],
    extensions: { EXT_structural_metadata: {
      schema: { id: 'livecity-building', classes: { building: { name: 'Building', properties: {
        canonicalId: { description: 'Live City canonicalId (building.id, unchanged)', type: 'STRING', required: true } } } } },
      propertyTables: [{ name: 'buildings', class: 'building', count: ids.length,
        properties: { canonicalId: { values: vStr, stringOffsets: vOff, stringOffsetType: 'UINT32' } } }],
    } },
  };
  const tail = (4 - (off % 4)) % 4; if (tail) { chunks.push(Buffer.alloc(tail)); off += tail; }
  const bin = Buffer.concat(chunks);
  let js = Buffer.from(JSON.stringify(json), 'utf8');
  const jp = (4 - (js.length % 4)) % 4; if (jp) js = Buffer.concat([js, Buffer.alloc(jp, 0x20)]);
  const total = 12 + 8 + js.length + 8 + bin.length;
  const head = Buffer.alloc(12 + 8);
  head.writeUInt32LE(0x46546C67, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(total, 8);
  head.writeUInt32LE(js.length, 12); head.writeUInt32LE(0x4E4F534A, 16);
  const binHead = Buffer.alloc(8); binHead.writeUInt32LE(bin.length, 0); binHead.writeUInt32LE(0x004E4942, 4);
  return { glb: Buffer.concat([head, js, binHead, bin]), ids, stats: st, ext };
}

// テスト/検証用: GLB を読み戻して { json, canonicalIds, featureIds } を返す
function parseGlb(buf) {
  if (buf.readUInt32LE(0) !== 0x46546C67) throw new Error('not GLB');
  const jl = buf.readUInt32LE(12);
  const json = JSON.parse(buf.slice(20, 20 + jl).toString('utf8'));
  const bo = 20 + jl + 8;
  const bin = buf.slice(bo, bo + buf.readUInt32LE(20 + jl));
  const v = json.bufferViews;
  const pt = json.extensions.EXT_structural_metadata.propertyTables[0].properties.canonicalId;
  const so = v[pt.stringOffsets], sv = v[pt.values];
  const count = json.extensions.EXT_structural_metadata.propertyTables[0].count;
  const canonicalIds = [];
  for (let i = 0; i < count; i++) {
    const a = bin.readUInt32LE(so.byteOffset + i * 4), b = bin.readUInt32LE(so.byteOffset + (i + 1) * 4);
    canonicalIds.push(bin.slice(sv.byteOffset + a, sv.byteOffset + b).toString('utf8'));
  }
  const fv = v[json.accessors[2].bufferView], fc = json.accessors[2].count;
  const featureIds = new Set();
  for (let i = 0; i < fc; i++) featureIds.add(bin.readFloatLE(fv.byteOffset + i * 4));
  return { json, canonicalIds, featureIds };
}

// ── tileset 生成 ──
function loadFeatures(tileJson) {
  return tileJson.buildings.map(b => {
    const z0 = b.z0 || 0;
    const dz = b.dz || b.h || 3;
    return { id: b.id, fp: b.fp, z0, top: z0 + dz, h: b.h || dz };
  });
}
// 簡略 LOD: footprint の軸平行 bbox を押し出し、小建物（bbox 面積 < minArea）は除外
function coarsen(features, minArea) {
  const out = [];
  for (const b of features) {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const p of b.fp) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); z0 = Math.min(z0, p[1]); z1 = Math.max(z1, p[1]); }
    if ((x1 - x0) * (z1 - z0) < minArea) continue;
    out.push({ ...b, fp: [[x0, z0], [x1, z0], [x1, z1], [x0, z1]] });
  }
  return out;
}
const region = (e) => [e.w * D2R, e.s * D2R, e.e * D2R, e.n * D2R, Math.floor(e.minH), Math.ceil(e.maxH)];
const mergeExt = (a, b) => ({ w: Math.min(a.w, b.w), e: Math.max(a.e, b.e), s: Math.min(a.s, b.s), n: Math.max(a.n, b.n),
  minH: Math.min(a.minH, b.minH), maxH: Math.max(a.maxH, b.maxH) });

function build(opts) {
  const dir = path.join(__dirname, '..', 'public', 'map-data', 'osaka-city', 'buildings', opts.dataset);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  if (manifest.coordinateConvention !== 'znorth-neg-v1') throw new Error('coordinateConvention=' + manifest.coordinateConvention);
  const sel = manifest.tiles.filter(t => opts.all || (t.tx >= opts.tx0 && t.tx <= opts.tx1 && t.tz >= opts.tz0 && t.tz <= opts.tz1));
  fs.rmSync(opts.out, { recursive: true, force: true });
  for (const sub of ['tiles', 'lod', 'ids']) fs.mkdirSync(path.join(opts.out, sub), { recursive: true });

  const groups = new Map();
  for (const t of sel) {
    const g = Math.floor(t.tx / opts.group) + '_' + Math.floor(t.tz / opts.group);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(t);
  }
  const report = { dataset: opts.dataset, selectedTiles: sel.length, groups: groups.size, leaf: [], coarse: [], totals: { buildings: 0, sourceBuildings: 0, skipped: 0, fallbacks: 0, glbBytes: 0 } };
  const allIds = new Set();
  let rootExt = null;
  const groupNodes = [];
  for (const [gk, tiles] of [...groups.entries()].sort()) {
    const leafs = []; let gExt = null; const gFeatures = [];
    for (const t of tiles) {
      const feats = loadFeatures(JSON.parse(fs.readFileSync(path.join(dir, t.file), 'utf8')));
      report.totals.sourceBuildings += feats.length;
      // tile 中心フレーム（フレーム原点は tile の矩形中心。bbox は後で実頂点から算出）
      const frame = makeFrame(localToLon((t.tx + 0.5) * TILE), localToLat((t.tz + 0.5) * TILE));
      const r = buildGlb(feats, frame);
      if (!r) continue;
      const name = 't_' + t.tx + '_' + t.tz;
      fs.writeFileSync(path.join(opts.out, 'tiles', name + '.glb'), r.glb);
      fs.writeFileSync(path.join(opts.out, 'ids', name + '.json'), JSON.stringify(r.ids));
      r.ids.forEach(i => { if (allIds.has(i)) throw new Error('duplicate canonicalId ' + i); allIds.add(i); });
      report.totals.buildings += r.stats.buildings; report.totals.skipped += r.stats.skipped; report.totals.fallbacks += r.stats.fallbacks;
      report.totals.glbBytes += r.glb.length;
      report.leaf.push({ name, ...r.stats, bytes: r.glb.length });
      leafs.push({ t, name, frame, r });
      gExt = gExt ? mergeExt(gExt, r.ext) : r.ext;
      const kept = new Set(r.ids);
      for (const f of feats) if (kept.has(f.id)) gFeatures.push(f);
    }
    if (!leafs.length) continue;
    const gfRaw = coarsen(gFeatures, opts.coarseMinArea);
    const gframe = makeFrame((gExt.w + gExt.e) / 2, (gExt.s + gExt.n) / 2);
    const cr = buildGlb(gfRaw, gframe);
    const gname = 'g_' + gk;
    const node = {
      boundingVolume: { region: region(gExt) }, geometricError: opts.coarseError, refine: 'REPLACE',
      transform: frameMatrix(gframe),
      children: leafs.map(l => ({
        boundingVolume: { region: region(l.r.ext) }, geometricError: 0, refine: 'REPLACE',
        transform: relativeMatrix(gframe, l.frame),
        content: { uri: 'tiles/' + l.name + '.glb' },
        extras: { tx: l.t.tx, tz: l.t.tz, buildings: l.r.stats.buildings, idsUri: 'ids/' + l.name + '.json' },
      })),
    };
    if (cr) {
      fs.writeFileSync(path.join(opts.out, 'lod', gname + '.glb'), cr.glb);
      fs.writeFileSync(path.join(opts.out, 'ids', gname + '.json'), JSON.stringify(cr.ids));
      node.content = { uri: 'lod/' + gname + '.glb' };
      node.extras = { group: gk, buildings: cr.stats.buildings, idsUri: 'ids/' + gname + '.json', lod: 'coarse-bbox' };
      report.coarse.push({ name: gname, ...cr.stats, bytes: cr.glb.length });
      report.totals.glbBytes += cr.glb.length;
    }
    groupNodes.push(node);
    rootExt = rootExt ? mergeExt(rootExt, gExt) : gExt;
  }
  const tileset = {
    asset: { version: '1.1', tilesetVersion: 'mission37b-' + opts.dataset },
    geometricError: opts.coarseError * 4,
    root: { boundingVolume: { region: region(rootExt) }, geometricError: opts.coarseError * 4, refine: 'REPLACE', children: groupNodes },
    extras: { dataset: opts.dataset, tiles: sel.length, buildings: report.totals.buildings,
      note: 'canonicalId = building.id unchanged (EXT_structural_metadata property canonicalId + ids/*.json sidecar)' },
  };
  fs.writeFileSync(path.join(opts.out, 'tileset.json'), JSON.stringify(tileset));
  report.totals.uniqueCanonicalIds = allIds.size;
  report.options = { group: opts.group, coarseError: opts.coarseError, coarseMinArea: opts.coarseMinArea };
  fs.writeFileSync(path.join(opts.out, 'build-report.json'), JSON.stringify(report, null, 1));
  return report;
}

function main() {
  const args = process.argv.slice(2);
  const has = (k) => args.includes('--' + k);
  const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
  const o = {
    dataset: opt('dataset', 'osaka-sumiyoshi'), all: has('all'),
    tx0: +opt('tx0', -6), tx1: +opt('tx1', -4), tz0: +opt('tz0', -3), tz1: +opt('tz1', -1),
    group: +opt('group', 4), coarseError: +opt('coarse-error', 40), coarseMinArea: +opt('coarse-min-area', 100),
  };
  o.out = path.resolve(opt('out', path.join(__dirname, '..', 'public', 'mission37b-3dtiles', o.dataset + (o.all ? '-all' : '-9tile'))));
  const r = build(o);
  console.log(JSON.stringify({ out: path.relative(process.cwd(), o.out), selectedTiles: r.selectedTiles, groups: r.groups, ...r.totals }, null, 1));
  if (r.totals.buildings + r.totals.skipped !== r.totals.sourceBuildings) { console.error('building count mismatch'); process.exit(1); }
}

module.exports = { buildGlb, parseGlb, build, makeFrame, frameMatrix, relativeMatrix, triangulate, cleanRing, signedArea, loadFeatures, coarsen, localToLon, localToLat };
if (require.main === module) main();
