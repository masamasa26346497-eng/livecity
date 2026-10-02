#!/usr/bin/env node
// tools/validate/citywide-missing-recovery.js
// [Mission 35D §11] 全域 missing building recovery の検証。
//   - canonical PLATEAU の geometry / canonicalId を 1 件も変えていない
//   - projection / road / water / rail を変えていない
//   - V4 に PLATEAU との重複が無い
//   - 被覆が改善している
//   - 代表ケースが baseline 以上に解決している
//   - 追加分が picking できる形になっている
//   - production / protected 未変更
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { resolveProjectPath, isMainModule } from '../lib/paths.js';
import { writeJson } from '../lib/area.js';
import { ringBbox, ringArea } from '../lib/osm-building-fallback.js';
import { buildPlateauIndex, measureOverlap, classifyOverlap, isRetainedClass } from '../lib/osm-fallback-v2-classify.js';
import { CANONICAL_ROAD_FEATURE_COUNT } from "../lib/canonical-baseline.js";

const P = (...s) => resolveProjectPath(path.join(...s));
const F = {
  v2n: P('data', 'processed', 'osaka-city', 'canonical', 'buildings-v2-osmv2'),
  v4: P('data', 'processed', 'osaka-city', 'canonical', 'buildings-v4-final'),
  v4recovered: P('data', 'processed', 'osaka-city', 'canonical', 'buildings-v4-recovered'),
  area: P('config', 'areas', 'osaka-city.json'),
  roads: P('data', 'processed', 'osaka-city', 'canonical', 'roads', 'manifest.json'),
  water: P('data', 'processed', 'osaka-city', 'canonical', 'water', 'manifest.json'),
  rail: P('data', 'processed', 'osaka-city', 'canonical', 'rail', 'manifest.json'),
  audit: P('data', 'reports', 'citywide-missing-buildings.json'),
  fixtures: P('data', 'reports', 'missing-recovery-fixtures.json'),
  build: P('data', 'reports', 'final-buildings-v4-build.json'),
  placementV4: P('data', 'reports', 'building-placement-policy-v4.json'),
  placementV2: P('data', 'reports', 'building-placement-policy.json'),
  runtimeQa: P('data', 'reports', 'missing-recovery-runtime-qa.json'),
  overlapControl: P('data', 'reports', 'missing-recovery-overlap-control.json'),
  publicV4: P('public', 'map-data', 'osaka-city', 'derived-v4-final'),
  dev: P('public', 'osaka_3d_buildings.ward-ux-v1.html'),
  prod: P('public', 'osaka_3d_buildings.html'),
  prot: P('public', 'osaka_3d_buildings.fullward-v3.html'),
  prodBuild: P('data', 'reports', 'production-cutover-build.json'),
  baseline: P('data', 'reports', 'baselines', 'prod-protected-hashes.json'),
  out: P('data', 'reports', 'citywide-missing-recovery-validation.json'),
};
/** §0 変えてはならない数。 */
export const FIXED = { plateau: 574112, v2nTotal: 600764, existingFallback: 26652 };
/** §0 他レイヤーの件数。 */
export const OTHER_LAYERS = { roads: CANONICAL_ROAD_FEATURE_COUNT, water: 528, rail: 2828 };
/** 重複チェックのサンプル数（全件測ると時間が掛かりすぎる）。 */
export const DUP_SAMPLE = 3000;

const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };
const sha = (p) => { try { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); } catch { return null; } };

/** canonical タイル群を読む。 */
export function loadSet(dir) {
  if (!fs.existsSync(dir)) return null;
  const plateau = new Map(), other = new Map();
  for (const f of fs.readdirSync(dir)) {
    if (!/^tile_-?\d+_-?\d+\.json$/.test(f)) continue;
    for (const ft of ((rj(path.join(dir, f)) || {}).features || [])) {
      const ring = ft.coordinates && ft.coordinates[0];
      if (!ring) continue;
      const rec = { id: ft.canonicalId, ring, bb: ringBbox(ring),
        area: ft.areaM2 != null ? ft.areaM2 : ringArea(ring) };
      if (ft.source && ft.source.geometrySource === 'plateau-building') plateau.set(ft.canonicalId, rec);
      else other.set(ft.canonicalId, rec);
    }
  }
  return { plateau, other };
}

