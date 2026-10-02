#!/usr/bin/env node
// tools/audit/max-lod-reaudit.js
// [Mission 34D §5-§17] 大阪 24 区の PLATEAU をゼロベースで再監査し、
//   建物ごとに「実データとして存在する最高の *完全な* 外観 LOD」を判定する。
//   **geometry は作らない**（採用可否の判定と在庫だけ）。生成は tools/build-plateau-high-lod.js が担当。
//
//   34A との違い:
//     - LOD タグの置き場所を 3 つに分けて見る（Building 直下 / boundedBy 内 / BuildingPart 内）§5/§6
//     - xlink:href 参照だけで posList を持たない棟を「LOD 無し」と即断しない §7
//     - 「タグが 1 個ある」ではなく **屋根・壁・接地/閉合が揃っているか** で採否を決める §9/§10/§11
//     - 区属性が無い棟を N03 2026 の区 polygon で割り当て直す §17
//
//   実行: node --max-old-space-size=10240 tools/audit/max-lod-reaudit.js
//   出力: data/reports/max-lod-reaudit.json（集計）
//         data/processed/osaka-city/canonical/max-lod-index.json（棟ごとの判定）
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, isMainModule } from '../lib/paths.js';
import { readZipEntries, extractEntry } from '../lib/zip-reader.js';
import { latLonToLiveCityWorld } from '../lib/livecity-coordinate-system.js';
import { classifyPointToWard } from '../lib/point-in-polygon.js';
import { detach, buildingStarts, countOf, looksLikeBuildingCityGml, HEAD_BYTES, EXCLUDE_DIR, EXCLUDE_NAME } from './plateau-source-inventory.js';

const P = (...s) => resolveProjectPath(path.join(...s));
export const RA = {
  raw: P('data'),
  canonDir: P('data', 'processed', 'osaka-city', 'canonical', 'buildings-v2-osmv2'),
  wardPolys: P('data', 'processed', 'osaka-city', 'boundaries', 'ward-classification-polygons.json'),
  out: P('data', 'reports', 'max-lod-reaudit.json'),
  index: P('data', 'processed', 'osaka-city', 'canonical', 'max-lod-index.json'),
};
// §14 大阪 24 区（報告は必ず全区ぶん出す）
export const WARDS_24 = ['kita', 'miyakojima', 'fukushima', 'konohana', 'chuo', 'nishi', 'minato', 'taisho',
  'tennoji', 'naniwa', 'nishiyodogawa', 'yodogawa', 'higashiyodogawa', 'higashinari', 'ikuno', 'asahi',
  'joto', 'tsurumi', 'abeno', 'suminoe', 'sumiyoshi', 'higashisumiyoshi', 'hirano', 'nishinari'];
export const WARD_JA = { kita: '北区', miyakojima: '都島区', fukushima: '福島区', konohana: '此花区', chuo: '中央区',
  nishi: '西区', minato: '港区', taisho: '大正区', tennoji: '天王寺区', naniwa: '浪速区', nishiyodogawa: '西淀川区',
  yodogawa: '淀川区', higashiyodogawa: '東淀川区', higashinari: '東成区', ikuno: '生野区', asahi: '旭区',
  joto: '城東区', tsurumi: '鶴見区', abeno: '阿倍野区', suminoe: '住之江区', sumiyoshi: '住吉区',
  higashisumiyoshi: '東住吉区', hirano: '平野区', nishinari: '西成区' };
const JA_TO_ID = Object.fromEntries(Object.entries(WARD_JA).map(([k, v]) => [v, k]));

// §10/§11 完全性の基準。「タグが 1 個ある」では採用しない。
export const COMPLETE = {
  minRoofSurfaces: 1,       // 屋根面が 1 つも無ければ外観として不完全
  minWallSurfaces: 1,       // 壁面が 1 つも無ければ不完全
  minGroundOrClosure: 1,    // 接地面 or 閉合面が要る（下が抜けている shell は採らない）
  minPolygons: 3,           // 立体として最低限
  minPosLists: 3,
};
export const REJECT = {
  NO_HIGH_LOD_IN_SOURCE: 'NO_LOD2_IN_RAW_SOURCE',
  XLINK_ONLY: 'LOD_GEOMETRY_XLINK_ONLY',
  INCOMPLETE: 'LOD_INCOMPLETE',
  NO_GEOMETRY: 'LOD_NO_GEOMETRY',
};

