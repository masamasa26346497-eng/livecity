#!/usr/bin/env node
// tools/audit/building-canonical-v2-corrected.js
// [Mission 32N §8-§12 / §17-§25] Corrected Building Canonical V2 の評価。
//
//   truth は「生 CityGML の lat/lon と区名」「OSM 建物」「GSI 建物」「N03」だけ。
//   V1/V2 canonical から逆算した lat/lon は使わない（FIX11 の循環を繰り返さない）。
//   §8 の独立性: 生 lat/lon → 期待座標の計算は、ビルダーが使った livecity-coordinate-system.js ではなく、
//   config の値からこのファイル内で**別に**計算する（同じ関数で作って同じ関数で確かめる自己一致を避ける）。
//   過去の KPI（32I の Building∩DarkRoad 等）は流用せず、V1/V2 の両方をこの場で測り直す（§18）。
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { resolveProjectPath, toProjectRelativePath, isMainModule } from '../lib/paths.js';
import { readZipEntries, extractEntry } from '../lib/zip-reader.js';
import { pbfPrimitiveStream } from '../lib/osm-pbf-stream.js';
import { readFileRetry } from '../lib/synced-dir-writer.js';

const require_ = createRequire(import.meta.url);
const P = (...s) => resolveProjectPath(path.join(...s));
const F = {
  v1: P('data', 'processed', 'osaka-city', 'canonical', 'buildings'),
  v2: P('data', 'processed', 'osaka-city', 'canonical', 'buildings-v2-corrected'),
  v1NearPub: P('public', 'map-data', 'osaka-city', 'derived', 'near', 'buildings'),
  v2Derived: P('data', 'processed', 'osaka-city', 'derived-v2-corrected'),
  v1Derived: P('data', 'processed', 'osaka-city', 'derived'),
  v2Pub: P('public', 'map-data', 'osaka-city', 'derived-v2-corrected'),
  rawDir: P('data', 'raw', 'osaka-higashisumiyoshi'),
  rawZip: P('data', 'raw', 'osaka-sumiyoshi', 'plateau', 'buildings-lod2', '2024', 'archive', 'CityGML_v4.zip'),
  area: P('config', 'areas', 'osaka-city.json'),
  registry: P('config', 'wards', 'registry.json'),
  wardPolys: P('data', 'processed', 'osaka-city', 'boundaries', 'ward-classification-polygons.json'),
  canonRoads: P('data', 'processed', 'osaka-city', 'canonical', 'roads'),
  canonWater: P('data', 'processed', 'osaka-city', 'canonical', 'water'),
  refined: P('data', 'processed', 'osaka-city', 'derived', 'refined-road-surface.json'),
  roadV2: P('data', 'processed', 'osaka-city', 'derived', 'road-visual-v2', 'tiles'),
  roadV3: P('data', 'processed', 'osaka-city', 'derived', 'road-visual-v3', 'tiles'),
  gsiBldA: P('data', 'processed', 'osaka-city', 'gsi-building-area', 'building-area-polygons.json'),
  landBlocks: P('data', 'processed', 'osaka-city', 'visual-land-block-poc', 'umeda', 'blocks.json'),
  osmPbf: P('data', 'raw', 'osm', 'osaka-latest.osm.pbf'),
  buildReport: P('data', 'reports', 'canonical-building-v2-build.json'),
  placementV1: P('data', 'reports', 'building-placement-policy.json'),
  placementV2: P('data', 'reports', 'building-placement-policy-v2-corrected.json'),
  harness: P('tests', '_ward-ux-v1-smoke-harness.cjs'),
  html: P('public', 'osaka_3d_buildings.ward-ux-v1.html'),
  report: P('data', 'reports', 'building-canonical-v2-corrected.json'),
};
const rj = (p) => { try { return JSON.parse(readFileRetry(p)); } catch { return null; } };
const isTile = (f) => /^tile_-?\d+_-?\d+\.json$/.test(f);
const median = (v) => { if (!v.length) return null; const s = [...v].sort((a, b) => a - b); const m = s.length >> 1; return +(s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2).toFixed(6); };
const pct = (v, q) => { if (!v.length) return null; const s = [...v].sort((a, b) => a - b); return +s[Math.min(s.length - 1, Math.floor(s.length * q))].toFixed(6); };
const cen = (r) => [r.reduce((a, p) => a + p[0], 0) / r.length, r.reduce((a, p) => a + p[1], 0) / r.length];
const pir = (x, z, r) => { let ins = false; for (let i = 0, j = r.length - 1; i < r.length; j = i++) { const xi = r[i][0], zi = r[i][1], xj = r[j][0], zj = r[j][1]; if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) ins = !ins; } return ins; };
const outerOf = (f) => (f.geometryType === 'Polygon' ? f.coordinates[0] : f.coordinates[0] && f.coordinates[0][0]);