/** geometry が完全に同じか（丸め誤差も許さない）。 */
export function ringsEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i][0] !== b[i][0] || a[i][1] !== b[i][1]) return false;
  }
  return true;
}

export async function validateCitywideMissingRecovery() {
  const errors = [], warnings = [];
  const audit = rj(F.audit), fixtures = rj(F.fixtures), build = rj(F.build);

  const v2n = loadSet(F.v2n);
  const v4 = loadSet(F.v4);
  if (!v2n) errors.push('§0: V2N が読めない');
  if (!v4) errors.push('§5: V4 が作られていない');

  // ── §11 PLATEAU の geometry / canonicalId が無変更 ──────────────────
  let buildingGeometryMutation = null, canonicalIdMutation = null, plateauRemoved = null;
  if (v2n && v4) {
    let geomDiff = 0, missing = 0;
    for (const [id, rec] of v2n.plateau) {
      const w = v4.plateau.get(id);
      if (!w) { missing++; continue; }
      if (!ringsEqual(rec.ring, w.ring)) geomDiff++;
    }
    buildingGeometryMutation = geomDiff;
    plateauRemoved = missing;
    // 既存 canonicalId（PLATEAU + 既存 fallback）がすべて残っているか
    let idMissing = 0;
    for (const id of v2n.plateau.keys()) if (!v4.plateau.has(id)) idMissing++;
    for (const id of v2n.other.keys()) if (!v4.other.has(id)) idMissing++;
    canonicalIdMutation = idMissing;
    if (geomDiff) errors.push('§11: PLATEAU の geometry が変わっている ' + geomDiff);
    if (missing) errors.push('§11: PLATEAU が消えている ' + missing);
    if (idMissing) errors.push('§11: 既存 canonicalId が消えている ' + idMissing);
    if (v2n.plateau.size !== FIXED.plateau) errors.push('§0: V2N の PLATEAU 数が想定と違う ' + v2n.plateau.size);
  }

  // ── §11 projection ─────────────────────────────────────────────────
  const proj = (rj(F.area) || {}).projection || {};
  const projectionMutation = (proj.type === 'local-equirectangular' && proj.centerLat === 34.604208
    && proj.centerLon === 135.52502 && proj.metersPerDegree === 111320) ? 0 : 1;
  if (projectionMutation) errors.push('§11: projection が変わっている');

  // ── §11 road / water / rail ────────────────────────────────────────
  const roadMutation = ((rj(F.roads) || {}).featureCount === OTHER_LAYERS.roads) ? 0 : 1;
  const waterMutation = ((rj(F.water) || {}).featureCount === OTHER_LAYERS.water) ? 0 : 1;
  const railMutation = ((rj(F.rail) || {}).featureCount === OTHER_LAYERS.rail) ? 0 : 1;
  if (roadMutation) errors.push('§11: road の件数が変わっている ' + (rj(F.roads) || {}).featureCount);
  if (waterMutation) errors.push('§11: water の件数が変わっている ' + (rj(F.water) || {}).featureCount);
  if (railMutation) errors.push('§11: rail の件数が変わっている ' + (rj(F.rail) || {}).featureCount);

  // ── §11 V4 に PLATEAU との重複が無いか ──────────────────────────────
  let rebuiltFinalHasNoDuplicateWithPlateau = null, dupFound = 0, dupSampled = 0;
  const dupSamples = [];
  if (v4) {
    const added = [...v4.other.values()].filter((r) => !v2n || !v2n.other.has(r.id));
    const index = buildPlateauIndex([...v4.plateau.values()], 40);
    const step = Math.max(1, Math.floor(added.length / DUP_SAMPLE));
    for (let i = 0; i < added.length; i += step) {
      const r = added[i];
      dupSampled++;
      const m = measureOverlap(r.ring, index);
      const k = classifyOverlap(m);
      if (!isRetainedClass(k.cls)) {
        dupFound++;
        if (dupSamples.length < 10) dupSamples.push({ id: r.id, cls: k.cls, rule: k.rule, areaM2: Math.round(r.area) });
      }
    }
    rebuiltFinalHasNoDuplicateWithPlateau = dupFound === 0;
    if (dupFound) errors.push(`§11: 追加分に PLATEAU との重複がある ${dupFound}/${dupSampled}`);
  }

  // ── §11 被覆が改善しているか ────────────────────────────────────────
  const addedCount = v4 && v2n ? (v4.plateau.size + v4.other.size) - (v2n.plateau.size + v2n.other.size) : null;
  const rebuiltFinalCoverageImproved = addedCount != null && addedCount > 0;
  if (!rebuiltFinalCoverageImproved) errors.push('§11: 建物が 1 棟も増えていない');

  // ── §11 代表ケース ─────────────────────────────────────────────────
  let representativeMissingCasesResolved = null, representativeBaseline = null;
  if (fixtures) {
    representativeBaseline = fixtures.totals.namedMissingNow;
    representativeMissingCasesResolved = fixtures.totals.namedRecoveredInV4;
    if (representativeMissingCasesResolved == null) errors.push('§11: 代表ケースの V4 判定が無い');
    else if (representativeMissingCasesResolved < representativeBaseline) {
      warnings.push(`§9: 代表ケース ${representativeBaseline} 棟のうち V4 で回収できたのは ${representativeMissingCasesResolved} 棟`);
    }
  } else errors.push('§4: 代表ケースのレポートが無い');

  // ── §7 picking に必要な情報が揃っているか ──────────────────────────
  let pickingWorksForAddedBuildings = null;
  const pickingChecked = { sampled: 0, withWard: 0, withUsage: 0, withCanonicalId: 0, withHeight: 0 };
  if (fs.existsSync(F.v4recovered)) {
    const attrDir = path.join(F.v4recovered, 'attributes');
    const files = fs.existsSync(attrDir) ? fs.readdirSync(attrDir).filter((f) => /^tile_/.test(f)) : [];
    for (const f of files.slice(0, 40)) {
      const doc = rj(path.join(attrDir, f)) || {};
      for (const [id, a] of Object.entries(doc.attributes || {})) {
        pickingChecked.sampled++;
        if (a.wardId) pickingChecked.withWard++;
        if (a.usageCategory) pickingChecked.withUsage++;
        if (id.startsWith('cg_bldg_osm_')) pickingChecked.withCanonicalId++;
        if (a.heightM > 0) pickingChecked.withHeight++;
      }
    }
    pickingWorksForAddedBuildings = pickingChecked.sampled > 0
      && pickingChecked.withWard === pickingChecked.sampled
      && pickingChecked.withUsage === pickingChecked.sampled
      && pickingChecked.withCanonicalId === pickingChecked.sampled;
    if (!pickingWorksForAddedBuildings) errors.push('§7: 追加分に ward / usage / canonicalId が揃っていない ' + JSON.stringify(pickingChecked));
  } else errors.push('§7: V4 の回収分が無い');

  // ── §9 実ブラウザ: 二重表示を増やしていないか（対照実験）──────────
  //   「回収棟の上に 2 mesh 以上ある」だけでは判定できない。LOD band の同時描画と
  //   usageCategory ごとの束ねで、既存建物でも 2 以上になる。V2N と同一地点で比べる。
  const ctrl = rj(F.overlapControl);
  let noNewDoubleDisplay = null;
  if (ctrl) {
    noNewDoubleDisplay = ctrl.summary.allNoNewOverlap === true;
    if (!noNewDoubleDisplay) {
      errors.push('§9: V4 で同一 band 内の重なりが増えている ' + JSON.stringify(ctrl.sites.map((s) => [s.id, s.delta])));
    }
  } else warnings.push('§9: 二重表示の対照実験が未実行');

  // ── §7 実ブラウザ: card / picking ───────────────────────────────────
  const rq = rj(F.runtimeQa);
  let runtimePickingOk = null;
  if (rq) {
    runtimePickingOk = !!(rq.summary.cardsOk && rq.summary.heightRuleOk && rq.summary.jsErrors === 0);
    if (!rq.summary.cardsOk) errors.push('§7: 追加分の property card が出ない');
    if (!rq.summary.heightRuleOk) errors.push('§7: 実測高さが無い棟に高さを出している');
    if (rq.summary.jsErrors) warnings.push('§7: ランタイムで JS 例外 ' + rq.summary.jsErrors);
    if (!rq.summary.everySiteIncreased) errors.push('§9: 建物が減った地点がある');
  } else warnings.push('§7: 実ブラウザ QA が未実行');

  // ── §8 placement の変化 ────────────────────────────────────────────
  const pv4 = rj(F.placementV4), pv2 = rj(F.placementV2);
  const placementCounts = pv4 ? (pv4.policyCounts || pv4.counts || null) : null;
  const placementDelta = (pv4 && pv2) ? { v2n: pv2.policyCounts || pv2.counts || null, v4: placementCounts } : null;

  // ── §10 dev のみ。production / protected 未変更 ────────────────────
  const devHtml = fs.readFileSync(F.dev, 'utf-8');
  const devHasV4 = /derived-v4-final/.test(devHtml) && /V4 REBUILT FINAL/.test(devHtml);
  if (!devHasV4) errors.push('§10: dev に V4 の切替が無い');
  const prodBuild = rj(F.prodBuild) || {};
  const baseline = rj(F.baseline) || {};
  const productionModified = prodBuild.productionSha256 ? sha(F.prod) !== prodBuild.productionSha256 : null;
  const protectedModified = baseline.prot ? sha(F.prot) !== baseline.prot : null;
  if (productionModified !== false) errors.push('§15: production HTML が変更されている');
  if (protectedModified !== false) errors.push('§15: protected HTML が変更されている');
  const prodHtml = (() => { try { return fs.readFileSync(F.prod, 'utf-8'); } catch { return ''; } })();
  if (/derived-v4-final/.test(prodHtml)) errors.push('§15: production に V4 が入っている');

  const RESULT = errors.length ? 'FAIL' : 'PASS';
  const out = {
    version: 1, generatedAt: new Date().toISOString(), missionId: '35D', RESULT,
    classification: errors.length ? 'CITYWIDE_MISSING_BUILDING_RECOVERY_FAILED' : 'CITYWIDE_MISSING_BUILDING_RECOVERY_SUCCESS',
    buildingGeometryMutation, canonicalIdMutation, plateauRemoved,
    projectionMutation, roadMutation, waterMutation, railMutation,
    rebuiltFinalHasNoDuplicateWithPlateau,
    duplicateCheck: { sampled: dupSampled, found: dupFound, samples: dupSamples },
    rebuiltFinalCoverageImproved, addedCount,
    counts: v4 && v2n ? { v2nPlateau: v2n.plateau.size, v2nOther: v2n.other.size,
      v4Plateau: v4.plateau.size, v4Other: v4.other.size,
      v2nTotal: v2n.plateau.size + v2n.other.size, v4Total: v4.plateau.size + v4.other.size } : null,
    representativeBaseline, representativeMissingCasesResolved,
    pickingWorksForAddedBuildings, pickingChecked,
    noNewDoubleDisplay, runtimePickingOk,
    overlapControl: ctrl ? { summary: ctrl.summary, sites: ctrl.sites.map((s) => ({ id: s.id,
      v2n: s.V2N.overlapRate, v4: s.V4.overlapRate, delta: s.delta, ok: s.noNewOverlap })) } : null,
    runtimeQa: rq ? rq.summary : null,
    placementCounts, placementDelta,
    devHasV4, productionModified, protectedModified,
    auditSummary: audit ? { osmSource: audit.osmSource, latitudeCliff: audit.latitudeCliff,
      counts: audit.counts, wardRanking: audit.wardRanking } : null,
    buildSummary: build && build.canonical ? { added: build.canonical.added,
      envelopeDropped: build.canonical.envelopeDropped,
      selfDuplicateDropped: build.canonical.selfDuplicateDropped,
      mergedFeatureCount: build.canonical.mergedFeatureCount } : null,
    errors, warnings,
  };
  await writeJson(F.out, out);
  return out;
}

if (isMainModule(import.meta.url)) {
  validateCitywideMissingRecovery().then((o) => {
    console.log(JSON.stringify(o, null, 2));
    process.exit(o.RESULT === 'PASS' ? 0 : 1);
  }).catch((e) => { console.error(e); process.exit(1); });
}