const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };
export function pointInRing(x, z, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], zi = ring[i][1], xj = ring[j][0], zj = ring[j][1];
    if (((zi > z) !== (zj > z)) && (x < (xj - xi) * (z - zi) / (zj - zi) + xi)) inside = !inside;
  }
  return inside;
}
/**
 * §12/§13 gml:id で一致しない raw high LOD を、位置で canonical へ結び付ける。
 *   優先: footprint の内側 → 重心距離が近い（SPATIAL_NEAR_M 以内）。
 *   曖昧なものは採らない（§13）。
 */
export const SPATIAL_NEAR_M = 8;
export function spatialMatch(x, z, cells, CELL) {
  const cx = Math.floor(x / CELL), cz = Math.floor(z / CELL);
  let inside = null, nearest = null, nd = Infinity;
  for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
    for (const r of (cells.get((cx + i) + ',' + (cz + j)) || [])) {
      if (!inside && pointInRing(x, z, r.ring)) inside = r;
      const c = r.centroid;
      if (c) { const d = Math.hypot(c[0] - x, c[1] - z); if (d < nd) { nd = d; nearest = r; } }
    }
  }
  if (inside) return { canonicalId: inside.id, how: 'footprint-inside', distanceM: 0 };
  if (nearest && nd <= SPATIAL_NEAR_M) return { canonicalId: nearest.id, how: 'centroid-near', distanceM: +nd.toFixed(2) };
  return null;
}
const ID_RE = /gml:id="([^"]+)"/;
const WARD_RE = /<gen:stringAttribute name="区名"><gen:value>([^<]+)</;
const POS_RE = /<gml:posList[^>]*>([^<]{10,4000})/;

function* walk(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (EXCLUDE_NAME.test(e.name)) continue;
    if (e.isDirectory()) { if (EXCLUDE_DIR.test(p)) continue; yield* walk(p); }
    else yield p;
  }
}
export function collectSources() {
  const out = [];
  for (const p of walk(RA.raw)) {
    const ext = path.extname(p).toLowerCase();
    const rel = path.relative(resolveProjectPath('.'), p).replace(/\\/g, '/');
    if (ext === '.zip') {
      let entries; try { entries = readZipEntries(p); } catch { continue; }
      for (const e of entries) {
        if (!/\.(gml|xml)$/i.test(e.name) || EXCLUDE_NAME.test(e.name)) continue;
        let buf; try { buf = extractEntry(p, e); } catch { continue; }
        if (!looksLikeBuildingCityGml(buf.slice(0, HEAD_BYTES).toString('utf-8'), e.name)) continue;
        out.push({ id: rel + '::' + e.name, read: () => extractEntry(p, e).toString('utf-8') });
      }
      continue;
    }
    if (ext !== '.gml' && ext !== '.xml') continue;
    let st; try { st = fs.statSync(p); } catch { continue; }
    let head;
    try { const fd = fs.openSync(p, 'r'); const b = Buffer.alloc(Math.min(HEAD_BYTES, st.size)); fs.readSync(fd, b, 0, b.length, 0); fs.closeSync(fd); head = b.toString('utf-8'); } catch { continue; }
    if (!looksLikeBuildingCityGml(head, path.basename(p))) continue;
    out.push({ id: rel, read: () => fs.readFileSync(p, 'utf-8') });
  }
  return out;
}

/**
 * 建物 1 件を見て、LOD ごとの「外観としての完全性」を判定する（§9/§10/§11）。
 * BuildingPart の中の geometry も同じ建物のものとして数える（§6）。
 */
