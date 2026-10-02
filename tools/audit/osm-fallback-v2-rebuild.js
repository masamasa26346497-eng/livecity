#!/usr/bin/env node
// tools/audit/osm-fallback-v2-rebuild.js
// [Mission 32O §15-§22] OSM fallback V2 再選定の評価 → data/reports/osm-fallback-v2-rebuild.json
//
//   - 重複 KPI（§15）は 32N と同じ基準（centroid-in-PLATEAU / bbox IoU>=0.3）で、旧 fallback と新 fallback を
//     V2 PLATEAU に対して測る（before = 22,758 の再現を含む）。AMBIGUOUS は別計上。
//   - coverage KPI（§16）は OSM 建物の面積のうち「PLATEAU ∪ fallback」で覆われる割合を before/after で比べる
//     （除外した fallback が本当に PLATEAU と重複していたなら coverage は落ちない）。
//   - PLATEAU 無変更（§1/§23）は merged canonical の PLATEAU feature / attributes を V2 と 1 件ずつ文字列比較する。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { resolveProjectPath, isMainModule } from '../lib/paths.js';
import { readFileRetry } from '../lib/synced-dir-writer.js';
import { pbfPrimitiveStream } from '../lib/osm-pbf-stream.js';
import { buildPlateauDedupIndex, isDuplicateOfPlateau, pointInRingXZ } from '../lib/osm-building-fallback.js';
import { TH, FALLBACK_V2_CLASS, measureOverlap, buildPlateauIndex, classifyOverlap } from '../lib/osm-fallback-v2-classify.js';

const require_ = createRequire(import.meta.url);
const P = (...s) => resolveProjectPath(path.join(...s));
const F = {
  v2: P('data', 'processed', 'osaka-city', 'canonical', 'buildings-v2-corrected'),
  merged: P('data', 'processed', 'osaka-city', 'canonical', 'buildings-v2-osmv2'),
  fallback: P('data', 'processed', 'osaka-city', 'canonical', 'buildings-v2-osm-fallback'),
  candidates: P('data', 'processed', 'osaka-city', 'osm-fallback-v2', 'candidates.json'),
  deprecated: P('data', 'processed', 'osaka-city', 'osm-fallback-v2', 'deprecated-ids.json'),
  build: P('data', 'reports', 'osm-fallback-v2-build.json'),
  v2Derived: P('data', 'processed', 'osaka-city', 'derived-v2-corrected'),
  osmv2Derived: P('data', 'processed', 'osaka-city', 'derived-v2-osmv2'),
  osmv2Public: P('public', 'map-data', 'osaka-city', 'derived-v2-osmv2'),
  placementV2: P('data', 'reports', 'building-placement-policy-v2-corrected.json'),
  placementV2N: P('data', 'reports', 'building-placement-policy-v2-osmv2.json'),
  pbf: P('data', 'raw', 'osm', 'osaka-latest.osm.pbf'),
  area: P('config', 'areas', 'osaka-city.json'),
  wardPolys: P('data', 'processed', 'osaka-city', 'boundaries', 'ward-classification-polygons.json'),
  html: P('public', 'osaka_3d_buildings.ward-ux-v1.html'),
  harness: P('tests', '_ward-ux-v1-smoke-harness.cjs'),
  report: P('data', 'reports', 'osm-fallback-v2-rebuild.json'),
  samplesHtml: P('data', 'reports', 'osm-fallback-v2-likely-samples.html'),
};
const rj = (p) => JSON.parse(readFileRetry(p));
const isTile = (f) => /^tile_-?\d+_-?\d+\.json$/.test(f);
const sha = (s) => crypto.createHash('sha1').update(s).digest('hex');

function loadCanonSplit(dir) {
  const plateau = new Map(), fallback = new Map();
  for (const f of fs.readdirSync(dir)) {
    if (!isTile(f)) continue;
    const t = rj(path.join(dir, f));
    const a = rj(path.join(dir, 'attributes', f)).attributes;
    for (const ft of t.features) {
      const rec = { ring: ft.coordinates[0], bbox: ft.bbox, centroid: ft.centroid, fHash: sha(JSON.stringify(ft)), aHash: sha(JSON.stringify(a[ft.canonicalId])), attrs: a[ft.canonicalId] };
      (ft.source.geometrySource === 'plateau-building' ? plateau : fallback).set(ft.canonicalId, rec);
    }
  }
  return { plateau, fallback };
}

