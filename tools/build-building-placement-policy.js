#!/usr/bin/env node
// tools/build-building-placement-policy.js
// [Mission 31G-FIX6] Building Placement Policy の事前計算。
//
//   目的: 「通常の建物は Canonical Water / Canonical Roads の上には表示しない」を
//   render visibility policy として導入する。source / canonical geometry は一切変更しない（§0/§9/§11）。
//   毎フレーム intersection しないための precompute（§23/§24）。runtime は lookup だけ。
//
//   入力:
//     data/processed/osaka-city/canonical/buildings/  (615,617 棟・不変)
//     data/processed/osaka-city/canonical/water/      (polygon-first)
//     data/processed/osaka-city/canonical/roads/      (PLATEAU tran polygon-first)
//     data/reports/canonical-conflict-resolution.json (31E 分類。EXPLAIN/MANUAL_REVIEW/RECLASSIFY を再利用 §4)
//     data/reports/canonical-conflicts-all.json       (31E overlap 実測。per-building olArea)
//
//   出力:
//     data/processed/osaka-city/derived/building-placement/manifest.json
//     data/processed/osaka-city/derived/building-placement/tile_<tx>_<tz>.json
//        { tx, tz, tileSize:500, generatedAt, policies: { <canonicalId>: {policy, reason, ...} } }
//        DISPLAY は既定なので tile には載せない（SUPPRESS / REVIEW / EXEMPT のみ）。
//     data/reports/building-placement-policy.json     (§16 集計 + 分布 + threshold 根拠)
//
//   policy: DISPLAY | SUPPRESS | REVIEW | EXEMPT（§1）
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, toProjectRelativePath } from './lib/paths.js';
import { writeJson } from './lib/area.js';
import { writeFilesVerified, readFileRetry } from './lib/synced-dir-writer.js';
import { ringAreaM2 } from './lib/canonical-geometry-schema.js';

const P = (...s) => resolveProjectPath(path.join(...s));
// [Mission 32N] V2 corrected 用に入出力を環境変数で差し替えられるようにする（未指定なら従来どおり V1）。
//   PLACEMENT_NO_31E=1 のときは 31E の衝突索引（V1 座標で計算済み）を使わず、渡された geometry から計算し直す（§22）。
const ENV = process.env;
const BUILD_DIR = ENV.PLACEMENT_BUILD_DIR ? path.resolve(ENV.PLACEMENT_BUILD_DIR) : P('data', 'processed', 'osaka-city', 'canonical', 'buildings');
const ATTR_DIR = ENV.PLACEMENT_ATTR_DIR ? path.resolve(ENV.PLACEMENT_ATTR_DIR) : P('data', 'processed', 'osaka-city', 'canonical', 'buildings', 'attributes');
const NO_31E = ENV.PLACEMENT_NO_31E === '1';
const WATER_DIR = P('data', 'processed', 'osaka-city', 'canonical', 'water');
const ROADS_DIR = P('data', 'processed', 'osaka-city', 'canonical', 'roads');
const RESOLUTION = P('data', 'reports', 'canonical-conflict-resolution.json');
const CONFLICTS_ALL = P('data', 'reports', 'canonical-conflicts-all.json');
const OUT_DIR = ENV.PLACEMENT_OUT_DIR ? path.resolve(ENV.PLACEMENT_OUT_DIR) : P('data', 'processed', 'osaka-city', 'derived', 'building-placement');
const REPORT = ENV.PLACEMENT_REPORT ? path.resolve(ENV.PLACEMENT_REPORT) : P('data', 'reports', 'building-placement-policy.json');

const TILE = 500;
const HASH_M = 50;            // 空間ハッシュのセル
const SAMPLE_M = 2;           // footprint サンプル間隔
const MAX_SAMPLE = 900;       // 1 棟あたりサンプル上限（超巨大 footprint の暴走防止）