export function judgeBuilding(seg) {
  const idm = ID_RE.exec(seg);
  if (!idm) return null;
  const id = detach(idm[1]);
  const wm = WARD_RE.exec(seg);
  const ward = wm ? detach(wm[1]) : null;
  const parts = countOf(seg, '<bldg:BuildingPart');
  const xlinks = countOf(seg, 'xlink:href');
  const posLists = countOf(seg, '<gml:posList');

  const perLod = {};
  for (const lod of [2, 3]) {
    const tags = ['<bldg:lod' + lod + 'Solid', '<bldg:lod' + lod + 'MultiSurface', '<bldg:lod' + lod + 'Geometry'];
    const present = tags.some((t) => seg.indexOf(t) >= 0);
    if (!present) { perLod[lod] = { present: false }; continue; }
    // その LOD の geometry を持つ boundedBy を surface 種別ごとに数える
    const want = '<bldg:lod' + lod + 'MultiSurface';
    let roof = 0, wall = 0, ground = 0, closure = 0, other = 0, polys = 0, pos = 0;
    const reB = /<bldg:boundedBy>([\s\S]*?)<\/bldg:boundedBy>/g;
    let m;
    while ((m = reB.exec(seg))) {
      const body = m[1];
      if (body.indexOf(want) < 0) continue;
      const km = /<bldg:(\w+Surface)\b/.exec(body);
      const kind = km ? km[1] : 'other';
      const np = countOf(body, '<gml:Polygon');
      const npos = countOf(body, '<gml:posList');
      polys += np; pos += npos;
      if (kind === 'RoofSurface') roof += np;
      else if (kind === 'WallSurface') wall += np;
      else if (kind === 'GroundSurface') ground += np;
      else if (kind === 'ClosureSurface') closure += np;
      else other += np;
    }
    // boundedBy を経由しない直接 geometry（34A が見ていなかった経路）
    let direct = 0;
    for (const t of tags) {
      let i = seg.indexOf(t);
      while (i >= 0) {
        const close = seg.indexOf('</bldg:' + t.slice(7).replace(/[\s>].*$/, ''), i);
        const body = seg.slice(i, close > i ? close : Math.min(seg.length, i + 200000));
        // boundedBy の中にあるものは上で数えているので、ここでは「boundedBy の外」だけ
        const before = seg.lastIndexOf('<bldg:boundedBy', i);
        const closedBefore = seg.lastIndexOf('</bldg:boundedBy>', i);
        const insideBounded = before >= 0 && before > closedBefore;
        if (!insideBounded) direct += countOf(body, '<gml:posList');
        i = seg.indexOf(t, i + 1);
      }
    }
    const complete = roof >= COMPLETE.minRoofSurfaces && wall >= COMPLETE.minWallSurfaces
      && (ground + closure) >= COMPLETE.minGroundOrClosure
      && polys >= COMPLETE.minPolygons && pos >= COMPLETE.minPosLists;
    let reason = null;
    if (polys === 0 && direct === 0) reason = xlinks > 0 ? REJECT.XLINK_ONLY : REJECT.NO_GEOMETRY;
    else if (!complete) reason = REJECT.INCOMPLETE;
    perLod[lod] = { present: true, roof, wall, ground, closure, other, polygons: polys, posLists: pos,
      directPosLists: direct, complete, reason };
  }
  // 代表点（最初の posList の重心。区の割り当てと canonical 照合に使う §12/§17）
  let lat = null, lon = null;
  const pm = POS_RE.exec(seg);
  if (pm) {
    const nums = detach(pm[1]).trim().split(/\s+/).map(Number);
    const pts = [];
    for (let i = 0; i + 2 < nums.length; i += 3) {
      const a = nums[i], b = nums[i + 1];
      if (!(Number.isFinite(a) && Number.isFinite(b) && a > 20 && a < 50 && b > 120 && b < 150)) { pts.length = 0; break; }
      pts.push([a, b]);
    }
    if (pts.length >= 3) {
      if (pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]) pts.pop();
      let sa = 0, sb = 0; for (const q of pts) { sa += q[0]; sb += q[1]; }
      lat = sa / pts.length; lon = sb / pts.length;
    } else if (nums.length >= 2) { lat = nums[0]; lon = nums[1]; }
  }
  // §9 採用する LOD（完全な LOD3 > 完全な LOD2 > LOD1）
  let chosen = 1, chosenReason = REJECT.NO_HIGH_LOD_IN_SOURCE;
  if (perLod[3] && perLod[3].present && perLod[3].complete) { chosen = 3; chosenReason = null; }
  else if (perLod[2] && perLod[2].present && perLod[2].complete) { chosen = 2; chosenReason = null; }
  else if (perLod[3] && perLod[3].present) chosenReason = perLod[3].reason;
  else if (perLod[2] && perLod[2].present) chosenReason = perLod[2].reason;

  return { id, ward, parts, xlinks, posLists, lat, lon, lod2: perLod[2], lod3: perLod[3], chosen, chosenReason };
}

