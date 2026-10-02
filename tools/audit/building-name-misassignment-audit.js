#!/usr/bin/env node
// tools/audit/building-name-misassignment-audit.js
// [Mission 35O §17] 誤付与の監査。ランダムではなく **間違えやすいところ** を重点的に見る。
//
//   見る対象（§17）:
//     高密度地域 / 隣接建物が非常に近い場所 / 巨大商業施設 / 駅ビル /
//     タワーマンション / 学校キャンパス / 病院 / 寺社 / 複合施設
//
//   「目視」の代わりに、**根拠を機械的に再計算**して検証する:
//     - 付けた名前の OSM 元図形を取り直し、その建物と本当に重なっているか
//     - 隣に「もっと重なっている建物」が無いか（取り違えの検出）
//     - 店舗 POI を建物名に昇格させていないか
//     - 名前と建物の距離
//   これに加えて、目視用のサンプル一覧（名前・位置・根拠）を出す。
//
//   出力: data/reports/building-name-misassignment-audit.json
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, isMainModule } from '../lib/paths.js';
import { overlapRatio, ringBbox, bboxOverlap, WHOLE_BUILDING_CATEGORIES, MATCH } from '../lib/building-facility-match.js';
import { loadBuildings, collectOsmNamed, SRC as BUILD_SRC } from '../build-building-facility-index.js';

const P = (...s) => resolveProjectPath(path.join(...s));
export const SRC = {
  index: P('data', 'processed', 'osaka-city', 'derived', 'building-facility-index.json'),
  wardPolys: P('data', 'processed', 'osaka-city', 'boundaries', 'ward-classification-polygons.json'),
};
export const OUT = P('data', 'reports', 'building-name-misassignment-audit.json');

/** §17 最低 50 件。ここでは各カテゴリから均等に拾って 60 件見る。 */
export const SAMPLE_TARGET = 60;

/** 重点的に見る場面。名前ではなく **属性と形** で選ぶ。 */
export const FOCUS = [
  { id: 'tower', label: 'タワーマンション・超高層', pick: (r) => (r.h || 0) >= 80 },
  { id: 'large-commercial', label: '巨大商業施設', pick: (r) => r.areaM2 >= 9000 },
  { id: 'campus', label: '学校キャンパス', pick: (r) => /学校|学園|大学|高校|中学|小学/.test(r.buildingName || '') },
  { id: 'hospital', label: '病院', pick: (r) => /病院|医療センター|クリニック/.test(r.buildingName || r.primaryFacilityName || '') },
  { id: 'worship', label: '寺社', pick: (r) => /神社|大社|寺|八幡|稲荷|御堂/.test(r.buildingName || r.primaryFacilityName || '') },
  { id: 'multi-tenant', label: '複合施設（テナント多数）', pick: (r) => (r.facilityCount || 0) >= 10 },
  { id: 'station-building', label: '駅ビル周辺', pick: (r) => /駅|ステーション|ターミナル/.test(r.buildingName || '') },
  { id: 'dense', label: '高密度・隣接建物が近い', pick: (r) => r.areaM2 <= 220 && (r.facilityCount || 0) > 0 },
];

const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };

export async function run() {
  const t0 = Date.now();
  const doc = rj(SRC.index);
  if (!doc) throw new Error('building-facility-index.json が無い');
  const recs = (doc.buildings || []).filter((r) => r.buildingName || r.primaryFacilityName);

  // 建物と OSM をもう一度読み直して、根拠を独立に計算する
  const buildings = loadBuildings(BUILD_SRC.buildings);
  const byId = new Map(buildings.map((b) => [b.id, b]));
  const wardPolys = (rj(SRC.wardPolys) || {}).wards || [];
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const w of wardPolys) {
    const b = w.bbox; if (!b) continue;
    if (b.minX < minX) minX = b.minX; if (b.maxX > maxX) maxX = b.maxX;
    if (b.minZ < minZ) minZ = b.minZ; if (b.maxZ > maxZ) maxZ = b.maxZ;
  }
  const bbox = { minX: minX - 300, maxX: maxX + 300, minZ: minZ - 300, maxZ: maxZ + 300 };
  const file = fs.existsSync(BUILD_SRC.pbfWide) ? BUILD_SRC.pbfWide : BUILD_SRC.pbfOld;
  console.log('[35O-audit] OSM を読み直して根拠を再計算する…');
  const { ways } = await collectOsmNamed(file, bbox);
  const wayById = new Map(ways.map((w) => [w.osmId, w]));

  // 近傍の建物を引くための格子
  const CELL = 120;
  const grid = new Map();
  for (const b of buildings) {
    for (let i = Math.floor(b.bbox.minX / CELL); i <= Math.floor(b.bbox.maxX / CELL); i++) {
      for (let j = Math.floor(b.bbox.minZ / CELL); j <= Math.floor(b.bbox.maxZ / CELL); j++) {
        const k = i + ':' + j;
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k).push(b);
      }
    }
  }

  // ── サンプル選定 ────────────────────────────────────────────────
  const perFocus = Math.ceil(SAMPLE_TARGET / FOCUS.length);
  const chosen = new Map();
  const focusOf = new Map();
  for (const f of FOCUS) {
    const pool = recs.filter((r) => f.pick(r));
    // 決定論に選ぶ（毎回同じサンプルを見る）。名前順で等間隔。
    pool.sort((a, b) => String(a.buildingId).localeCompare(String(b.buildingId)));
    const step = Math.max(1, Math.floor(pool.length / perFocus));
    for (let i = 0, n = 0; i < pool.length && n < perFocus; i += step, n++) {
      if (chosen.has(pool[i].buildingId)) continue;
      chosen.set(pool[i].buildingId, pool[i]);
      focusOf.set(pool[i].buildingId, f.id);
    }
  }

  // ── 根拠の再計算 ────────────────────────────────────────────────
  const samples = [];
  let wrong = 0, suspicious = 0;
  for (const r of chosen.values()) {
    const b = byId.get(r.buildingId);
    const w = wayById.get(r.sourceId);
    const s = {
      focus: focusOf.get(r.buildingId),
      buildingId: r.buildingId,
      name: r.buildingName || r.primaryFacilityName,
      isBuildingName: !!r.buildingName,
      matchMethod: r.matchMethod, confidence: r.confidence, sourceId: r.sourceId,
      h: r.h, areaM2: r.areaM2, facilityCount: r.facilityCount || 0,
      x: r.x, z: r.z,
      verdict: 'ok', reasons: [],
    };
    if (!b) { s.verdict = 'wrong'; s.reasons.push('建物が見つからない'); wrong++; samples.push(s); continue; }

    if (r.matchMethod === 'poi-inside-building') {
      // §4-C 建物名に昇格してよい種別か
      const cat = (r.facilities && r.facilities[0] && r.facilities[0].category) || null;
      s.category = cat;
      if (r.buildingName) { s.verdict = 'wrong'; s.reasons.push('POI を buildingName に昇格させている'); wrong++; }
      else if (cat && !WHOLE_BUILDING_CATEGORIES.has(cat)) {
        s.verdict = 'wrong'; s.reasons.push('建物全体とみなせない種別を primaryFacilityName にしている: ' + cat); wrong++;
      }
      samples.push(s);
      continue;
    }

    if (!w) { s.verdict = 'suspicious'; s.reasons.push('OSM の元図形を引き直せない'); suspicious++; samples.push(s); continue; }
    // 1) 本当に重なっているか
    const o = overlapRatio(b.ring, w.ring);
    s.overlapRatio = +o.ratioOfA.toFixed(3);
    s.distM = +Math.hypot(w.cx - b.cx, w.cz - b.cz).toFixed(1);
    const need = r.matchMethod === 'building-polygon-self' ? MATCH.BUILDING_SELF_OVERLAP : MATCH.FACILITY_COVERS_BUILDING;
    if (o.ratioOfA < need) { s.verdict = 'wrong'; s.reasons.push(`重なりが足りない ${s.overlapRatio} < ${need}`); wrong++; samples.push(s); continue; }

    // 2) 隣にもっと重なっている建物が無いか（取り違え）
    let better = null;
    const cand = new Map();
    for (let i = Math.floor(w.bbox.minX / CELL); i <= Math.floor(w.bbox.maxX / CELL); i++) {
      for (let j = Math.floor(w.bbox.minZ / CELL); j <= Math.floor(w.bbox.maxZ / CELL); j++) {
        for (const o2 of (grid.get(i + ':' + j) || [])) cand.set(o2.id, o2);
      }
    }
    for (const c of cand.values()) {
      if (c.id === b.id) continue;
      if (!bboxOverlap(c.bbox, w.bbox)) continue;
      const oc = overlapRatio(c.ring, w.ring);
      if (oc.ratioOfA > o.ratioOfA + 0.15) { better = { id: c.id, ratio: +oc.ratioOfA.toFixed(3) }; break; }
    }
    if (better) {
      // 同名の別棟（敷地内の複数棟）なら誤付与ではない
      s.verdict = 'suspicious';
      s.reasons.push('より重なる建物がある（敷地内の別棟の可能性）: ' + better.id + ' ' + better.ratio);
      s.betterCandidate = better;
      suspicious++;
    }
    samples.push(s);
  }

  const byFocus = {};
  for (const s of samples) {
    byFocus[s.focus] = byFocus[s.focus] || { n: 0, wrong: 0, suspicious: 0 };
    byFocus[s.focus].n++;
    if (s.verdict === 'wrong') byFocus[s.focus].wrong++;
    if (s.verdict === 'suspicious') byFocus[s.focus].suspicious++;
  }

  const report = {
    version: 1, generatedAt: new Date().toISOString(), missionId: '35O',
    method: '間違えやすい場面からサンプルを決定論に選び、OSM の元図形を読み直して重なりを再計算した。'
      + '「より重なる建物が隣にある」ものは敷etc内の別棟の可能性があるため suspicious として分けている。',
    sampled: samples.length,
    wrong, suspicious,
    wrongRatePct: +(100 * wrong / Math.max(1, samples.length)).toFixed(2),
    suspiciousRatePct: +(100 * suspicious / Math.max(1, samples.length)).toFixed(2),
    byFocus,
    samples,
    elapsedMs: Date.now() - t0,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  return report;
}

if (isMainModule(import.meta.url)) {
  run().then((r) => {
    console.log('[35O-audit] 監査', r.sampled, '件 / 誤付与', r.wrong, `(${r.wrongRatePct}%)`,
      '/ 要確認', r.suspicious, `(${r.suspiciousRatePct}%)`);
    for (const [k, v] of Object.entries(r.byFocus)) console.log('   ', k.padEnd(20), v.n, 'wrong', v.wrong, 'susp', v.suspicious);
    console.log('[35O-audit] out', OUT);
  }).catch((e) => { console.error(e); process.exitCode = 1; });
}