// ── threshold（§5: 実データ分布から設計。分布は下で算出しレポートに残す）──
//   Water: canonical water は実際の水面。footprint の相当割合が水面内なら「水上建物」。
const TH = {
  // Water: OSM riverbank polygon は陸側を過剰包含しうる（31E systematic finding #1 possible-osm-water-boundary-error）。
  //   → 部分的な重なりは SUPPRESS せず REVIEW。footprint が「ほぼ完全に」水面内の時だけ SUPPRESS。
  WATER_SUPPRESS_RATIO: 0.85,   // footprint の 85% 以上が水面内（hole=中州/島は除外済み）
  WATER_SUPPRESS_AREA: 15,      // かつ絶対重なり 15m² 以上（数 m² の sliver は除外 §6）
  WATER_REVIEW_RATIO: 0.30,     // 30–85% は REVIEW（推測で消さない §4/§6）
  // Road: 31E systematic finding #2 = PLATEAU tran 道路区域面は実舗装より広い（都市計画決定幅）。
  //   → 道路 polygon への部分的な重なりは「敷地界の重なり」で正常。ほぼ完全に内包された時だけ SUPPRESS。
  ROAD_SUPPRESS_RATIO: 0.97,    // footprint の 97% 以上が道路区域内（＝道路上に乗っている）
  ROAD_SUPPRESS_AREA: 25,
  ROAD_SUPPRESS_MAX_AREA: 1200, // これより大きい建物が道路内 = むしろ道路 polygon 誤り疑い → REVIEW
  ROAD_REVIEW_RATIO: 0.85,
  ROAD_SUPPRESS_CAP_FRAC: 0.01, // SUPPRESS が総棟数の 1% を超えたら road 側を REVIEW へ降格（§16）
};

// 実在する立体交差・施設（§2/§3）。usage ラベルで exempt。
const EXEMPT_SEMANTIC = /駅|停車場|プラット|ホーム|橋|高架|歩廊|アーケード|回廊|港湾|埠頭|ふ頭|岸壁|物揚|上屋|水門|樋門|閘門|排水機場|ポンプ場|揚水機|ゲート|桟橋|船|渡船|フェリー/;
// 31E resolvedCause / explanation のうち「表示してよい」もの（§4: EXPLAIN → EXEMPT/DISPLAY）
const EXEMPT_CAUSES = new Set([
  'building-over-road', 'covered-road', 'elevated-road', 'road-under-building', 'arcade',
  'over-water-structure', 'bridge-building', 'harbor-structure', 'river-side-structure',
  'bridge', 'centerline-offset', 'boundary-rounding-sliver', 'station-building',
  'park-facility', 'underground', 'elevated-rail-or-alignment',
]);

function pointInRing(x, z, ring) {
  let ins = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], zi = ring[i][1], xj = ring[j][0], zj = ring[j][1];
    if (((zi > z) !== (zj > z)) && (x < ((xj - xi) * (z - zi)) / (zj - zi) + xi)) ins = !ins;
  }
  return ins;
}
function ringBbox(ring) {
  let a = Infinity, b = -Infinity, c = Infinity, d = -Infinity;
  for (const [x, z] of ring) { if (x < a) a = x; if (x > b) b = x; if (z < c) c = z; if (z > d) d = z; }
  return { minX: a, maxX: b, minZ: c, maxZ: d };
}
// geometry を polygon 配列 [ [outer, hole, hole...], ... ] に正規化（hole を無視しない §7/§21: 中州・島）。
function toPolys(f) {
  if (f.geometryType === 'Polygon') return f.coordinates && f.coordinates[0] ? [f.coordinates] : [];
  if (f.geometryType === 'MultiPolygon') return (f.coordinates || []).filter((p) => p && p[0]);
  return [];
}
// 点が polygon 群のいずれかの内部（outer 内かつ hole 外）にあるか
function pointInPolys(x, z, polys) {
  for (const poly of polys) {
    if (!pointInRing(x, z, poly[0])) continue;
    let inHole = false;
    for (let h = 1; h < poly.length; h++) if (poly[h] && poly[h].length >= 3 && pointInRing(x, z, poly[h])) { inHole = true; break; }
    if (!inHole) return true;
  }
  return false;
}
function polysBbox(polys) {
  let a = Infinity, b = -Infinity, c = Infinity, d = -Infinity;
  for (const poly of polys) for (const [x, z] of poly[0]) { if (x < a) a = x; if (x > b) b = x; if (z < c) c = z; if (z > d) d = z; }
  return { minX: a, maxX: b, minZ: c, maxZ: d };
}
function* iterTiles(dir) {
  for (const f of fs.readdirSync(dir)) {
    if (!/^tile_-?\d+_-?\d+\.json$/.test(f)) continue;
    yield JSON.parse(readFileRetry(path.join(dir, f)));
  }
}

