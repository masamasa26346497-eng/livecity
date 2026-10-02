#!/usr/bin/env node
// tools/audit/plateau-missing-audit.js
// [Mission 34C §7] raw PLATEAU（616,119）と canonical V2 PLATEAU（574,112）の差を、
//   「重複コピー」「市域外」「N03 でクリップ」「本当に市内なのに落ちている」へ分けて数える。
//   geometry は作らない。位置は各建物の最初の posList 1 点だけを見る（在庫の分類だけが目的）。
//
//   実行: node --max-old-space-size=8192 tools/audit/plateau-missing-audit.js
//   出力: data/reports/plateau-missing-audit.json
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, isMainModule } from '../lib/paths.js';
import { readZipEntries, extractEntry } from '../lib/zip-reader.js';
import { latLonToLiveCityWorld } from '../lib/livecity-coordinate-system.js';
import { classifyPointToWard } from '../lib/point-in-polygon.js';
import { gmlFiles, buildingStarts, detach } from './plateau-lod-availability.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const F = {
  raw: P('data', 'raw'),
  rawZip: P('data', 'raw', 'osaka-sumiyoshi', 'plateau', 'buildings-lod2', '2024', 'archive', 'CityGML_v4.zip'),
  canonDir: P('data', 'processed', 'osaka-city', 'canonical', 'buildings-v2-osmv2'),
  wardPolys: P('data', 'processed', 'osaka-city', 'boundaries', 'ward-classification-polygons.json'),
  out: P('data', 'reports', 'plateau-missing-audit.json'),
};
const START = '<bldg:Building';
const ID_RE = /gml:id="([^"]+)"/;
const POS_RE = /<gml:posList[^>]*>([^<]{10,20000})</;
const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };

/** canonical に入っている PLATEAU の sourceId（gml:id）と footprint を集める。 */
export function loadCanonicalPlateau() {
  const ids = new Set();
  const cells = new Map();          // 25m セル → [ring]
  const CELL = 25;
  for (const f of fs.readdirSync(F.canonDir)) {
    if (!/^tile_-?\d+_-?\d+\.json$/.test(f)) continue;
    const doc = rj(path.join(F.canonDir, f));
    for (const ft of ((doc && doc.features) || [])) {
      if (!ft.source || ft.source.geometrySource !== 'plateau-building') continue;
      // canonicalId は cg_bldg_<gml:id>。sourceIds があればそちらを優先。
      const sid = (ft.source.sourceIds || [])[0];
      if (sid) ids.add(String(sid).replace(/^bldg\//, ''));
      const m = /^cg_bldg_(.+)$/.exec(ft.canonicalId);
      if (m) ids.add(m[1]);
      const ring = ft.coordinates && ft.coordinates[0];
      const bb = ft.bbox;
      if (!ring || ring.length < 3 || !bb) continue;
      for (let cx = Math.floor(bb.minX / CELL); cx <= Math.floor(bb.maxX / CELL); cx++)
        for (let cz = Math.floor(bb.minZ / CELL); cz <= Math.floor(bb.maxZ / CELL); cz++) {
          const k = cx + ',' + cz;
          let a = cells.get(k); if (!a) cells.set(k, (a = []));
          a.push(ring);
        }
    }
  }
  return { ids, cells, CELL };
}
function pointInRing(x, z, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], zi = ring[i][1], xj = ring[j][0], zj = ring[j][1];
    if (((zi > z) !== (zj > z)) && (x < (xj - xi) * (z - zi) / (zj - zi) + xi)) inside = !inside;
  }
  return inside;
}
/** その点が canonical の建物の中にあるか（＝別 gml:id の同じ建物＝年度違いの再収録の疑い）。 */
export function insideCanonicalFootprint(x, z, cells, CELL) {
  for (const ring of (cells.get(Math.floor(x / CELL) + ',' + Math.floor(z / CELL)) || [])) {
    if (pointInRing(x, z, ring)) return true;
  }
  return false;
}
/** 最寄り canonical 建物までのおおよその距離（周囲 3x3 セル = 75m まで。見つからなければ null）。 */
export function nearestCanonicalM(x, z, cells, CELL) {
  let best = Infinity;
  const cx = Math.floor(x / CELL), cz = Math.floor(z / CELL);
  for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
    for (const ring of (cells.get((cx + i) + ',' + (cz + j)) || [])) {
      for (const q of ring) { const d = Math.hypot(q[0] - x, q[1] - z); if (d < best) best = d; }
    }
  }
  return Number.isFinite(best) ? best : null;
}

/** 1 建物ぶんのテキストから gml:id と最初の座標を取る。 */
export function parseBuilding(seg) {
  const idm = ID_RE.exec(seg);
  if (!idm) return null;
  const id = detach(idm[1]);
  const pm = POS_RE.exec(seg);
  let lat = null, lon = null, ring = null;
  if (pm) {
    const nums = detach(pm[1]).trim().split(/\s+/).map(Number);
    // CityGML(EPSG:6697) は 緯度 経度 標高 の順。最初の posList（= footprint / 底面）を全部読む。
    const pts = [];
    for (let i = 0; i + 2 < nums.length; i += 3) {
      const a = nums[i], b = nums[i + 1];
      if (!(Number.isFinite(a) && Number.isFinite(b) && a > 20 && a < 50 && b > 120 && b < 150)) { pts.length = 0; break; }
      pts.push([a, b]);
    }
    if (pts.length >= 3) {
      if (pts.length >= 2 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]) pts.pop();
      ring = pts;
      // 重心は必ず内側に寄るので、頂点 1 点（輪郭線上）より判定が安定する
      let sa = 0, sb = 0;
      for (const q of pts) { sa += q[0]; sb += q[1]; }
      lat = sa / pts.length; lon = sb / pts.length;
    } else if (nums.length >= 2 && Number.isFinite(nums[0]) && Number.isFinite(nums[1])) { lat = nums[0]; lon = nums[1]; }
  }
  return { id, lat, lon, ringPoints: ring ? ring.length : 0 };
}

