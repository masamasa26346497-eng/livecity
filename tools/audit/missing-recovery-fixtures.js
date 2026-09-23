#!/usr/bin/env node
// tools/audit/missing-recovery-fixtures.js
// [Mission 35D §4/§9] ユーザーが挙げた代表ケースが、いまどの building set に入っているかを
//   1 棟ずつ確かめる。**ハードコードで足すためではなく、QA の観点として**見る（§4）。
//
//   見るもの: 現在の表示（V2N）/ 34C の V3 / 35D で作り直す V4
//   名前で拾えないものは地点（anchor）まわりの OSM 建物も見る。
//   出力: data/reports/missing-recovery-fixtures.json
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, isMainModule } from '../lib/paths.js';
import { M, pointInRing, bboxIoU } from './citywide-missing-buildings.js';
import { ringBbox, ringCentroid } from '../lib/osm-building-fallback.js';
import { latLonToLiveCityWorld } from '../lib/livecity-coordinate-system.js';

const P = (...s) => resolveProjectPath(path.join(...s));
export const FX = {
  scanCache: M.scanCache,
  candidates: M.candidates,
  v2n: P('data', 'processed', 'osaka-city', 'canonical', 'buildings-v2-osmv2'),
  v3: P('data', 'processed', 'osaka-city', 'canonical', 'buildings-v2-osmv3'),
  v4: P('data', 'processed', 'osaka-city', 'canonical', 'buildings-v4-final'),
  out: P('data', 'reports', 'missing-recovery-fixtures.json'),
};

/**
 * §4 必須確認対象。ハードコード追加の指示ではなく QA 対象。
 * anchor は緯度経度で書く（world 座標を手で写すと取り違える。実際に 500m ずれた）。
 * 変換は tools/lib/livecity-coordinate-system.js の正本を使う。
 */
export const FIXTURES = [
  { id: 'brillia-tower-dojima', label: 'ブリリアタワー堂島', ward: 'kita',
    patterns: [/ブリリアタワー/, /Brillia\s*Tower/i], anchor: { lat: 34.69466, lon: 135.49236, radiusM: 260 } },
  { id: 'grand-green-osaka', label: 'グラングリーン大阪', ward: 'kita',
    patterns: [/グラングリーン/, /GRAND\s*GREEN/i], anchor: { lat: 34.70430, lon: 135.49170, radiusM: 500 } },
  { id: 'osaka-station', label: '大阪駅・大阪ステーションシティ', ward: 'kita',
    patterns: [/大阪ステーションシティ/, /ノースゲート/, /サウスゲート/, /JPタワー大阪/], anchor: { lat: 34.70254, lon: 135.49586, radiusM: 400 } },
  { id: 'nakanoshima', label: '中之島', ward: 'kita',
    patterns: [/中之島フェスティバルタワー/, /中之島三井ビルディング/, /中之島ダイビル/], anchor: { lat: 34.69340, lon: 135.49150, radiusM: 500 } },
  { id: 'honmachi', label: '本町', ward: 'chuo',
    patterns: [/本町ガーデンシティ/, /御堂筋ダイビル/, /本町南ガーデンシティ/], anchor: { lat: 34.68200, lon: 135.50060, radiusM: 400 } },
  { id: 'namba', label: '難波', ward: 'naniwa',
    patterns: [/なんばパークス/, /なんばスカイオ/, /なんばCITY/], anchor: { lat: 34.66200, lon: 135.50200, radiusM: 400 } },
  { id: 'tennoji', label: '天王寺', ward: 'abeno',
    patterns: [/あべのハルカス/, /あべのキューズモール/], anchor: { lat: 34.64600, lon: 135.51400, radiusM: 500 } },
  { id: 'sumiyoshi', label: '住吉', ward: 'sumiyoshi',
    patterns: [/住吉大社/, /住吉区役所/], anchor: { lat: 34.61300, lon: 135.49400, radiusM: 700 } },
  { id: 'higashiyodogawa', label: '東淀川', ward: 'higashiyodogawa',
    patterns: [/東淀川区役所/, /淡路駅/], anchor: { lat: 34.73600, lon: 135.53400, radiusM: 900 } },
];

const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };

/** canonical タイル群から canonicalId の集合を作る。 */
export function loadCanonicalIds(dir) {
  const ids = new Set();
  if (!fs.existsSync(dir)) return null;
  for (const f of fs.readdirSync(dir)) {
    if (!/^tile_.*\.json$/.test(f)) continue;
    for (const ft of ((rj(path.join(dir, f)) || {}).features || [])) ids.add(ft.canonicalId);
  }
  return ids;
}

/** anchor の緯度経度を world 座標へ。 */
export function anchorWorld(anchor) {
  const w = latLonToLiveCityWorld(anchor.lat, anchor.lon);
  return { x: w.x, z: w.z };
}

/** その OSM 建物が fixture に該当するか（名前 or 地点）。 */
export function matchFixture(b, fx) {
  const nm = (b.tags && b.tags.name) || '';
  if (nm && fx.patterns.some((p) => p.test(nm))) return 'name';
  if (fx.anchor) {
    const a = anchorWorld(fx.anchor);
    const c = ringCentroid(b.ring);
    if (Math.hypot(c[0] - a.x, c[1] - a.z) <= fx.anchor.radiusM) return 'anchor';
  }
  return null;
}