// ── canonical water / roads を読み、空間ハッシュを作る ──
function loadWater() {
  const feats = [];
  const seen = new Set();
  for (const t of iterTiles(WATER_DIR)) {
    for (const f of (t.features || [])) {
      if (seen.has(f.canonicalId)) continue;
      seen.add(f.canonicalId);
      const polys = toPolys(f);
      if (!polys.length) continue;
      const a = f.attributes || {};
      feats.push({
        id: f.canonicalId, polys, bbox: f.bbox || polysBbox(polys),
        waterClass: a.waterClass || null, name: a.name || null,
        confidence: (f.source && f.source.confidence) != null ? f.source.confidence : null,
      });
    }
  }
  return feats;
}
function loadRoads() {
  const feats = [];
  const seen = new Set();
  for (const t of iterTiles(ROADS_DIR)) {
    for (const f of (t.features || [])) {
      if (seen.has(f.canonicalId)) continue;
      seen.add(f.canonicalId);
      const polys = toPolys(f);
      if (!polys.length) continue;
      const a = f.attributes || {};
      const qf = f.qaFlags || [];
      feats.push({
        id: f.canonicalId, polys, bbox: f.bbox || polysBbox(polys),
        name: a.name || null, highway: a.highway || null, lodClass: a.lodClass || null,
        bridge: !!a.bridge || qf.includes('bridge'),
        tunnel: !!a.tunnel || qf.includes('tunnel'),
        underground: !!a.underground,
        elevated: qf.includes('elevated'),
        layer: a.layer != null ? +a.layer : 0,
        structure: a.plateauStructure || null,
        confidence: (f.source && f.source.confidence) != null ? f.source.confidence : null,
      });
    }
  }
  return feats;
}
function spatialHash(feats) {
  const h = new Map();
  for (const f of feats) {
    const bb = f.bbox;
    for (let cx = Math.floor(bb.minX / HASH_M); cx <= Math.floor(bb.maxX / HASH_M); cx++)
      for (let cz = Math.floor(bb.minZ / HASH_M); cz <= Math.floor(bb.maxZ / HASH_M); cz++) {
        const k = cx + ',' + cz;
        let arr = h.get(k); if (!arr) { arr = []; h.set(k, arr); }
        arr.push(f);
      }
  }
  return h;
}