// §8: ビルダーとは独立に書いた期待座標（config の数値だけを使う）
const PROJ = rj(F.area).projection;
const K_X = Math.cos((PROJ.centerLat * Math.PI) / 180) * PROJ.metersPerDegree;
const expectXZ = (lat, lon) => [Math.round((lon - PROJ.centerLon) * K_X * 100) / 100, Math.round(-(lat - PROJ.centerLat) * PROJ.metersPerDegree * 100) / 100];

function similarity(pairs) {
  const n = pairs.length; if (n < 3) return null;
  let msx = 0, msz = 0, mtx = 0, mtz = 0;
  for (const p of pairs) { msx += p[0]; msz += p[1]; mtx += p[2]; mtz += p[3]; }
  msx /= n; msz /= n; mtx /= n; mtz /= n;
  let a = 0, b = 0, ss = 0;
  for (const p of pairs) { const x = p[0] - msx, z = p[1] - msz, u = p[2] - mtx, v = p[3] - mtz; a += x * u + z * v; b += x * v - z * u; ss += x * x + z * z; }
  const s = Math.hypot(a, b) / ss, th = Math.atan2(b, a), c = Math.cos(th), sn = Math.sin(th);
  const tx = mtx - s * (c * msx - sn * msz), tz = mtz - s * (sn * msx + c * msz);
  const res = pairs.map((p) => Math.hypot(s * (c * p[0] - sn * p[1]) + tx - p[2], s * (sn * p[0] + c * p[1]) + tz - p[3]));
  return { scale: +s.toFixed(7), rotationDeg: +((th * 180) / Math.PI).toFixed(6), tx: +tx.toFixed(4), tz: +tz.toFixed(4), residualMedianM: median(res), residualP95M: pct(res, 0.95), n };
}

// ── canonical の索引 ──
// 全件を object のまま 2 版持つとメモリが足りないので、ID → {外周, 重心} だけの軽量索引にする。
function loadCanon(dir) {
  const out = new Map();
  for (const f of fs.readdirSync(dir)) {
    if (!isTile(f)) continue;
    const t = rj(path.join(dir, f)); if (!t) continue;
    for (const ft of t.features || []) {
      if (out.has(ft.canonicalId)) continue;
      const r = outerOf(ft);
      out.set(ft.canonicalId, { id: ft.canonicalId, ring: r, coordinates: ft.coordinates, centroid: ft.centroid, plateau: !!(ft.source && ft.source.geometrySource === 'plateau-building') });
    }
  }
  return out;
}
// サイト計測用: bbox に掛かる tile だけ読む（canonical buildings は 500m tile）
function canonInBox(dir, b) {
  const out = []; const seen = new Set();
  for (let tx = Math.floor(b.minX / 500) - 1; tx <= Math.floor(b.maxX / 500) + 1; tx++) for (let tz = Math.floor(b.minZ / 500) - 1; tz <= Math.floor(b.maxZ / 500) + 1; tz++) {
    const t = rj(path.join(dir, `tile_${tx}_${tz}.json`)); if (!t) continue;
    for (const ft of t.features || []) {
      if (seen.has(ft.canonicalId) || !ft.bbox) continue;
      if (ft.bbox.maxX < b.minX || ft.bbox.minX > b.maxX || ft.bbox.maxZ < b.minZ || ft.bbox.minZ > b.maxZ) continue;
      seen.add(ft.canonicalId); out.push(ft);
    }
  }
  return out;
}
function loadAttrs(dir) {
  const out = new Map();
  for (const f of fs.readdirSync(dir)) { if (!isTile(f)) continue; const a = (rj(path.join(dir, f)) || {}).attributes || {}; for (const [k, v] of Object.entries(a)) if (!out.has(k)) out.set(k, v); }
  return out;
}

// ── 生 CityGML の走査（フォルダ + zip の不足メッシュ） ──
function* rawSources(everyNth = 1) {
  const files = fs.readdirSync(F.rawDir).filter((f) => /_bldg_\d+_op\.gml$/.test(f)).sort();
  const have = new Set(files.map((f) => f.slice(0, 8)));
  let i = 0;
  for (const f of files) { if (i++ % everyNth === 0) yield { kind: 'folder', text: () => readFileRetry(path.join(F.rawDir, f)) }; }
  if (fs.existsSync(F.rawZip)) for (const e of readZipEntries(F.rawZip)) {
    if (!/bldg\/\d{8}_bldg_\d+_op\.gml$/.test(e.name)) continue;
    if (have.has(e.name.split('/').pop().slice(0, 8))) continue;
    if (i++ % everyNth === 0) yield { kind: 'zip', text: () => extractEntry(F.rawZip, e).toString('utf-8') };
  }
}
function candidateRings(part) {
  const out = [];
  for (const secRe of [/<bldg:lod0FootPrint>[\s\S]*?<\/bldg:lod0FootPrint>/, /<bldg:GroundSurface\b[\s\S]*?<\/bldg:GroundSurface>/]) {
    const sec = part.match(secRe); if (!sec) continue;
    const re = /<gml:exterior>[\s\S]*?<gml:posList[^>]*>([\s\S]*?)<\/gml:posList>/g; let m;
    while ((m = re.exec(sec[0]))) {
      const n = m[1].trim().split(/\s+/).map(Number); const ll = [];
      for (let i = 0; i + 2 < n.length; i += 3) ll.push([n[i], n[i + 1]]);
      out.push(ll);
    }
    if (out.length) break;
  }
  return out;
}