export function run() {
  const t0 = Date.now();
  const scan = rj(FX.scanCache);
  if (!scan) throw new Error('先に tools/audit/citywide-missing-buildings.js を実行する');
  const cand = rj(FX.candidates);
  const candById = new Map(((cand && cand.candidates) || []).map((c) => [c.canonicalId, c]));

  const sets = {};
  for (const [k, dir] of [['V2N', FX.v2n], ['V3', FX.v3], ['V4', FX.v4]]) {
    const ids = loadCanonicalIds(dir);
    sets[k] = ids;
    console.log('[fx]', k, ids ? ids.size + ' 棟' : '（未作成）');
  }

  const results = [];
  for (const fx of FIXTURES) {
    const hits = [];
    for (const b of scan.buildings) {
      const how = matchFixture(b, fx);
      if (!how) continue;
      const cid = 'cg_bldg_osm_' + b.wayId;
      const c = candById.get(cid);
      hits.push({
        wayId: b.wayId, canonicalId: cid, matchedBy: how,
        name: (b.tags && b.tags.name) || null, building: b.tags && b.tags.building,
        levels: (b.tags && b.tags['building:levels']) || null,
        areaM2: b.area, wardId: b.wardId,
        inV2N: sets.V2N ? sets.V2N.has(cid) : null,
        inV3: sets.V3 ? sets.V3.has(cid) : null,
        inV4: sets.V4 ? sets.V4.has(cid) : null,
        // 表示されていない理由（候補に上がっているか、上がっていないならなぜか）
        isCandidate: !!c,
        cls: c ? c.cls : null, rule: c ? c.rule : null,
        metrics: c ? c.metrics : null,
      });
    }
    // 名前一致を先に、次に面積の大きい順
    hits.sort((a, b) => (a.matchedBy === b.matchedBy ? b.areaM2 - a.areaM2 : (a.matchedBy === 'name' ? -1 : 1)));
    const named = hits.filter((h) => h.matchedBy === 'name');
    // OSM の canonicalId が final set に無くても「表示されていない」とは限らない。
    //   PLATEAU 側に同じ建物があれば重複判定で候補から外れており、PLATEAU として表示されている。
    //   候補に上がっているものだけが「今 表示されていない棟」である。
    const missingNow = hits.filter((h) => h.isCandidate && !h.inV2N);
    const recoveredV4 = sets.V4 ? missingNow.filter((h) => h.inV4) : [];
    const coveredByPlateau = hits.filter((h) => !h.isCandidate && !h.inV2N);
    // 地点まわりで一番階数の多い棟（その街区の主役。ブリリアのように無名のことがある）
    const tallest = hits.slice().sort((a, b) => (Number(b.levels) || 0) - (Number(a.levels) || 0))[0] || null;
    const summary = {
      osmBuildings: hits.length, namedHits: named.length,
      displayedNowV2N: hits.filter((h) => h.inV2N).length,
      displayedV3: sets.V3 ? hits.filter((h) => h.inV3).length : null,
      displayedV4: sets.V4 ? hits.filter((h) => h.inV4).length : null,
      recoverableCandidates: hits.filter((h) => h.isCandidate).length,
      coveredByPlateau: coveredByPlateau.length,
      missingNow: missingNow.length,
      recoveredInV4: sets.V4 ? recoveredV4.length : null,
      missingAfterV4: sets.V4 ? missingNow.length - recoveredV4.length : null,
      tallest: tallest ? { canonicalId: tallest.canonicalId, name: tallest.name,
        levels: tallest.levels, areaM2: tallest.areaM2,
        displayedNow: tallest.inV2N || !tallest.isCandidate, inV4: tallest.inV4 } : null,
    };
    results.push({ ...fx, anchorWorld: fx.anchor ? anchorWorld(fx.anchor) : null,
      patterns: fx.patterns.map(String), summary, hits: hits.slice(0, 60) });
    console.log('[fx]', fx.id.padEnd(24), JSON.stringify(summary));
  }

  const out = { version: 1, generatedAt: new Date().toISOString(), missionId: '35D',
    sets: Object.fromEntries(Object.entries(sets).map(([k, v]) => [k, v ? v.size : null])),
    fixtures: results,
    totals: {
      missingNow: results.reduce((a, r) => a + r.summary.missingNow, 0),
      recoveredInV4: sets.V4 ? results.reduce((a, r) => a + (r.summary.recoveredInV4 || 0), 0) : null,
      missingAfterV4: sets.V4 ? results.reduce((a, r) => a + (r.summary.missingAfterV4 || 0), 0) : null,
      // 後方互換（validator が参照している名前）
      namedMissingNow: results.reduce((a, r) => a + r.summary.missingNow, 0),
      namedRecoveredInV4: sets.V4 ? results.reduce((a, r) => a + (r.summary.recoveredInV4 || 0), 0) : null,
    },
    elapsedMs: Date.now() - t0 };
  fs.mkdirSync(path.dirname(FX.out), { recursive: true });
  fs.writeFileSync(FX.out, JSON.stringify(out, null, 2));
  return out;
}

if (isMainModule(import.meta.url)) {
  const o = run();
  console.log('[fx] 代表地点で今 表示されていない棟', o.totals.missingNow,
    '→ V4 で回収', o.totals.recoveredInV4 == null ? '（V4 未作成）' : o.totals.recoveredInV4,
    '/ 残り', o.totals.missingAfterV4);
  for (const r of o.fixtures) {
    const t = r.summary.tallest;
    console.log('   ', r.id.padEnd(24), '最高層:', t ? ((t.name || '(無名)') + ' ' + (t.levels || '?') + '階 → ' + (t.inV4 ? 'V4 で表示' : t.displayedNow ? '既に表示' : '未表示')) : '-');
  }
  console.log('[fx] out', FX.out);
}