// ── 31E 分類の building 索引 ──
function loadConflictIndex() {
  const idx = new Map(); // canonicalId → { action, resolvedCause, explanation, cause, conflictId, pairType }
  const add = (rawId, rec) => {
    const cid = 'cg_bldg_' + rawId;
    const prev = idx.get(cid);
    // MANUAL_REVIEW を EXPLAIN より優先（安全側 §4）
    if (!prev || (rec.action === 'MANUAL_REVIEW' && prev.action !== 'MANUAL_REVIEW')) idx.set(cid, rec);
  };
  if (NO_31E) return { idx, olByBuilding: new Map() };
  if (fs.existsSync(RESOLUTION)) {
    const r = JSON.parse(fs.readFileSync(RESOLUTION, 'utf-8'));
    for (const c of (r.conflicts || [])) {
      if (c.pairType !== 'BUILDING_WATER' && c.pairType !== 'BUILDING_ROAD') continue;
      for (const b of (Array.isArray(c.featureB) ? c.featureB : [c.featureB])) {
        if (typeof b !== 'string') continue;
        add(b, {
          action: c.action || null, resolvedCause: c.resolvedCause || null,
          explanation: c.explanation || null, cause: c.cause || null,
          conflictId: c.conflictId || null, pairType: c.pairType,
        });
      }
    }
  }
  // canonical-conflicts-all.json（HIGH/MEDIUM 全件 + INFO サンプル）からも overlap 実測を拾う
  const olByBuilding = new Map(); // canonicalId → { water:{ratio,area}, road:{ratio,area}, conflictIds:Set }
  if (fs.existsSync(CONFLICTS_ALL)) {
    const a = JSON.parse(fs.readFileSync(CONFLICTS_ALL, 'utf-8'));
    for (const c of (a.conflicts || [])) {
      if (c.code !== 'BUILDING_WATER' && c.code !== 'BUILDING_ROAD') continue;
      const kind = c.code === 'BUILDING_WATER' ? 'water' : 'road';
      for (const b of (c.overlapBuildings || [])) {
        if (!b.id) continue;
        const cid = 'cg_bldg_' + b.id;
        const ratio = b.areaM2 ? b.olAreaM2 / b.areaM2 : 0;
        let e = olByBuilding.get(cid);
        if (!e) { e = { water: { ratio: 0, area: 0 }, road: { ratio: 0, area: 0 }, conflictIds: new Set() }; olByBuilding.set(cid, e); }
        if (ratio > e[kind].ratio) e[kind].ratio = ratio;
        if (b.olAreaM2 > e[kind].area) e[kind].area = b.olAreaM2;
        if (c.conflictId) e.conflictIds.add(c.conflictId);
      }
    }
  }
  return { idx, olByBuilding };
}

// ── 建物属性 ──
function loadAttrTile(tx, tz) {
  const p = path.join(ATTR_DIR, `tile_${tx}_${tz}.json`);
  if (!fs.existsSync(p)) return {};
  const t = JSON.parse(fs.readFileSync(p, 'utf-8'));
  // attributes: canonicalId → attr（または配列）
  if (Array.isArray(t.attributes)) {
    const m = {}; for (const a of t.attributes) if (a && a.canonicalId) m[a.canonicalId] = a; return m;
  }
  return t.attributes || {};
}

function overlapRatio(fp, hashW, hashR) {
  const bb = ringBbox(fp);
  const w = Math.max(bb.maxX - bb.minX, SAMPLE_M), h = Math.max(bb.maxZ - bb.minZ, SAMPLE_M);
  let step = SAMPLE_M;
  const est = Math.ceil(w / step + 1) * Math.ceil(h / step + 1);
  if (est > MAX_SAMPLE) step = Math.sqrt((w * h) / MAX_SAMPLE);
  // 候補 water / road
  const candW = new Set(), candR = new Set();
  for (let cx = Math.floor(bb.minX / HASH_M); cx <= Math.floor(bb.maxX / HASH_M); cx++)
    for (let cz = Math.floor(bb.minZ / HASH_M); cz <= Math.floor(bb.maxZ / HASH_M); cz++) {
      for (const f of (hashW.get(cx + ',' + cz) || [])) candW.add(f);
      for (const f of (hashR.get(cx + ',' + cz) || [])) candR.add(f);
    }
  let total = 0, wCells = 0, rCells = 0;
  const wHit = new Map(), rHit = new Map();
  for (let x = bb.minX + step / 2; x <= bb.maxX; x += step) {
    for (let z = bb.minZ + step / 2; z <= bb.maxZ; z += step) {
      if (!pointInRing(x, z, fp)) continue;
      total++;
      let inW = null, inR = null;
      for (const f of candW) if (pointInPolys(x, z, f.polys)) { inW = f; break; }
      for (const f of candR) if (pointInPolys(x, z, f.polys)) { inR = f; break; }
      if (inW) { wCells++; wHit.set(inW, (wHit.get(inW) || 0) + 1); }
      if (inR) { rCells++; rHit.set(inR, (rHit.get(inR) || 0) + 1); }
    }
  }
  if (!total) return null;
  const cellA = step * step;
  const topW = [...wHit.entries()].sort((a, b) => b[1] - a[1])[0];
  const topR = [...rHit.entries()].sort((a, b) => b[1] - a[1])[0];
  return {
    total,
    waterRatio: wCells / total, waterAreaM2: wCells * cellA, water: topW ? topW[0] : null,
    roadRatio: rCells / total, roadAreaM2: rCells * cellA, road: topR ? topR[0] : null,
  };
}