// OSM fallback（41,505 棟）は Mission 21B で「V1 PLATEAU（第7系で回転した位置）が無い所」として選ばれた。
// PLATEAU が正しい位置へ移った V2 では、fallback が PLATEAU と重なる（二重建物）可能性があるので、
// fallback 作成時と同じ基準（centroid-in-polygon / bbox IoU>=0.3）で V1・V2 の両方に対して数える。
function measureFallbackDuplicates(v1, v2, v2Attr) {
  const CELL = 50;
  const bbOf = (r) => { let a = Infinity, b = -Infinity, c = Infinity, d = -Infinity; for (const p of r) { a = Math.min(a, p[0]); b = Math.max(b, p[0]); c = Math.min(c, p[1]); d = Math.max(d, p[1]); } return { minX: a, maxX: b, minZ: c, maxZ: d }; };
  const iou = (p, q) => { const w = Math.min(p.maxX, q.maxX) - Math.max(p.minX, q.minX), h = Math.min(p.maxZ, q.maxZ) - Math.max(p.minZ, q.minZ); if (w <= 0 || h <= 0) return 0; const i = w * h; return i / ((p.maxX - p.minX) * (p.maxZ - p.minZ) + (q.maxX - q.minX) * (q.maxZ - q.minZ) - i); };
  function count(map, withWard) {
    const byWard = {};
    const grid = new Map();
    for (const f of map.values()) {
      if (!f.plateau || !f.ring) continue;
      const bb = bbOf(f.ring); const e = { ring: f.ring, bb };
      for (let i = Math.floor(bb.minX / CELL); i <= Math.floor(bb.maxX / CELL); i++) for (let j = Math.floor(bb.minZ / CELL); j <= Math.floor(bb.maxZ / CELL); j++) {
        const k = i + '_' + j; let a = grid.get(k); if (!a) grid.set(k, a = []); a.push(e);
      }
    }
    let fallback = 0, dupCentroid = 0, dupIou = 0, dupAny = 0;
    const areaOf = (r) => { let s2 = 0; for (let i = 0, j = r.length - 1; i < r.length; j = i++) s2 += (r[j][0] + r[i][0]) * (r[j][1] - r[i][1]); return Math.abs(s2) / 2; };
    let dupAreaM2 = 0;
    for (const f of map.values()) {
      if (f.plateau || !f.ring) continue;
      fallback++;
      const c = cen(f.ring), bb = bbOf(f.ring);
      const cands = new Set();
      for (let i = Math.floor(bb.minX / CELL); i <= Math.floor(bb.maxX / CELL); i++) for (let j = Math.floor(bb.minZ / CELL); j <= Math.floor(bb.maxZ / CELL); j++) for (const e of grid.get(i + '_' + j) || []) cands.add(e);
      let byC = false, byI = false;
      for (const e of cands) {
        if (!byC && c[0] >= e.bb.minX && c[0] <= e.bb.maxX && c[1] >= e.bb.minZ && c[1] <= e.bb.maxZ && pir(c[0], c[1], e.ring)) byC = true;
        if (!byI && iou(bb, e.bb) >= 0.3) byI = true;
        if (byC && byI) break;
      }
      if (byC) dupCentroid++; if (byI) dupIou++; if (byC || byI) {
        dupAny++; dupAreaM2 += areaOf(f.ring);
        if (withWard) { const w = (v2Attr.get(f.id) || {}).wardId || 'outside'; byWard[w] = (byWard[w] || 0) + 1; }
      }
    }
    const out = { fallback, duplicateByCentroidInPlateau: dupCentroid, duplicateByBboxIou03: dupIou, duplicateAny: dupAny, duplicateAnyAreaM2: Math.round(dupAreaM2) };
    if (withWard) out.duplicateByWard = Object.fromEntries(Object.entries(byWard).sort((a, b) => b[1] - a[1]));
    return out;
  }
  return {
    criterion: 'fallback の centroid が PLATEAU footprint 内 / bbox IoU>=0.3（Mission 21B の duplicate 判定と同じ）',
    againstV1Plateau: count(v1, false), againstV2Plateau: count(v2, true),
    fallbackCoordinates: 'build-osm-building-fallback.js の toXZ は equirect（config と同式）。V1/V2 で fallback 座標は同一（V2 は複製のみ）。',
    note: 'V2 で増えた duplicate は「PLATEAU が正しい位置へ移ったことで、以前は PLATEAU 欠落に見えた場所に PLATEAU が来た」もの。本 mission では件数 615,617 を保つため除外していない（別 mission で fallback を V2 基準で再選定する候補）。',
  };
}