export async function run() {
  const t0 = Date.now();
  console.log('[plateau-missing] canonical の PLATEAU id を読み込み…');
  const { ids: canonIds, cells, CELL } = loadCanonicalPlateau();
  console.log('[plateau-missing] canonical PLATEAU', canonIds.size, '/ footprint セル', cells.size);
  const wards = (rj(F.wardPolys) || {}).wards || [];

  const folderFiles = [...gmlFiles(F.raw)];
  const zipEntries = fs.existsSync(F.rawZip)
    ? readZipEntries(F.rawZip).filter((e) => /_bldg_\d+_op\.gml$/i.test(e.name)) : [];
  const sources = [
    ...folderFiles.map((p) => ({ kind: 'folder', name: p, read: () => fs.readFileSync(p, 'utf-8') })),
    ...zipEntries.map((e) => ({ kind: 'zip', name: 'CityGML_v4.zip::' + e.name, read: () => extractEntry(F.rawZip, e).toString('utf-8') })),
  ];
  console.log('[plateau-missing] 走査対象', sources.length, 'ファイル');

  const seen = new Map();          // gml:id → { lat, lon, copies }
  let segments = 0;
  for (let i = 0; i < sources.length; i++) {
    const s = sources[i];
    let text;
    try { text = s.read(); } catch (e) { console.warn('  読めない', s.name, e.message); continue; }
    const starts = buildingStarts(text);
    for (let k = 0; k < starts.length; k++) {
      const seg = text.slice(starts[k], k + 1 < starts.length ? starts[k + 1] : text.length);
      segments++;
      const b = parseBuilding(seg);
      if (!b) continue;
      const cur = seen.get(b.id);
      if (cur) { cur.copies++; if (cur.lat == null && b.lat != null) { cur.lat = b.lat; cur.lon = b.lon; cur.ringPoints = b.ringPoints; } }
      else seen.set(b.id, { lat: b.lat, lon: b.lon, copies: 1, ringPoints: b.ringPoints });
    }
    text = null;
    if ((i + 1) % 40 === 0) console.log('  …' + (i + 1) + '/' + sources.length + ' 一意 ' + seen.size + ' (' + Math.round((Date.now() - t0) / 1000) + 's)');
  }

  const counts = { rawSegments: segments, rawUniqueIds: seen.size, duplicatedAcrossCopies: segments - seen.size,
    inCanonical: 0, notInCanonical: 0, noPosition: 0, outsideCity: 0, reEditionOfExisting: 0, insideCityMissing: 0 };
  const byWardMissing = {};
  const nearestBuckets = { '<1m': 0, '1-3m': 0, '3-10m': 0, '10-25m': 0, '25-75m': 0, '>75m(=周辺に建物なし)': 0 };
  const sample = [];
  for (const [id, v] of seen) {
    if (canonIds.has(id)) { counts.inCanonical++; continue; }
    counts.notInCanonical++;
    if (v.lat == null) { counts.noPosition++; continue; }
    const w = latLonToLiveCityWorld(v.lat, v.lon);
    const wr = classifyPointToWard(w.x, w.z, wards);
    if (!wr.wardId) { counts.outsideCity++; continue; }
    // 年度違いの再収録か（同じ場所に canonical の建物が既にある）
    if (insideCanonicalFootprint(w.x, w.z, cells, CELL)) { counts.reEditionOfExisting++; continue; }
    counts.insideCityMissing++;
    byWardMissing[wr.wardId] = (byWardMissing[wr.wardId] || 0) + 1;
    // 既存の表示建物からどれだけ離れているか（近い＝同じ建物の別 id の疑い / 遠い＝本当に出ていない）
    const nd = nearestCanonicalM(w.x, w.z, cells, CELL);
    if (nd == null) nearestBuckets['>75m(=周辺に建物なし)']++;
    else if (nd < 1) nearestBuckets['<1m']++;
    else if (nd < 3) nearestBuckets['1-3m']++;
    else if (nd < 10) nearestBuckets['3-10m']++;
    else if (nd < 25) nearestBuckets['10-25m']++;
    else nearestBuckets['25-75m']++;
    if (sample.length < 20) sample.push({ gmlId: id, lat: v.lat, lon: v.lon, wardId: wr.wardId, copies: v.copies, ringPoints: v.ringPoints,
      world: { x: Math.round(w.x), z: Math.round(w.z) } });
  }

  const out = { version: 1, generatedAt: new Date().toISOString(), missionId: '34C',
    sources: { folderFiles: folderFiles.length, zipEntries: zipEntries.length },
    canonicalPlateauIds: canonIds.size, counts, byWardMissing, nearestCanonicalBuckets: nearestBuckets, sample, elapsedMs: Date.now() - t0 };
  fs.mkdirSync(path.dirname(F.out), { recursive: true });
  fs.writeFileSync(F.out, JSON.stringify(out, null, 2));
  return out;
}

if (isMainModule(import.meta.url)) {
  run().then((o) => { console.log('[plateau-missing]', JSON.stringify(o.counts)); console.log('区別', JSON.stringify(o.byWardMissing)); console.log('最寄り距離', JSON.stringify(o.nearestCanonicalBuckets)); console.log('out', F.out); process.exit(0); })
    .catch((e) => { console.error(e); process.exit(1); });
}