// 疑似乱数（サンプル抽出の再現性）
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }
function pick(arr, n, seed) { const r = rng(seed); const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a.slice(0, n); }

function svgOf(c, plateauById, plateauIdx) {
  const ring = c.ring;
  let a = Infinity, b = -Infinity, d = Infinity, e = -Infinity;
  for (const [x, z] of ring) { a = Math.min(a, x); b = Math.max(b, x); d = Math.min(d, z); e = Math.max(e, z); }
  const pad = 25; a -= pad; b += pad; d -= pad; e += pad;
  const W = 220, s = W / Math.max(b - a, e - d);
  const pts = (r) => r.map(([x, z]) => ((x - a) * s).toFixed(1) + ',' + ((z - d) * s).toFixed(1)).join(' ');
  const near = new Set();
  const cm = plateauIdx.cellM;
  for (let cx = Math.floor(a / cm); cx <= Math.floor(b / cm); cx++) for (let cz = Math.floor(d / cm); cz <= Math.floor(e / cm); cz++) for (const r of plateauIdx.grid.get(cx + ',' + cz) || []) near.add(r);
  let body = '';
  for (const r of near) body += `<polygon points="${pts(r.ring)}" fill="rgba(60,120,220,0.35)" stroke="#2a5db0" stroke-width="1"/>`;
  body += `<polygon points="${pts(ring)}" fill="rgba(230,80,60,0.25)" stroke="#d0402a" stroke-width="1.5"/>`;
  return `<svg width="${W}" height="${W}" viewBox="0 0 ${W} ${W}" style="background:#fafafa;border:1px solid #ddd">${body}</svg>`;
}