async function main() {
  const generatedAt = new Date().toISOString();
  const build = rj(F.buildReport);
  const registry = JSON.parse(fs.readFileSync(F.registry, 'utf-8').replace(/^﻿/, ''));
  const wardIdByName = new Map((registry.wards || registry).map((w) => [w.name, w.id]));

  console.log('[eval] loading canonicals…');
  const v1 = loadCanon(F.v1);
  const v2 = loadCanon(F.v2);
  const v2Attr = loadAttrs(path.join(F.v2, 'attributes'));
  const count = { v1: v1.size, v2: v2.size };
  if (process.argv.includes('--fallback-only')) {
    const prev = rj(F.report);
    prev.fallbackDuplicates = measureFallbackDuplicates(v1, v2, loadAttrs(path.join(F.v2, 'attributes')));
    fs.writeFileSync(F.report, JSON.stringify(prev, null, 2));
    return prev;
  }
  let idPreserved = v1.size === v2.size;
  for (const id of v1.keys()) if (!v2.has(id)) { idPreserved = false; break; }

  // ── §8 raw truth（全ソースを走査、PLATEAU 全件を照合） ──
  console.log('[eval] raw truth…');
  const rawTruth = { checked: 0, exactMatch: 0, maxVertexErrorM: [], unmatched: 0, bySource: { folder: 0, zip: 0 } };
  const centroidPairs = { v1: [], v2: [] };
  const wardQA = { n: 0, oldCorrect: 0, newCorrect: 0, rawNameUnknown: 0 };
  const umedaWard = { n: 0, oldCorrect: 0, newCorrect: 0 };
  const seen = new Set();
  let srcIdx = 0;
  for (const src of rawSources(1)) {
    const text = src.text();
    srcIdx++;
    let idx = text.indexOf('<core:cityObjectMember>');
    while (idx >= 0) {
      const next = text.indexOf('<core:cityObjectMember>', idx + 23);
      const part = text.slice(idx, next < 0 ? text.length : next);
      idx = next;
      const m = part.match(/<bldg:Building gml:id="([^"]+)"/); if (!m) continue;
      const cid = 'cg_bldg_' + m[1];
      const b2 = v2.get(cid); if (!b2 || seen.has(cid)) continue;
      seen.add(cid);
      const ring2 = b2.ring;
      const cands = candidateRings(part);
      // V2 の外周が、生のどれか 1 本のリングを期待座標にしたものと一致するか
      let best = Infinity, bestLL = null;
      for (const ll of cands) {
        const exp = ll.map(([la, lo]) => expectXZ(la, lo));
        const e = (exp.length >= 2 && exp[0][0] === exp[exp.length - 1][0] && exp[0][1] === exp[exp.length - 1][1]) ? exp.slice(0, -1) : exp;
        if (e.length !== ring2.length) continue;
        let mx = 0; for (let i = 0; i < e.length; i++) mx = Math.max(mx, Math.hypot(e[i][0] - ring2[i][0], e[i][1] - ring2[i][1]));
        if (mx < best) { best = mx; bestLL = ll; }
      }
      rawTruth.checked++; rawTruth.bySource[src.kind]++;
      if (!bestLL) { rawTruth.unmatched++; continue; }
      rawTruth.maxVertexErrorM.push(best);
      if (best <= 0.005) rawTruth.exactMatch++;
      // §9 rotation: 生の重心（期待座標）→ 各版の重心
      if (rawTruth.checked % 7 === 0) {
        const n = ring2.length;
        const e = cen(bestLL.slice(0, n).map(([la, lo]) => expectXZ(la, lo)));
        const c2 = cen(ring2);
        centroidPairs.v2.push([e[0], e[1], c2[0], c2[1]]);
        const b1 = v1.get(cid); if (b1) { const c1 = cen(b1.ring); centroidPairs.v1.push([e[0], e[1], c1[0], c1[1]]); }
      }
      // §12 区の正誤（truth = 生 CityGML の区名）
      const a = v2Attr.get(cid) || {};
      const truthName = a.rawWardName;
      const truth = truthName ? wardIdByName.get(truthName) : null;
      if (!truth) { wardQA.rawNameUnknown++; }
      else {
        wardQA.n++;
        if (a.wardIdV1 === truth) wardQA.oldCorrect++;
        if (a.wardId === truth) wardQA.newCorrect++;
        if (truth === 'kita') { umedaWard.n++; if (a.wardIdV1 === truth) umedaWard.oldCorrect++; if (a.wardId === truth) umedaWard.newCorrect++; }
      }
    }
    if (srcIdx % 40 === 0) console.log('[eval] raw sources', srcIdx, 'checked', rawTruth.checked);
  }
  const errs = rawTruth.maxVertexErrorM;
  const rawTruthError = {
    plateauChecked: rawTruth.checked, bySource: rawTruth.bySource,
    matched: errs.length, unmatched: rawTruth.unmatched,
    exactWithin5mm: rawTruth.exactMatch,
    medianM: median(errs), p95M: pct(errs, 0.95), maxM: errs.length ? +errs.reduce((a, b) => (b > a ? b : a), 0).toFixed(6) : null,
    method: '生 CityGML の lod0FootPrint(無ければ GroundSurface) の外周候補を、ビルダーとは別に書いた式で期待座標へ変換し、'
      + 'V2 の外周と頂点ごとに比べた最大誤差。丸めは V1/V2 と同じ 0.01m。',
  };
  const coordinate = {
    rotationBefore: similarity(centroidPairs.v1),
    rotationAfter: similarity(centroidPairs.v2),
  };
  coordinate.scaleBefore = coordinate.rotationBefore ? coordinate.rotationBefore.scale : null;
  coordinate.scaleAfter = coordinate.rotationAfter ? coordinate.rotationAfter.scale : null;
  const ward = {
    truth: '生 CityGML の gen 属性「区名」',
    samples: wardQA.n, rawNameUnknown: wardQA.rawNameUnknown,
    oldAccuracy: wardQA.n ? +(wardQA.oldCorrect / wardQA.n).toFixed(5) : null,
    correctedAccuracy: wardQA.n ? +(wardQA.newCorrect / wardQA.n).toFixed(5) : null,
    kita: { samples: umedaWard.n, oldAccuracy: umedaWard.n ? +(umedaWard.oldCorrect / umedaWard.n).toFixed(5) : null, correctedAccuracy: umedaWard.n ? +(umedaWard.newCorrect / umedaWard.n).toFixed(5) : null },
    reassignedFromCorrectedCoordinates: true,
    build: build ? build.ward : null,
  };

  // ── サイト（§10/§17/§18/§19/§20） ──
  const wp = rj(F.wardPolys);
  const hy = wp.wards.find((w) => w.wardId === 'higashiyodogawa');
  const SITES = [
    { id: 'umeda', x: -2668.18, z: -10941.87 },
    { id: 'nakanoshima', x: -2695.66, z: -9962.25 },
    { id: 'honmachi', x: -2072.6, z: -8693.2 },
    { id: 'namba', x: -2173.39, z: -6511.33 },
    { id: 'tennoji', x: -1055.54, z: -4618.89 },
    { id: 'sumiyoshi', x: -2952.22, z: -811.75 },
    { id: 'higashiyodogawa', x: Math.round((hy.bbox.minX + hy.bbox.maxX) / 2), z: Math.round((hy.bbox.minZ + hy.bbox.maxZ) / 2) },
  ];
  const R = 500;
  const boxOf = (s) => ({ minX: s.x - R, maxX: s.x + R, minZ: s.z - R, maxZ: s.z + R });
  const inBox = (bb, b) => bb.maxX >= b.minX && bb.minX <= b.maxX && bb.maxZ >= b.minZ && bb.minZ <= b.maxZ;
  // raster
  function newRaster(b) { const nx = b.maxX - b.minX, nz = b.maxZ - b.minZ; return { b, nx, nz, m: new Uint8Array(nx * nz) }; }
  function fill(r, ring, val = 1) {
    let a = Infinity, c = -Infinity, d = Infinity, e = -Infinity;
    for (const p of ring) { a = Math.min(a, p[0]); c = Math.max(c, p[0]); d = Math.min(d, p[1]); e = Math.max(e, p[1]); }
    const i0 = Math.max(0, Math.floor(a - r.b.minX)), i1 = Math.min(r.nx - 1, Math.floor(c - r.b.minX));
    const j0 = Math.max(0, Math.floor(d - r.b.minZ)), j1 = Math.min(r.nz - 1, Math.floor(e - r.b.minZ));
    for (let i = i0; i <= i1; i++) { const x = r.b.minX + i + 0.5; for (let j = j0; j <= j1; j++) if (pir(x, r.b.minZ + j + 0.5, ring)) r.m[j * r.nx + i] = val; }
  }
  function coverage(r, ring) {
    let a = Infinity, c = -Infinity, d = Infinity, e = -Infinity;
    for (const p of ring) { a = Math.min(a, p[0]); c = Math.max(c, p[0]); d = Math.min(d, p[1]); e = Math.max(e, p[1]); }
    let tot = 0, hit = 0;
    for (let i = Math.max(0, Math.floor(a - r.b.minX)); i <= Math.min(r.nx - 1, Math.floor(c - r.b.minX)); i++) {
      const x = r.b.minX + i + 0.5;
      for (let j = Math.max(0, Math.floor(d - r.b.minZ)); j <= Math.min(r.nz - 1, Math.floor(e - r.b.minZ)); j++) {
        if (!pir(x, r.b.minZ + j + 0.5, ring)) continue; tot++; if (r.m[j * r.nx + i]) hit++;
      }
    }
    return tot ? hit / tot : null;
  }
  const and = (r1, r2) => { let n = 0; for (let i = 0; i < r1.m.length; i++) if (r1.m[i] && r2.m[i]) n++; return n; };
  const ones = (r) => { let n = 0; for (let i = 0; i < r.m.length; i++) if (r.m[i]) n++; return n; };

  // OSM（全サイトまとめて 1 パス）
  console.log('[eval] OSM…');
  const latOf = (z) => PROJ.centerLat - z / PROJ.metersPerDegree, lonOf = (x) => PROJ.centerLon + x / K_X;
  const boxes = SITES.map(boxOf);
  const ll = boxes.map((b) => ({ s: latOf(b.maxZ + 200), n: latOf(b.minZ - 200), w: lonOf(b.minX - 200), e: lonOf(b.maxX + 200) }));
  const nodes = new Map(); const osmRings = [];
  for await (const p of pbfPrimitiveStream(F.osmPbf)) {
    if (p.type === 'node') { for (const q of ll) if (p.lat >= q.s && p.lat <= q.n && p.lon >= q.w && p.lon <= q.e) { const xz = expectXZ(p.lat, p.lon); nodes.set(p.id, xz); break; } }
    else if (p.type === 'way') {
      const t = p.tags || {}; if (!(t.building || t['building:part'])) continue;
      const pts = []; let ok = true; for (const r of p.refs || []) { const c = nodes.get(r); if (!c) { ok = false; break; } pts.push(c); }
      if (ok && pts.length >= 4) osmRings.push(pts);
    }
  }
  // road dark sources
  const refined = rj(F.refined) || {};
  const nonPrimary = new Set(Object.keys(refined.classMap || {}).map((k) => (refined.keyPrefix || '') + k));
  const rings = (f) => { const polys = f.geometryType === 'Polygon' ? [f.coordinates] : (f.geometryType === 'MultiPolygon' ? f.coordinates : []); return polys; };
  function tilesFor(dir, b, size) {
    const out = [];
    for (let tx = Math.floor(b.minX / size); tx <= Math.floor(b.maxX / size); tx++) for (let tz = Math.floor(b.minZ / size); tz <= Math.floor(b.maxZ / size); tz++) { const t = rj(path.join(dir, `tile_${tx}_${tz}.json`)); if (t) out.push(t); }
    return out;
  }
  const gsiAll = rj(F.gsiBldA); const gsiFeats = (gsiAll && (gsiAll.features || gsiAll.polygons)) || [];
  const lb = rj(F.landBlocks);

  const sites = {};
  for (const s of SITES) {
    console.log('[eval] site', s.id);
    const b = boxOf(s);
    const bl = { v1: [], v2: [] };
    bl.v1 = canonInBox(F.v1, b); bl.v2 = canonInBox(F.v2, b);
    const rOsm = newRaster(b); for (const r of osmRings) fill(rOsm, r);
    const rB = { v1: newRaster(b), v2: newRaster(b) };
    for (const ver of ['v1', 'v2']) for (const f of bl[ver]) for (const poly of rings(f)) fill(rB[ver], poly[0]);
    // dark roads
    const rFix13 = newRaster(b), rV2 = newRaster(b), rV3 = newRaster(b);
    const seenR = new Set();
    for (const t of tilesFor(F.canonRoads, b, 2000)) for (const f of t.features || []) {
      if (seenR.has(f.canonicalId) || nonPrimary.has(f.canonicalId) || !f.bbox || !inBox(f.bbox, b)) continue; seenR.add(f.canonicalId);
      for (const poly of rings(f)) fill(rFix13, poly[0]);
    }
    for (const t of tilesFor(F.roadV2, b, 2000)) for (const f of t.features || []) if (Array.isArray(f.carriageway)) for (const q of f.carriageway) fill(rV2, q);
    for (const t of tilesFor(F.roadV3, b, 2000)) for (const f of t.features || []) if (Array.isArray(f.carriageway)) for (const q of f.carriageway) fill(rV3, q);
    // water（穴は抜く）
    const rW = newRaster(b);
    for (const t of tilesFor(F.canonWater, b, 2000)) for (const f of t.features || []) for (const poly of rings(f)) { fill(rW, poly[0], 1); for (let h = 1; h < poly.length; h++) fill(rW, poly[h], 0); }
    // GSI 建物
    const rG = newRaster(b);
    for (const g of gsiFeats) { const c = g.coordinates; const ring = Array.isArray(c[0][0]) ? c[0] : c; if (!ring || ring.length < 3) continue; const x = ring[0][0], z = ring[0][1]; if (x < b.minX - 100 || x > b.maxX + 100 || z < b.minZ - 100 || z > b.maxZ + 100) continue; fill(rG, ring); }
    // 建物単位の OSM / GSI 被覆（PLATEAU・同じ ID で比較、中心 350m 以内）
    const ids = [...bl.v2].filter((f) => f.source && f.source.geometrySource === 'plateau-building' && f.centroid && Math.hypot(f.centroid[0] - s.x, f.centroid[1] - s.z) <= 350).map((f) => f.canonicalId);
    const perB = { v1: { osm: [], gsi: [] }, v2: { osm: [], gsi: [] } };
    for (const id of ids.slice(0, 600)) {
      for (const [ver, map] of [['v1', v1], ['v2', v2]]) {
        const f = map.get(id); if (!f) continue; const ring = f.ring;
        const o = coverage(rOsm, ring), g = coverage(rG, ring);
        if (o != null) perB[ver].osm.push(o); if (g != null) perB[ver].gsi.push(g);
      }
    }
    const bc = { v1: ones(rB.v1), v2: ones(rB.v2) };
    sites[s.id] = {
      center: [s.x, s.z], radiusM: R, buildingsSampled: Math.min(ids.length, 600),
      osmOverlap: { v1: median(perB.v1.osm), v2: median(perB.v2.osm) },
      gsiBuildingAlignment: { v1: median(perB.v1.gsi), v2: median(perB.v2.gsi) },
      buildingAreaM2: bc,
      roadOverlapM2: {
        v1: { fix13: and(rB.v1, rFix13), roadV2: and(rB.v1, rV2), roadV3: and(rB.v1, rV3) },
        v2: { fix13: and(rB.v2, rFix13), roadV2: and(rB.v2, rV2), roadV3: and(rB.v2, rV3) },
      },
      waterOverlapM2: { v1: and(rB.v1, rW), v2: and(rB.v2, rW) },
    };
    if (s.id === 'umeda' && lb && Array.isArray(lb.blocks)) {
      const rL = newRaster(b);
      for (const blk of lb.blocks) { const g = blk.geometry; const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates; for (const poly of polys) fill(rL, poly[0]); }
      sites[s.id].landBlockContainment = { v1: +(and(rB.v1, rL) / bc.v1).toFixed(4), v2: +(and(rB.v2, rL) / bc.v2).toFixed(4), note: '建物面積のうち ROAD-ENCLOSED BLOCK の内側にある割合（梅田 PoC 範囲）' };
    }
  }
  const sumSites = (ver, key) => Object.values(sites).reduce((a, s) => a + s.roadOverlapM2[ver][key], 0);
  const roadOverlap = {
    fix13: { v1: sumSites('v1', 'fix13'), v2: sumSites('v2', 'fix13') },
    V2: { v1: sumSites('v1', 'roadV2'), v2: sumSites('v2', 'roadV2') },
    V3: { v1: sumSites('v1', 'roadV3'), v2: sumSites('v2', 'roadV3') },
    note: '7 サイト（各 1km 四方）合計の Building∩DarkRoad（m²）。32I の値は V1 建物で測ったものなので流用しない。',
  };
  const waterOverlap = {
    sitesTotalM2: { v1: Object.values(sites).reduce((a, s) => a + s.waterOverlapM2.v1, 0), v2: Object.values(sites).reduce((a, s) => a + s.waterOverlapM2.v2, 0) },
    nakanoshimaOkawaM2: sites.nakanoshima.waterOverlapM2,
  };

  // ── §22 placement ──
  const pv1 = rj(F.placementV1), pv2 = rj(F.placementV2);
  const pc = (r) => (r ? (r.counts || r.policyCounts || null) : null);
  const placement = { v1: pc(pv1), v2: pc(pv2), v2Uses31eIndex: false };

  // ── §23 runtime / §24 performance ──
  let runtime = null;
  try {
    const { runInlineScript } = require_(F.harness);
    const boot = runInlineScript(F.html, { fetchRoot: P('public') });
    if (boot.ok) {
      const w = boot.window;
      const before = w.__BUILDINGS_VERSION_DEBUG__();
      const sw = await w.__SET_BUILDINGS_VERSION__('V2');
      const d2 = w.__BUILDINGS_VERSION_DEBUG__();
      const res2 = w.__CANONICAL_SELF_CHECK__().total;
      await w.__SET_BUILDINGS_VERSION__('V1');
      const d1 = w.__BUILDINGS_VERSION_DEBUG__();
      runtime = { defaultVersion: before.version, switched: sw, v2Debug: d2, residualInV2: res2, backToV1: d1.version, residualAfter: w.__CANONICAL_SELF_CHECK__().total };
    }
  } catch (e) { runtime = { error: String(e && e.message || e) }; }
  // near(exact) の頂点が canonical V2 とそのまま一致するか
  const nearCheck = (() => {
    const dir = path.join(F.v2Derived, 'near', 'buildings');
    let n = 0, same = 0;
    for (const f of fs.readdirSync(dir).filter(isTile).slice(0, 60)) {
      for (const d of (rj(path.join(dir, f)) || {}).features || []) {
        const c = v2.get(d.canonicalId); if (!c) continue; n++;
        if (JSON.stringify(d.coordinates) === JSON.stringify(c.coordinates)) same++;
      }
    }
    return { checked: n, identical: same };
  })();
  const perfOf = (root) => {
    const out = {};
    for (const lod of ['far', 'mid', 'near']) {
      const m = rj(path.join(root, lod, 'buildings', 'manifest.json')); if (!m) continue;
      let bytes = 0; for (const t of m.tiles || []) { try { bytes += fs.statSync(path.join(root, lod, 'buildings', t.file)).size; } catch { /* noop */ } }
      out[lod] = { features: m.featureCount, vertices: m.vertexCount, tiles: (m.tiles || []).length, bytes };
    }
    return out;
  };
  const performance = {
    v1: perfOf(F.v1Derived), v2: perfOf(F.v2Derived),
    drawCalls: '建物 mesh は usageCategory × band ごとに merge する（buildGroup）。V1/V2 は同じ属性を持つので bucket 数＝draw call 数は同じ。ブラウザでの実測はこの環境では不可。',
  };

  const report = {
    version: 1, generatedAt, missionId: '32N',
    count: { v1: count.v1, v2: count.v2, expected: 615617, canonicalIdPreserved: idPreserved, build: build ? { plateau: build.v2.plateau, fallback: build.v2.fallback, missingPlateau: build.missingPlateau.count, rawScan: build.rawScan } : null },
    coordinate,
    rawTruthError,
    osmOverlap: {
      umeda: sites.umeda.osmOverlap, sumiyoshi: sites.sumiyoshi.osmOverlap,
      otherFixtures: Object.fromEntries(Object.entries(sites).filter(([k]) => k !== 'umeda' && k !== 'sumiyoshi').map(([k, v]) => [k, v.osmOverlap])),
    },
    ward,
    roadOverlap,
    waterOverlap,
    gsiBuildingAlignment: Object.fromEntries(Object.entries(sites).map(([k, v]) => [k, v.gsiBuildingAlignment])),
    landBlockContainment: sites.umeda.landBlockContainment || null,
    placement,
    runtime,
    nearExactCheck: nearCheck,
    fallbackDuplicates: measureFallbackDuplicates(v1, v2, v2Attr),
    performance,
    sites,
  };
  fs.writeFileSync(F.report, JSON.stringify(report, null, 2));
  return report;
}