// ── policy 判定（§1〜§6, §17, §18）──
function decide(b, ov, conf, ol) {
  const a = b.attr || {};
  const label = String(a.usageLabel || a.normalizedUsage || '');
  const semanticExempt = EXEMPT_SEMANTIC.test(label);
  const isFallback = a.source === 'osm-building';
  const bConf = a.confidence != null ? a.confidence : (isFallback ? 0.82 : 0.95);

  // 31E を最優先で尊重（§4）
  const c31e = conf.get(b.id);
  if (c31e) {
    if (c31e.action === 'MANUAL_REVIEW') {
      return mk('REVIEW', '31e-manual-review:' + (c31e.resolvedCause || c31e.cause || '?'), ov, c31e.conflictId);
    }
    if (c31e.action === 'EXPLAIN') {
      const cause = c31e.resolvedCause || c31e.explanation || c31e.cause;
      if (EXEMPT_CAUSES.has(cause)) return mk('EXEMPT', '31e-explain:' + cause, ov, c31e.conflictId);
      return mk('DISPLAY', '31e-explain:' + (cause || 'explained'), ov, c31e.conflictId);
    }
    if (c31e.action === 'RECLASSIFY') return mk('DISPLAY', '31e-reclassify', ov, c31e.conflictId);
  }

  const conflictId = ol && ol.conflictIds && ol.conflictIds.size ? [...ol.conflictIds][0] : null;

  // 実在構造の exempt（§2/§3）
  if (semanticExempt && (ov.waterRatio > 0.05 || ov.roadRatio > 0.05)) {
    return mk('EXEMPT', 'semantic-structure:' + label.slice(0, 12), ov, conflictId);
  }
  if (ov.road && ov.roadRatio > 0.05) {
    const r = ov.road;
    if (r.bridge || r.tunnel || r.underground || r.elevated || (r.layer && r.layer !== 0)
      || ['elevated', 'bridge', 'tunnel', 'underpass'].includes(r.structure)) {
      return mk('EXEMPT', 'road-grade-separated:' + (r.structure || (r.bridge ? 'bridge' : r.tunnel ? 'tunnel' : 'layer')), ov, conflictId);
    }
  }
  if (ov.water && (ov.water.waterClass === 'canal' || ov.water.waterClass === 'drainage' || ov.water.waterClass === 'ditch') && ov.waterRatio < 0.6) {
    return mk('EXEMPT', 'over-narrow-waterway:' + ov.water.waterClass, ov, conflictId);
  }

  // ── WATER（§2）──
  if (ov.waterRatio >= TH.WATER_SUPPRESS_RATIO && ov.waterAreaM2 >= TH.WATER_SUPPRESS_AREA) {
    // harbor は港湾構造物が多い → semantic 無しでも慎重に REVIEW
    if (ov.water && ov.water.waterClass === 'harbor') {
      return mk('REVIEW', 'harbor-overlap-needs-evidence', ov, conflictId);
    }
    return mk('SUPPRESS', 'building-major-overlap-with-water', ov, conflictId);
  }
  if (ov.waterRatio >= TH.WATER_REVIEW_RATIO) {
    return mk('REVIEW', 'building-partial-overlap-with-water', ov, conflictId);
  }

  // ── ROAD（§3・31E finding #2 を尊重: tran は舗装より広い）──
  if (ov.roadRatio >= TH.ROAD_SUPPRESS_RATIO && ov.roadAreaM2 >= TH.ROAD_SUPPRESS_AREA) {
    const bArea = b.areaM2 || a.areaM2 || ringAreaM2(b.fp);
    if (bArea > TH.ROAD_SUPPRESS_MAX_AREA) {
      return mk('REVIEW', 'large-building-inside-road-area(polygon-suspect)', ov, conflictId);
    }
    return mk('SUPPRESS', 'building-almost-entirely-inside-road-area', ov, conflictId, { provisional: true });
  }
  if (ov.roadRatio >= TH.ROAD_REVIEW_RATIO) {
    return mk('REVIEW', 'building-mostly-inside-road-area', ov, conflictId);
  }

  // 小さな重なり（§6）
  if (ov.waterRatio > 0 || ov.roadRatio > 0) {
    return mk('DISPLAY', 'boundary-overlap-within-tolerance', ov, conflictId);
  }
  return mk('DISPLAY', 'no-overlap', ov, conflictId);
}
function mk(policy, reason, ov, conflictId, extra) {
  return {
    policy, reason,
    waterOverlapRatio: +(ov.waterRatio || 0).toFixed(3),
    roadOverlapRatio: +(ov.roadRatio || 0).toFixed(3),
    overlapAreaM2: Math.round(Math.max(ov.waterAreaM2 || 0, ov.roadAreaM2 || 0)),
    conflictId: conflictId || null,
    ...(extra || {}),
  };
}