export function run() {
  const t0 = Date.now();
  const wards = (rj(RA.wardPolys) || {}).wards || [];
  const sources = collectSources();
  console.log('[reaudit] 建物 CityGML source', sources.length);

  // gml:id 単位で「どの copy にも現れた最良の判定」を残す
  const best = new Map();
  let segments = 0;
  for (let i = 0; i < sources.length; i++) {
    let text;
    try { text = sources[i].read(); } catch { continue; }
    const starts = buildingStarts(text);
    for (let k = 0; k < starts.length; k++) {
      const seg = text.slice(starts[k], k + 1 < starts.length ? starts[k + 1] : text.length);
      segments++;
      const j = judgeBuilding(seg);
      if (!j) continue;
      const cur = best.get(j.id);
      if (!cur || j.chosen > cur.chosen) {
        best.set(j.id, { ward: j.ward, lat: j.lat, lon: j.lon, chosen: j.chosen, reason: j.chosenReason,
          parts: j.parts, xlinks: j.xlinks,
          roof: j.chosen >= 2 ? (j.chosen === 3 ? j.lod3.roof : j.lod2.roof) : 0,
          wall: j.chosen >= 2 ? (j.chosen === 3 ? j.lod3.wall : j.lod2.wall) : 0,
          polys: j.chosen >= 2 ? (j.chosen === 3 ? j.lod3.polygons : j.lod2.polygons) : 0,
          src: sources[i].id,
          l2present: !!(j.lod2 && j.lod2.present), l3present: !!(j.lod3 && j.lod3.present),
          l2complete: !!(j.lod2 && j.lod2.complete), l3complete: !!(j.lod3 && j.lod3.complete) });
      } else if (cur && !cur.lat && j.lat != null) { cur.lat = j.lat; cur.lon = j.lon; }
      else if (cur && !cur.ward && j.ward) cur.ward = j.ward;
    }
    text = null;
    if ((i + 1) % 40 === 0) console.log('  …' + (i + 1) + '/' + sources.length + ' 一意 ' + best.size + ' (' + Math.round((Date.now() - t0) / 1000) + 's)');
  }
  console.log('[reaudit] 一意 gml:id', best.size, '/ セグメント', segments);

  // canonical の PLATEAU id と footprint（§12 の照合用）
  const canonIds = new Set();
  const cells = new Map();          // 25m セル → [{id, ring}]
  const CELL = 25;
  for (const f of fs.readdirSync(RA.canonDir)) {
    if (!/^tile_-?\d+_-?\d+\.json$/.test(f)) continue;
    for (const ft of ((rj(path.join(RA.canonDir, f)) || {}).features || [])) {
      if (!ft.source || ft.source.geometrySource !== 'plateau-building') continue;
      const m = /^cg_bldg_(.+)$/.exec(ft.canonicalId);
      if (m) canonIds.add(m[1]);
      const ring = ft.coordinates && ft.coordinates[0];
      const bb = ft.bbox;
      if (!ring || ring.length < 3 || !bb) continue;
      const rec = { id: ft.canonicalId, ring, centroid: ft.centroid };
      for (let cx = Math.floor(bb.minX / CELL); cx <= Math.floor(bb.maxX / CELL); cx++)
        for (let cz = Math.floor(bb.minZ / CELL); cz <= Math.floor(bb.maxZ / CELL); cz++) {
          const k = cx + ',' + cz;
          let a = cells.get(k); if (!a) cells.set(k, (a = []));
          a.push(rec);
        }
    }
  }
  console.log('[reaudit] canonical PLATEAU', canonIds.size, '/ footprint セル', cells.size);

  // ── 集計 ───────────────────────────────────────────────────────────────
  const byWard = {};
  for (const w of WARDS_24) byWard[w] = { wardJa: WARD_JA[w], canonicalPlateau: 0, lod2Available: 0, lod2Complete: 0,
    lod3Available: 0, lod3Complete: 0, adopted2: 0, adopted3: 0, rejected: 0, notInCanonical: 0 };
  const totals = { unique: best.size, inCanonical: 0, notInCanonical: 0, spatialRecovered: 0,
    l2present: 0, l3present: 0, l2complete: 0, l3complete: 0,
    chosen1: 0, chosen2: 0, chosen3: 0,
    wardFromAttribute: 0, wardFromPolygon: 0, wardUnknown: 0, outsideCity: 0,
    reasons: {}, withPart: 0, withXlink: 0, highLodWithPart: 0 };
  const index = [];
  for (const [id, b] of best) {
    const inCanon = canonIds.has(id);
    // §12/§13 id で一致しないものは位置で照合する（version 違いで id が変わる場合がある）
    let spatial = null;
    if (!inCanon && b.chosen >= 2 && b.lat != null) {
      const w = latLonToLiveCityWorld(b.lat, b.lon);
      spatial = spatialMatch(w.x, w.z, cells, CELL);
      if (spatial) totals.spatialRecovered++;
    }
    if (inCanon) totals.inCanonical++; else totals.notInCanonical++;
    if (b.l2present) totals.l2present++;
    if (b.l3present) totals.l3present++;
    if (b.l2complete) totals.l2complete++;
    if (b.l3complete) totals.l3complete++;
    totals['chosen' + b.chosen]++;
    if (b.parts) totals.withPart++;
    if (b.xlinks) totals.withXlink++;
    if (b.chosen >= 2 && b.parts) totals.highLodWithPart++;
    if (b.reason) totals.reasons[b.reason] = (totals.reasons[b.reason] || 0) + 1;

    // §17 区の割り当て: 属性 → N03 polygon
    let wardId = b.ward ? (JA_TO_ID[b.ward] || null) : null;
    if (wardId) totals.wardFromAttribute++;
    else if (b.lat != null) {
      const w = latLonToLiveCityWorld(b.lat, b.lon);
      const r = classifyPointToWard(w.x, w.z, wards);
      if (r.wardId) { wardId = r.wardId; totals.wardFromPolygon++; }
      else totals.outsideCity++;
    } else totals.wardUnknown++;

    if (wardId && byWard[wardId]) {
      const W = byWard[wardId];
      if (inCanon) W.canonicalPlateau++; else if (b.chosen >= 2) W.notInCanonical++;
      if (b.l2present) W.lod2Available++;
      if (b.l2complete) W.lod2Complete++;
      if (b.l3present) W.lod3Available++;
      if (b.l3complete) W.lod3Complete++;
      if (inCanon && b.chosen === 2) W.adopted2++;
      if (inCanon && b.chosen === 3) W.adopted3++;
      if (inCanon && b.chosen === 1 && (b.l2present || b.l3present)) W.rejected++;
    }
    if (b.chosen >= 2 || b.l2present || b.l3present) {
      index.push({ gmlId: id, wardId, wardAttr: b.ward, inCanonical: inCanon,
        spatialCanonicalId: spatial ? spatial.canonicalId : null, spatialHow: spatial ? spatial.how : null,
        spatialDistanceM: spatial ? spatial.distanceM : null, chosen: b.chosen,
        reason: b.reason, l2: b.l2present, l2c: b.l2complete, l3: b.l3present, l3c: b.l3complete,
        roof: b.roof, wall: b.wall, polys: b.polys, parts: b.parts, xlinks: b.xlinks,
        lat: b.lat, lon: b.lon, src: b.src });
    }
  }

  const out = { version: 1, generatedAt: new Date().toISOString(), missionId: '34D',
    sources: sources.length, segments, canonicalPlateauIds: canonIds.size,
    totals, byWard,
    previous: { lod2: 10208, lod3: 15, total: 10223 },
    elapsedMs: Date.now() - t0 };
  fs.mkdirSync(path.dirname(RA.out), { recursive: true });
  fs.writeFileSync(RA.out, JSON.stringify(out, null, 2));
  fs.writeFileSync(RA.index, JSON.stringify({ version: 1, generatedAt: out.generatedAt, count: index.length, buildings: index }));
  return out;
}

if (isMainModule(import.meta.url)) {
  const o = run();
  console.log('[reaudit] totals', JSON.stringify(o.totals));
  console.log('[reaudit] out', RA.out);
}