async function main() {
  const generatedAt = new Date().toISOString();
  const build = rj(F.build);
  const cand = rj(F.candidates);
  const cands = cand.candidates;
  const candById = new Map(cands.map((c) => [c.canonicalId, c]));
  const deprecated = rj(F.deprecated);
  const proj = rj(F.area).projection;
  const KX = Math.cos((proj.centerLat * Math.PI) / 180) * proj.metersPerDegree;

  console.log('[o2-eval] canonical 読み込み…');
  const v2 = loadCanonSplit(F.v2);
  const nv = loadCanonSplit(F.merged);

  // ── §1/§23 PLATEAU 無変更 ──
  let plateauFeatureDiff = 0, plateauAttrDiff = 0, plateauMissing = 0;
  for (const [id, r] of v2.plateau) {
    const n = nv.plateau.get(id);
    if (!n) { plateauMissing++; continue; }
    if (n.fHash !== r.fHash) plateauFeatureDiff++;
    if (n.aHash !== r.aHash) plateauAttrDiff++;
  }
  const plateauExtra = [...nv.plateau.keys()].filter((id) => !v2.plateau.has(id)).length;
  const plateauV2Mutation = plateauFeatureDiff + plateauAttrDiff + plateauMissing + plateauExtra;
  const v2ManifestNow = rj(path.join(F.v2, 'manifest.json')).generatedAt;

  // fallback 単独 dir と merged の fallback が一致
  const fbOnly = new Set();
  for (const f of fs.readdirSync(F.fallback)) if (isTile(f)) for (const ft of rj(path.join(F.fallback, f)).features) fbOnly.add(ft.canonicalId);
  const separationConsistent = fbOnly.size === nv.fallback.size && [...fbOnly].every((id) => nv.fallback.has(id));

  // ── 分類集計（§5-§9） ──
  const C = FALLBACK_V2_CLASS;
  const count = (arr, fn) => arr.reduce((n, x) => n + (fn(x) ? 1 : 0), 0);
  const inGap = cands.filter((c) => c.gapReason);
  const old = cands.filter((c) => c.isOld);
  const classCounts = (arr) => Object.fromEntries(Object.values(C).map((k) => [k, count(arr, (c) => c.cls === k)]));
  const byRule = {};
  for (const c of cands) byRule[c.cls + ':' + c.rule] = (byRule[c.cls + ':' + c.rule] || 0) + 1;
  const oldByClass = classCounts(old);
  const removedDup = count(old, (c) => c.cls === C.CLEAR_DUPLICATE || c.cls === C.LIKELY_DUPLICATE);
  const removedNotInGap = count(old, (c) => !c.gapReason && (c.cls === C.VALID_FALLBACK || c.cls === C.AMBIGUOUS));
  const duplicates = {
    candidatesInGap: classCounts(inGap),
    oldFallback: oldByClass,
    clear: count(cands, (c) => c.cls === C.CLEAR_DUPLICATE),
    likely: count(cands, (c) => c.cls === C.LIKELY_DUPLICATE),
    ambiguous: count(cands, (c) => c.cls === C.AMBIGUOUS && c.gapReason),
    removed: removedDup,
    removedNotInGap,
    removedSourceNotReproduced: cand.oldFallbackNotReproduced,
    byRule,
    oneToMany: { osmSpanningMultiplePlateau: count(cands, (c) => c.metrics.plateauPartners >= 2), removedWithMultiplePartners: count(old, (c) => !['VALID_FALLBACK', 'AMBIGUOUS'].includes(c.cls) && c.metrics.plateauPartners >= 2), osmEnvelopingPlateau: count(cands, (c) => c.rule === 'osm-envelops-plateau') },
  };

  // 閾値の感度（§7）
  const sens = {};
  for (const [name, patch] of [['clearCovered0.4', { clearCovered: 0.4 }], ['clearCovered0.6', { clearCovered: 0.6 }], ['likelyCovered0.1', { likelyCovered: 0.1 }], ['likelyCovered0.3', { likelyCovered: 0.3 }]]) {
    const t = { ...TH, ...patch };
    let removed = 0;
    for (const c of inGap) {
      const m = c.metrics;
      const clear = m.coveredFraction >= t.clearCovered || m.maxIoU >= t.clearIoU;
      const env = m.maxPlateauInside >= t.likelyPlateauInside && m.maxPlateauInsideShare >= t.likelyPlateauShare;
      let likely = !clear && (m.coveredFraction >= t.likelyCovered || m.centroidInPlateau || env || m.maxBboxIoU >= t.likelyBboxIoU);
      if (likely && (m.osmArea - m.intersectionArea) >= t.keepUncoveredM2 && m.coveredFraction < t.keepCoveredBelow && !env) likely = false;
      if (clear || likely) removed++;
    }
    sens[name] = { removedFromGapCandidates: removed, delta: removed - (duplicates.candidatesInGap.CLEAR_DUPLICATE + duplicates.candidatesInGap.LIKELY_DUPLICATE) };
  }

  // ── §15 重複 KPI（32N と同じ基準） ──
  const plateauIdxOld = buildPlateauDedupIndex([...nv.plateau.values()].map((r) => r.ring), 40);
  // 32N §A は重心を「頂点平均」で取った（22,758）。isDuplicateOfPlateau（Mission 21B 実装）は面積重心。両方出す。
  const dupVertexMean = (ring) => {
    const cx = ring.reduce((a, p) => a + p[0], 0) / ring.length, cz = ring.reduce((a, p) => a + p[1], 0) / ring.length;
    let a = Infinity, b2 = -Infinity, c = Infinity, d = -Infinity;
    for (const [x, z] of ring) { a = Math.min(a, x); b2 = Math.max(b2, x); c = Math.min(c, z); d = Math.max(d, z); }
    const cm = plateauIdxOld.cellM;
    for (let gx = Math.floor(a / cm); gx <= Math.floor(b2 / cm); gx++) for (let gz = Math.floor(c / cm); gz <= Math.floor(d / cm); gz++) {
      for (const rec of plateauIdxOld.grid.get(gx + ',' + gz) || []) {
        if (pointInRingXZ(cx, cz, rec.fp)) return true;
        const ox = Math.max(0, Math.min(b2, rec.b.maxX) - Math.max(a, rec.b.minX)), oz = Math.max(0, Math.min(d, rec.b.maxZ) - Math.max(c, rec.b.minZ));
        const inter = ox * oz, u = (b2 - a) * (d - c) + (rec.b.maxX - rec.b.minX) * (rec.b.maxZ - rec.b.minZ) - inter;
        if (u > 0 && inter / u >= 0.3) return true;
      }
    }
    return false;
  };
  const kpi = (map, ambiguousIds) => {
    let n = 0, amb = 0;
    for (const [id, r] of map) if (isDuplicateOfPlateau(r.ring, plateauIdxOld, 0.30)) { n++; if (ambiguousIds && ambiguousIds.has(id)) amb++; }
    let vm = 0; for (const [, r] of map) if (dupVertexMean(r.ring)) vm++;
    return { overlapBuildings: n, ofWhichAmbiguous: amb, excludingAmbiguous: n - amb, overlapBuildingsVertexMeanCentroid: vm };
  };
  const ambIds = new Set(cands.filter((c) => c.cls === C.AMBIGUOUS && c.gapReason).map((c) => c.canonicalId));
  const duplicateKpi = {
    criterion: 'fallback の centroid が V2 PLATEAU 内 / bbox IoU>=0.3（Mission 32N §A と同じ）',
    before: kpi(v2.fallback, null),
    after: kpi(nv.fallback, ambIds),
  };
  // 面積ベースでも（CLEAR 相当の重なりが残っていないか）
  const pIdx = buildPlateauIndex([...nv.plateau].map(([id, r]) => ({ id, ring: r.ring, bb: r.bbox })), 40);
  let afterCovered50 = 0, afterCovered20 = 0;
  for (const [, r] of nv.fallback) { const m = measureOverlap(r.ring, pIdx); if (m.coveredFraction >= 0.5) afterCovered50++; if (m.coveredFraction >= 0.2) afterCovered20++; }
  duplicateKpi.after.areaCovered50 = afterCovered50;
  duplicateKpi.after.areaCovered20 = afterCovered20;

  // ── §17 区別 ──
  const byWard = {};
  const W = (w) => (byWard[w || 'none'] ||= { oldFallback: 0, newFallback: 0, removedDuplicate: 0, removedNotInGap: 0, retainedFallback: 0, newlyAdded: 0, ambiguous: 0 });
  for (const [, r] of v2.fallback) W(r.attrs.wardId).oldFallback++;
  for (const [, r] of nv.fallback) { const w = W(r.attrs.wardId); w.newFallback++; if (r.attrs.fallbackV2Status === 'retained') w.retainedFallback++; else w.newlyAdded++; if (r.attrs.fallbackV2Class === C.AMBIGUOUS) w.ambiguous++; }
  for (const c of old) {
    const oldWard = (v2.fallback.get(c.canonicalId) || {}).attrs?.wardId;
    if (c.cls === C.CLEAR_DUPLICATE || c.cls === C.LIKELY_DUPLICATE) W(oldWard).removedDuplicate++;
    else if (!c.gapReason) W(oldWard).removedNotInGap++;
  }
  const wardCheck = { newFallbackWithoutWard: count([...nv.fallback.values()], (r) => !r.attrs.wardId), wardsWithFallback: Object.keys(byWard).filter((k) => k !== 'none').length };

  // ── §16/§18/§19 visual fixtures ──
  const wp = rj(F.wardPolys);
  const hy = wp.wards.find((w) => w.wardId === 'higashiyodogawa');
  const SITES = [
    { id: 'umeda', x: -2668.18, z: -10941.87 }, { id: 'honmachi', x: -2072.6, z: -8693.2 },
    { id: 'namba', x: -2173.39, z: -6511.33 }, { id: 'tennoji', x: -1055.54, z: -4618.89 },
    { id: 'sumiyoshi', x: -2952.22, z: -811.75 },
    { id: 'higashiyodogawa', x: Math.round((hy.bbox.minX + hy.bbox.maxX) / 2), z: Math.round((hy.bbox.minZ + hy.bbox.maxZ) / 2) },
    { id: 'nakanoshima', x: -2695.66, z: -9962.25 },
  ];
  const R = 500;
  const box = (s) => ({ minX: s.x - R, maxX: s.x + R, minZ: s.z - R, maxZ: s.z + R });
  const latOf = (z) => proj.centerLat - z / proj.metersPerDegree, lonOf = (x) => proj.centerLon + x / KX;
  const toXZ = (lat, lon) => [(lon - proj.centerLon) * KX, -(lat - proj.centerLat) * proj.metersPerDegree];
  const lls = SITES.map(box).map((b) => ({ s: latOf(b.maxZ + 100), n: latOf(b.minZ - 100), w: lonOf(b.minX - 100), e: lonOf(b.maxX + 100) }));
  console.log('[o2-eval] OSM…');
  const nodes = new Map(), osmRings = [];
  for await (const p of pbfPrimitiveStream(F.pbf)) {
    if (p.type === 'node') { for (const q of lls) if (p.lat >= q.s && p.lat <= q.n && p.lon >= q.w && p.lon <= q.e) { nodes.set(p.id, toXZ(p.lat, p.lon)); break; } }
    else if (p.type === 'way') {
      const t = p.tags || {}; if (!t.building) continue;
      const pts = []; let ok = true; for (const r of p.refs || []) { const c = nodes.get(r); if (!c) { ok = false; break; } pts.push(c); }
      if (ok && pts.length >= 4) osmRings.push(pts);
    }
  }
  const raster = (b) => ({ b, nx: b.maxX - b.minX, nz: b.maxZ - b.minZ, m: new Uint8Array((b.maxX - b.minX) * (b.maxZ - b.minZ)) });
  function fill(r, ring, bit) {
    let a = Infinity, c = -Infinity, d = Infinity, e = -Infinity;
    for (const p of ring) { a = Math.min(a, p[0]); c = Math.max(c, p[0]); d = Math.min(d, p[1]); e = Math.max(e, p[1]); }
    if (c < r.b.minX || a > r.b.maxX || e < r.b.minZ || d > r.b.maxZ) return;
    for (let i = Math.max(0, Math.floor(a - r.b.minX)); i <= Math.min(r.nx - 1, Math.floor(c - r.b.minX)); i++) {
      const x = r.b.minX + i + 0.5;
      for (let j = Math.max(0, Math.floor(d - r.b.minZ)); j <= Math.min(r.nz - 1, Math.floor(e - r.b.minZ)); j++) if (pointInRingXZ(x, r.b.minZ + j + 0.5, ring)) r.m[j * r.nx + i] |= bit;
    }
  }
  const inB = (bb, b) => bb.maxX >= b.minX && bb.minX <= b.maxX && bb.maxZ >= b.minZ && bb.minZ <= b.maxZ;
  const visualFixtures = {};
  const picking = { fixtures: {} };
  for (const s of SITES) {
    const b = box(s);
    const r = raster(b);
    const OSM = 1, PL = 2, OLD = 4, NEW = 8;
    for (const ring of osmRings) fill(r, ring, OSM);
    const plIn = [...nv.plateau].filter(([, x]) => inB(x.bbox, b));
    const oldIn = [...v2.fallback].filter(([, x]) => inB(x.bbox, b));
    const newIn = [...nv.fallback].filter(([, x]) => inB(x.bbox, b));
    for (const [, x] of plIn) fill(r, x.ring, PL);
    for (const [, x] of oldIn) fill(r, x.ring, OLD);
    for (const [, x] of newIn) fill(r, x.ring, NEW);
    // 除外した旧 fallback を理由別に塗る（被覆率低下の内訳）
    const DUP = 16, NOTGAP = 32;
    for (const [id, x] of oldIn) {
      if (nv.fallback.has(id)) continue;
      const c = candById.get(id);
      fill(r, x.ring, c && !c.gapReason && (c.cls === C.VALID_FALLBACK || c.cls === C.AMBIGUOUS) ? NOTGAP : DUP);
    }
    let osmA = 0, covB = 0, covA = 0, dblB = 0, dblA = 0, fbOnlyB = 0, fbOnlyA = 0, lossDup = 0, lossNotGap = 0;
    for (const v of r.m) {
      if ((v & OSM) && (v & OLD) && !(v & (PL | NEW))) { if (v & NOTGAP) lossNotGap++; else if (v & DUP) lossDup++; }
      if (v & OSM) { osmA++; if (v & (PL | OLD)) covB++; if (v & (PL | NEW)) covA++; }
      if ((v & PL) && (v & OLD)) dblB++;
      if ((v & PL) && (v & NEW)) dblA++;
      if ((v & OLD) && !(v & PL)) fbOnlyB++;
      if ((v & NEW) && !(v & PL)) fbOnlyA++;
    }
    // picking: 建物の代表点で、footprint が 2 つ以上当たる点（duplicate picking）
    const pickDup = (fbList) => {
      const all = [...plIn, ...fbList];
      let pts = 0, dup = 0;
      for (const [, x] of all) {
        const [px, pz] = x.centroid; pts++;
        let hits = 0;
        for (const [, y] of all) { const bb = y.bbox; if (px < bb.minX || px > bb.maxX || pz < bb.minZ || pz > bb.maxZ) continue; if (pointInRingXZ(px, pz, y.ring) && ++hits > 1) break; }
        if (hits > 1) dup++;
      }
      return { points: pts, pointsHittingMultipleFootprints: dup };
    };
    const osmSourceMissing = osmA === 0;
    visualFixtures[s.id] = {
      center: [s.x, s.z], halfSizeM: R,
      plateau: plIn.length, oldFallback: oldIn.length, newFallback: newIn.length,
      osmBuildingAreaM2: osmA, osmSource: osmSourceMissing ? 'SOURCE_MISSING（OSM PBF 北端 34.735° 以北は無い）' : 'ok',
      coverageOfOsmBefore: osmA ? +(covB / osmA).toFixed(4) : null,
      coverageOfOsmAfter: osmA ? +(covA / osmA).toFixed(4) : null,
      coverageLossM2: covB - covA,
      coverageLossByRemovalReasonM2: { duplicateOutsidePlateau: lossDup, notInPlateauGap: lossNotGap },
      plateauFallbackDoubleM2: { before: dblB, after: dblA },
      fallbackOnlyAreaM2: { before: fbOnlyB, after: fbOnlyA },
      fallbackOnlyAreaLossM2: fbOnlyB - fbOnlyA,
    };
    picking.fixtures[s.id] = { before: pickDup(oldIn), after: pickDup(newIn) };
    console.log('[o2-eval] site', s.id, JSON.stringify(visualFixtures[s.id]));
  }
  // property card に必要な属性（§19）
  const propFields = ['usageCategory', 'usageLabel', 'normalizedUsage', 'wardId', 'source', 'confidence'];
  picking.newFallbackMissingPropertyFields = count([...nv.fallback.values()], (r) => propFields.some((k) => r.attrs[k] == null || r.attrs[k] === ''));
  picking.newFallbackNullLabel = count([...nv.fallback.values()], (r) => /null/.test(String(r.attrs.usageLabel)));
  picking.pickPathUnchanged = /function pickBuilding\(rayObj\)/.test(fs.readFileSync(F.html, 'utf-8'));

  // ── §13 runtime ──
  let runtime = null;
  try {
    const { runInlineScript } = require_(F.harness);
    const boot = runInlineScript(F.html, { fetchRoot: P('public') });
    const w = boot.window;
    const dflt = w.__BUILDINGS_VERSION_DEBUG__().version;
    await w.__SET_BUILDINGS_VERSION__('V2N');
    const dN = w.__BUILDINGS_VERSION_DEBUG__();
    const resN = w.__CANONICAL_SELF_CHECK__().total;
    await w.__SET_BUILDINGS_VERSION__('V2');
    const d2 = w.__BUILDINGS_VERSION_DEBUG__();
    await w.__SET_BUILDINGS_VERSION__('V1');
    runtime = { defaultVersion: dflt, v2n: dN, residualInV2N: resN, v2: { base: d2.base, osmFallback: d2.osmFallback }, backToV1: w.__BUILDINGS_VERSION_DEBUG__().version };
  } catch (e) { runtime = { error: String(e && e.message || e) }; }
  // V2N の公開 tile に旧 fallback の除外 ID が 1 件も無い
  const deprecatedIds = new Set(deprecated.ids.map((x) => x.canonicalId));
  const staleInPublic = { checkedFeatures: 0, deprecatedIdsFound: 0, lods: {} };
  for (const lod of ['far', 'mid', 'near']) {
    const dir = path.join(F.osmv2Public, lod, 'buildings');
    const m = rj(path.join(dir, 'manifest.json'));
    // derived tile は tile 境界をまたぐ feature を複数 tile に持つので、件数は distinct で数える
    const ids = new Set();
    for (const t of m.tiles) for (const id of rj(path.join(dir, t.file)).canonicalIds) ids.add(id);
    let bad = 0, oldOnly = 0;
    for (const id of ids) { if (deprecatedIds.has(id)) bad++; if (v2.fallback.has(id) && !nv.fallback.has(id)) oldOnly++; }
    staleInPublic.lods[lod] = { distinctFeatures: ids.size, deprecatedIdsFound: bad, oldOnlyFallbackIdsFound: oldOnly, manifestFeatureCount: m.featureCount };
    staleInPublic.checkedFeatures += ids.size; staleInPublic.deprecatedIdsFound += bad + oldOnly;
  }
  const oldFallbackNotUsedInV2Runtime = !!(runtime && runtime.v2n && /derived-v2-osmv2$/.test(runtime.v2n.base) && staleInPublic.deprecatedIdsFound === 0 && staleInPublic.lods.near.distinctFeatures === nv.plateau.size + nv.fallback.size);

  // ── §7 LIKELY サンプル QA ──
  const likely = cands.filter((c) => c.cls === C.LIKELY_DUPLICATE);
  const keptAmb = cands.filter((c) => c.rule === 'likely-but-large-uncovered');
  const plateauById = null;
  const sampleRows = (arr, n, seed) => pick(arr, n, seed).map((c) => ({ canonicalId: c.canonicalId, isOld: c.isOld, cls: c.cls, rule: c.rule, wardId: c.wardId, center: [+(c.ring.reduce((a, p) => a + p[0], 0) / c.ring.length).toFixed(1), +(c.ring.reduce((a, p) => a + p[1], 0) / c.ring.length).toFixed(1)], ...c.metrics }));
  const likelySamples = sampleRows(likely, 60, 32);
  const keptSamples = sampleRows(keptAmb, 30, 33);
  const hist = (arr) => { const h = {}; for (const c of arr) { const k = (Math.floor(c.metrics.coveredFraction * 10) / 10).toFixed(1); h[k] = (h[k] || 0) + 1; } return h; };
  const likelyQa = {
    likelyCount: likely.length,
    likelyByRule: likely.reduce((a, c) => ((a[c.rule] = (a[c.rule] || 0) + 1), a), {}),
    likelyCoveredHistogram: hist(likely),
    likelyUncoveredAreaM2: { median: med(likely.map((c) => c.metrics.osmArea - c.metrics.intersectionArea)), p90: pct(likely.map((c) => c.metrics.osmArea - c.metrics.intersectionArea), 0.9) },
    keptAsAmbiguousBecauseLargeUncovered: keptAmb.length,
    samples: likelySamples, keptSamples,
    visualSheet: 'data/reports/osm-fallback-v2-likely-samples.html',
  };
  // サンプル画像（赤 = OSM 候補 / 青 = V2 PLATEAU）
  const sheetIdx = buildPlateauIndex([...nv.plateau].map(([id, r]) => ({ id, ring: r.ring, bb: r.bbox })), 40);
  const byId = new Map(cands.map((c) => [c.canonicalId, c]));
  const card = (row) => `<figure>${svgOf(byId.get(row.canonicalId), plateauById, sheetIdx)}<figcaption>${row.canonicalId}<br>${row.cls} / ${row.rule}<br>covered ${row.coveredFraction} · IoU ${row.maxIoU} · partners ${row.plateauPartners}<br>osm ${row.osmArea}m² · ${row.wardId}</figcaption></figure>`;
  fs.writeFileSync(F.samplesHtml, `<!doctype html><meta charset="utf-8"><title>OSM fallback V2 likely samples</title><style>body{font:12px system-ui;margin:16px}figure{display:inline-block;margin:6px;vertical-align:top;width:224px}figcaption{font:10px ui-monospace,monospace;word-break:break-all}</style>`
    + `<h1>Mission 32O — LIKELY_DUPLICATE（除外）サンプル 60</h1><p>赤 = OSM fallback 候補 / 青 = V2 PLATEAU。</p>${likelySamples.map(card).join('')}`
    + `<h1>重なるが「重ならない部分が大きい」ため残した AMBIGUOUS サンプル 30</h1>${keptSamples.map(card).join('')}`);

  // ── §21/§24 placement・性能 ──
  const pv2 = rj(F.placementV2), pvn = rj(F.placementV2N);
  const perf = (root) => Object.fromEntries(['far', 'mid', 'near'].map((lod) => { const m = rj(path.join(root, lod, 'buildings', 'manifest.json')); return [lod, { features: m.featureCount, vertices: m.vertexCount, tiles: m.tiles.length }]; }));

  const report = {
    version: 1, generatedAt, missionId: '32O',
    plateauCount: nv.plateau.size,
    oldOsmFallbackCount: v2.fallback.size,
    newOsmFallbackCount: nv.fallback.size,
    newTotalBuildingCount: nv.plateau.size + nv.fallback.size,
    previousTotal: v2.plateau.size + v2.fallback.size,
    fallbackChange: { retained: build.canonical.retainedOld, newlyAdded: build.canonical.newlyAdded, removed: build.canonical.removedOld, removedByReason: build.canonical.removedByReason },
    plateauIntegrity: { plateauV2Mutation, plateauFeatureDiff, plateauAttrDiff, plateauMissing, plateauExtra, v2CanonicalGeneratedAt: v2ManifestNow, v2CanonicalGeneratedAtAtAnalysis: cand.v2Canonical.generatedAt },
    sourceSeparation: { plateauDir: 'data/processed/osaka-city/canonical/buildings-v2-corrected（PLATEAU 部分を無変更で使用）', fallbackDir: 'data/processed/osaka-city/canonical/buildings-v2-osm-fallback', mergedDir: 'data/processed/osaka-city/canonical/buildings-v2-osmv2', consistent: separationConsistent },
    selectionRule: {
      old: '(Mission 21B/29) V1 PLATEAU 基準: hole = 50m cell + 8 近傍に PLATEAU 無し / sparse-mismatch = 100m cell で OSM 面積 >= 2.5×PLATEAU かつ OSM >= 5 棟。重複 = OSM centroid が PLATEAU 内 または bbox IoU >= 0.22（build）/0.30（canonical）。距離は使わない。区 = centroid-in-ward。',
      new: 'V2 PLATEAU 基準（V1 footprint 不使用）: 場所の条件は同じ。重複は面積ベース（tools/lib/osm-fallback-v2-classify.js）。区 = N03 2026 representativePoint。',
      thresholds: TH,
      candidateStats: cand.stats,
    },
    thresholdRationale: {
      clear: 'OSM の 50% 以上が PLATEAU と重なる、または PLATEAU 1 棟との IoU >= 0.5 → 同じ建物（32N 実測で同一建物の OSM 被覆率中央値は 0.84〜1.0）',
      likely: '20% 以上重なる / OSM 重心が PLATEAU 内 / OSM が PLATEAU を包む / 旧 bbox IoU 基準 → 重複扱い。ただし重ならない部分が 60m² 以上かつ重なり 35% 未満なら別建物の可能性として残す（AMBIGUOUS）',
      ambiguous: '2〜20% の部分的な重なり → 残すが別計上',
      sensitivity: sens,
    },
    duplicates, duplicateKpi, likelyQa,
    byWard, wardCheck,
    visualFixtures, picking,
    runtime, staleInPublic, oldFallbackNotUsedInV2Runtime,
    placement: { v2OldOsm: pv2.policyCounts, v2NewOsm: pvn.policyCounts, v2NewOsmDetail: pvn.detailCounts, uses31e: false },
    performance: { v2OldOsm: perf(F.v2Derived), v2NewOsm: perf(F.osmv2Derived) },
    deprecatedIds: { count: deprecated.count, file: 'data/processed/osaka-city/osm-fallback-v2/deprecated-ids.json' },
  };
  fs.writeFileSync(F.report, JSON.stringify(report, null, 2));
  return report;
}
function med(v) { if (!v.length) return null; const s = [...v].sort((a, b) => a - b); return +s[s.length >> 1].toFixed(2); }
function pct(v, q) { if (!v.length) return null; const s = [...v].sort((a, b) => a - b); return +s[Math.min(s.length - 1, Math.floor(s.length * q))].toFixed(2); }

export { main as evaluateOsmFallbackV2 };
if (isMainModule(import.meta.url)) {
  main().then((r) => {
    for (const k of ['plateauCount', 'oldOsmFallbackCount', 'newOsmFallbackCount', 'newTotalBuildingCount', 'fallbackChange', 'plateauIntegrity', 'duplicates', 'duplicateKpi', 'wardCheck', 'picking', 'runtime', 'staleInPublic', 'oldFallbackNotUsedInV2Runtime', 'placement', 'performance']) console.log('[o2-eval]', k, JSON.stringify(r[k]));
    console.log('[o2-eval] likely', JSON.stringify({ ...r.likelyQa, samples: undefined, keptSamples: undefined }));
    console.log('[o2-eval] sensitivity', JSON.stringify(r.thresholdRationale.sensitivity));
    process.exit(0);
  }).catch((e) => { console.error(e); process.exit(1); });
}