export { main as evaluateBuildingCanonicalV2 };
if (isMainModule(import.meta.url)) {
  main().then((r) => {
    console.log('[eval] count', JSON.stringify(r.count));
    console.log('[eval] coordinate', JSON.stringify(r.coordinate));
    console.log('[eval] rawTruth', JSON.stringify(r.rawTruthError));
    console.log('[eval] osm', JSON.stringify(r.osmOverlap));
    console.log('[eval] ward', JSON.stringify({ old: r.ward.oldAccuracy, new: r.ward.correctedAccuracy, kita: r.ward.kita }));
    console.log('[eval] road', JSON.stringify(r.roadOverlap));
    console.log('[eval] water', JSON.stringify(r.waterOverlap));
    console.log('[eval] gsi', JSON.stringify(r.gsiBuildingAlignment));
    console.log('[eval] landBlock', JSON.stringify(r.landBlockContainment));
    console.log('[eval] placement', JSON.stringify(r.placement));
    console.log('[eval] runtime', JSON.stringify(r.runtime));
    console.log('[eval] nearExact', JSON.stringify(r.nearExactCheck));
    console.log('[eval] fallbackDuplicates', JSON.stringify(r.fallbackDuplicates));
    process.exit(0);
  }).catch((e) => { console.error(e); process.exit(1); });
}