async function main() {
  const generatedAt = new Date().toISOString();
  console.log('[placement] canonical water/roads を読み込み…');
  const water = loadWater();
  const roads = loadRoads();
  const hashW = spatialHash(water);
  const hashR = spatialHash(roads);
  console.log(`  water=${water.length}  roads=${roads.length}`);
  const { idx: conf31e, olByBuilding } = loadConflictIndex();
  console.log(`  31E 索引: ${conf31e.size} 棟, overlap 実測: ${olByBuilding.size} 棟`);

  // [Mission 32N] PLACEMENT_SYNCED_WRITE=1: ディレクトリを消さずに上書き＋読み戻し検証（OneDrive 競合対策）
  const syncedWrite = ENV.PLACEMENT_SYNCED_WRITE === '1';
  const pendingFiles = syncedWrite ? new Map() : null;
  if (!syncedWrite) {
    fs.rmSync(OUT_DIR, { recursive: true, force: true });
    fs.mkdirSync(OUT_DIR, { recursive: true });
  }

  const counts = {
    total: 0, DISPLAY: 0, SUPPRESS: 0, REVIEW: 0, EXEMPT: 0,
    suppressWater: 0, suppressRoad: 0, suppressBoth: 0,
    reviewWater: 0, reviewRoad: 0, exemptSemantic: 0, exemptRoadGrade: 0, exempt31e: 0,
    manualReview31e: 0, provisionalRoadSuppress: 0,
  };
  const byReason = {};
  const dist = { waterRatio: {}, roadRatio: {} };
  const bkt = (x) => x <= 0 ? '0' : x < 0.1 ? '<0.1' : x < 0.3 ? '0.1-0.3' : x < 0.5 ? '0.3-0.5' : x < 0.7 ? '0.5-0.7' : x < 0.9 ? '0.7-0.9' : '>=0.9';
  const perTile = new Map();     // "tx_tz" → { canonicalId: entry }
  const suppressSamples = [];
  const bldgIds = new Set();

  let processed = 0;
  for (const t of iterTiles(BUILD_DIR)) {
    const attrMap = loadAttrTile(t.tx, t.tz);
    for (const f of (t.features || [])) {
      counts.total++;
      bldgIds.add(f.canonicalId);
      processed++;
      if (processed % 50000 === 0) console.log(`  …${processed} 棟`);
      const fp = f.geometryType === 'Polygon' ? f.coordinates[0] : (f.coordinates[0] && f.coordinates[0][0]);
      if (!Array.isArray(fp) || fp.length < 3) { counts.DISPLAY++; continue; }
      const b = { id: f.canonicalId, fp, attr: attrMap[f.canonicalId] || {}, areaM2: f.areaM2 != null ? f.areaM2 : ringAreaM2(fp) };

      const ov = overlapRatio(fp, hashW, hashR) || { waterRatio: 0, roadRatio: 0, waterAreaM2: 0, roadAreaM2: 0, water: null, road: null, total: 0 };
      dist.waterRatio[bkt(ov.waterRatio)] = (dist.waterRatio[bkt(ov.waterRatio)] || 0) + 1;
      dist.roadRatio[bkt(ov.roadRatio)] = (dist.roadRatio[bkt(ov.roadRatio)] || 0) + 1;

      const ol = olByBuilding.get(f.canonicalId);
      const d = decide(b, ov, conf31e, ol);
      counts[d.policy]++;
      byReason[d.reason.split(':')[0]] = (byReason[d.reason.split(':')[0]] || 0) + 1;

      if (d.policy === 'SUPPRESS') {
        const w = d.waterOverlapRatio >= TH.WATER_SUPPRESS_RATIO;
        const r = d.roadOverlapRatio >= TH.ROAD_SUPPRESS_RATIO;
        if (w && r) counts.suppressBoth++; else if (w) counts.suppressWater++; else if (r) counts.suppressRoad++;
        if (d.provisional) counts.provisionalRoadSuppress++;
        if (suppressSamples.length < 60) suppressSamples.push({ canonicalId: f.canonicalId, ...d, ward: (b.attr || {}).wardId || null, usageLabel: (b.attr || {}).usageLabel || null, areaM2: Math.round((b.attr || {}).areaM2 || ringAreaM2(fp)) });
      } else if (d.policy === 'REVIEW') {
        if (d.reason.startsWith('31e-manual-review')) counts.manualReview31e++;
        if (d.waterOverlapRatio >= TH.WATER_REVIEW_RATIO) counts.reviewWater++; else counts.reviewRoad++;
      } else if (d.policy === 'EXEMPT') {
        if (d.reason.startsWith('semantic')) counts.exemptSemantic++;
        else if (d.reason.startsWith('road-grade')) counts.exemptRoadGrade++;
        else if (d.reason.startsWith('31e')) counts.exempt31e++;
      }

      if (d.policy !== 'DISPLAY') {
        const key = t.tx + '_' + t.tz;
        let pt = perTile.get(key); if (!pt) { pt = {}; perTile.set(key, pt); }
        pt[f.canonicalId] = d;
      }
    }
  }

  // ── §16: road provisional SUPPRESS が過大なら REVIEW へ降格 ──
  const cap = Math.round(counts.total * TH.ROAD_SUPPRESS_CAP_FRAC);
  let roadDowngraded = 0;
  if (counts.suppressRoad > cap) {
    for (const [, pt] of perTile) for (const id in pt) {
      const e = pt[id];
      if (e.policy === 'SUPPRESS' && e.provisional) {
        e.policy = 'REVIEW'; e.reason = 'road-suppress-over-cap-downgraded(§16)'; roadDowngraded++;
      }
    }
    counts.SUPPRESS -= roadDowngraded; counts.REVIEW += roadDowngraded;
    counts.suppressRoad -= roadDowngraded; counts.reviewRoad += roadDowngraded;
  }

  // ── tile 書き出し ──
  const tiles = [];
  for (const [key, pt] of perTile) {
    const [tx, tz] = key.split('_').map(Number);
    const file = `tile_${tx}_${tz}.json`;
    const body = JSON.stringify({ tx, tz, tileSize: TILE, generatedAt, policies: pt });
    if (pendingFiles) pendingFiles.set(file, body); else fs.writeFileSync(path.join(OUT_DIR, file), body);
    tiles.push({ tx, tz, file, count: Object.keys(pt).length });
  }
  const manifest = {
    version: 1, kind: 'building-placement-policy', generatedAt, tileSize: TILE,
    canonicalBuildingCount: counts.total,
    policyCounts: { DISPLAY: counts.DISPLAY, SUPPRESS: counts.SUPPRESS, REVIEW: counts.REVIEW, EXEMPT: counts.EXEMPT },
    thresholds: TH,
    note: 'DISPLAY は既定。tile には SUPPRESS/REVIEW/EXEMPT のみ収録。source / canonical geometry は不変（§0/§11）。',
    tiles: tiles.sort((a, b) => a.tx - b.tx || a.tz - b.tz),
  };
  if (pendingFiles) {
    pendingFiles.set('manifest.json', JSON.stringify(manifest, null, 2));
    writeFilesVerified(OUT_DIR, pendingFiles, { label: 'building-placement' });
  } else {
    fs.writeFileSync(path.join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));
  }

  const report = {
    generatedAt,
    inputs: {
      canonicalBuildings: counts.total, canonicalWater: water.length, canonicalRoads: roads.length,
      conflictResolutionEntries: conf31e.size,
    },
    thresholds: TH,
    thresholdRationale: {
      water: 'footprint の 60%+ が canonical 水面内 かつ 20m²+ を SUPPRESS。30–60% は REVIEW（推測で消さない §4/§6）。harbor は REVIEW 止まり。',
      road: '31E systematic finding #2（PLATEAU tran 道路区域面は実舗装より広い＝都市計画決定幅）を尊重。'
        + '道路 polygon への部分的な重なりは正常として DISPLAY。footprint の 97%+ が道路区域内 かつ 1200m² 未満 の時だけ暫定 SUPPRESS。'
        + `SUPPRESS が総棟数の ${TH.ROAD_SUPPRESS_CAP_FRAC * 100}% を超えたら road 側を REVIEW へ降格（§16）。`,
    },
    distributionByRatio: dist,
    policyCounts: manifest.policyCounts,
    detailCounts: counts,
    roadProvisionalDowngraded: roadDowngraded,
    byReasonGroup: byReason,
    suppressSamples,
    placementTilesWritten: tiles.length,
    sourceGeometryMutated: false,
    RESULT: (counts.total > 600000 && counts.SUPPRESS < counts.total * 0.02) ? 'PASS' : 'CHECK',
  };
  await writeJson(REPORT, report);

  console.log('[placement] policy 集計:', JSON.stringify(manifest.policyCounts));
  console.log('  detail:', JSON.stringify({
    suppressWater: counts.suppressWater, suppressRoad: counts.suppressRoad, suppressBoth: counts.suppressBoth,
    reviewWater: counts.reviewWater, reviewRoad: counts.reviewRoad,
    exemptSemantic: counts.exemptSemantic, exemptRoadGrade: counts.exemptRoadGrade, exempt31e: counts.exempt31e,
    manualReview31e: counts.manualReview31e, roadDowngraded,
  }));
  console.log('  tiles:', tiles.length, ' 保存:', toProjectRelativePath(REPORT), ' RESULT:', report.RESULT);
}

export { pointInRing, pointInPolys, toPolys, decide, TH, EXEMPT_SEMANTIC, EXEMPT_CAUSES };

import { isMainModule } from './lib/paths.js';
if (isMainModule(import.meta.url)) {
  main().catch((e) => { console.error('[placement] 失敗:', e && e.stack || e); process.exit(1); });
}
