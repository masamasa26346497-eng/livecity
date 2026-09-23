#!/usr/bin/env node
// tools/validate/river-network.js
// [Mission22 §17] 河川ネットワーク（RiverLayerV2 全水系）の配信データ validator CLI。
//
// PASS 条件:
//   - NaN / Inf 頂点 0
//   - invalid width 0（widthMin/Max が非有限・負・上限超）
//   - giant triangle 0（maxTriangleEdge がタイル/河口スケールを超える）
//   - 主要 7 河川 regression intact（存在・major・ribbon ok・width 中央値が想定レンジ）
//   - 表示中に建物内部を貫く河川（displayed building conflict）0
//   - 地下水路（surface:false）が地表描画へ混入 0
//   - named river の未説明 gap（B: OSM 欠落）0
//   - tile boundary break（E: 未分類の中規模 gap）0
//   - protected / production HTML に Mission22 の変更が混入していない
//
// 実行: node tools/validate/river-network.js
import fs from 'node:fs';
import path from 'node:path';
import { writeJson } from '../lib/area.js';
import { resolveProjectPath, toProjectRelativePath } from '../lib/paths.js';
import { validateRiverRibbon } from '../lib/river-ribbon-validator.js';
import { MAJOR_RIVERS } from '../lib/river-network.js';

const DATA = resolveProjectPath(path.join('public', 'map-data', 'osaka-city', 'rivers-v2', 'rivers.json'));
const COVERAGE = resolveProjectPath(path.join('data', 'reports', 'river-network-coverage.json'));
const REPORT = resolveProjectPath(path.join('data', 'reports', 'river-network-validation.json'));
const DEV_HTML = resolveProjectPath(path.join('public', 'osaka_3d_buildings.ward-ux-v1.html'));
const PROD_HTML = resolveProjectPath(path.join('public', 'osaka_3d_buildings.html'));
const PROTECTED_HTML = resolveProjectPath(path.join('public', 'osaka_3d_buildings.fullward-v3.html'));

// 主要 7 河川の width 中央値の想定レンジ（Mission04 実測。大きく外れたら回帰）
const MAJOR_WIDTH_RANGE = {
  '淀川': [300, 450], '大和川': [80, 260], '神崎川': [90, 260], '安治川': [55, 220],
  '木津川': [110, 320], '寝屋川': [30, 90], '道頓堀川': [30, 55],
};

async function main() {
  const errors = [], warns = [];
  if (!fs.existsSync(DATA)) { console.error('[river-network-validate] 配信データなし: ' + toProjectRelativePath(DATA) + '\n  先に: node tools/build-river-layer.js'); process.exitCode = 1; return; }
  const doc = JSON.parse(fs.readFileSync(DATA, 'utf-8'));
  const cov = fs.existsSync(COVERAGE) ? JSON.parse(fs.readFileSync(COVERAGE, 'utf-8')) : null;
  const rivers = doc.rivers || [];

  if (doc.coordinateConvention !== 'znorth-neg-v1') errors.push('coordinateConvention が znorth-neg-v1 でない: ' + doc.coordinateConvention);

  const shown = rivers.filter((r) => r.ok && !r.suppressed && (!r.validationErrors || !r.validationErrors.length));

  // ── NaN / width / giant triangle ──
  let nan = 0, badWidth = 0, giant = 0, ribbonErr = 0;
  const GIANT_EDGE_M = 700; // ribbon の 1 辺がこれ超 = 疎ノードの巨大三角形
  for (const r of rivers) {
    for (const arr of [r.left, r.right, r.centerline]) {
      if (!Array.isArray(arr)) continue;
      for (const p of arr) if (!Array.isArray(p) || !p.every(Number.isFinite)) { nan++; break; }
    }
    if (r.ok) {
      if (![r.widthMin, r.widthMedian, r.widthMax].every((w) => w == null || (Number.isFinite(w) && w > 0 && w < 600))) badWidth++;
      if ((r.maxTriangleEdge || 0) > GIANT_EDGE_M && r.riverClass !== 'major') giant++;
      // [大川の実幅補正] 強実測（riverbank 十分）の medium 河川は幅上限を緩める（widthMethod で判別）。
      const mediumMax = (r.riverClass === 'medium' && r.widthMethod === 'measured-strong') ? 120 : 80;
      const v = validateRiverRibbon(r,
        r.riverClass === 'micro' ? { widthLimits: { min: 1, max: 10 }, selfCrossingSeverity: 'warn' }
          : r.riverClass === 'minor' ? { widthLimits: { min: 3, max: 30 }, selfCrossingSeverity: 'warn' }
            : r.riverClass === 'medium' ? { widthLimits: { min: 4, max: mediumMax }, selfCrossingSeverity: 'warn' }
              : {});
      if (v.errors.length && !(r.validationErrors && r.validationErrors.length)) ribbonErr += v.errors.length;
    }
  }
  if (nan) errors.push('NaN/Inf 頂点をもつ river ' + nan);
  if (badWidth) errors.push('invalid width の river ' + badWidth);
  if (giant) errors.push('giant triangle（辺 > ' + GIANT_EDGE_M + 'm・非major）の river ' + giant);
  if (ribbonErr) errors.push('未記録の ribbon validator ERROR ' + ribbonErr);

  // ── 主要 7 河川 regression ──
  for (const nm of MAJOR_RIVERS) {
    const segs = rivers.filter((r) => r.name === nm);
    if (!segs.length) { errors.push('主要河川が消えた: ' + nm); continue; }
    if (segs.some((s) => s.riverClass !== 'major')) errors.push(nm + ' が major でない');
    if (segs.some((s) => !s.ok)) errors.push(nm + ' の ribbon 生成に失敗している');
    if (segs.some((s) => s.suppressed)) errors.push(nm + ' が suppress されている（major は不可）');
    const wAll = segs.flatMap((s) => s.widths || []).filter(Number.isFinite).sort((a, b) => a - b);
    const med = wAll[Math.floor(wAll.length / 2)];
    const rng = MAJOR_WIDTH_RANGE[nm];
    if (rng && (med < rng[0] || med > rng[1])) errors.push(nm + ' の width 中央値 ' + (med || 0).toFixed(1) + ' が想定レンジ外 [' + rng + ']（Mission04 回帰）');
  }

  // ── 地下水路混入 / displayed building conflict ──
  const undergroundShown = shown.filter((r) => r.surface === false);
  if (undergroundShown.length) errors.push('地下水路（surface:false）が地表描画へ混入 ' + undergroundShown.length);
  // 幅のある ribbon（>10m）が建物内部を大きく貫いて表示されている
  const displayedConflicts = shown.filter((r) => (r.conflictCenterInFrac || 0) > 0.5 && (r.widthMedian || r.width || 0) > 10);
  if (displayedConflicts.length) errors.push('建物内部を貫く太い ribbon が表示されている ' + displayedConflicts.length + ': ' + displayedConflicts.slice(0, 5).map((r) => r.name || r.id).join(', '));
  const thinOverBuilding = shown.filter((r) => (r.conflictCenterInFrac || 0) > 0.5).length;
  if (thinOverBuilding) warns.push('centerline が建物内の thin ribbon ' + thinOverBuilding + ' 本（暗渠/高架下/OSM 誤差。細線で表示・§13 で許容）');

  // ── 連続性: 未説明 gap / tile boundary break ──
  const continuity = doc.continuity || {};
  const bGaps = [], eGaps = [];
  for (const [nm, c] of Object.entries(continuity)) {
    for (const g of (c.gaps || [])) {
      if (/^B:/.test(g.cause)) bGaps.push(nm + '@' + JSON.stringify(g.at));
      if (/^E:/.test(g.cause)) eGaps.push(nm + '@' + JSON.stringify(g.at));
    }
  }
  if (bGaps.length) errors.push('named river の未説明 gap（B: OSM 欠落）' + bGaps.length + ': ' + bGaps.slice(0, 6).join(', '));
  if (eGaps.length) errors.push('未分類の tile boundary gap（E:）' + eGaps.length + ': ' + eGaps.slice(0, 6).join(', '));

  // ── tier 分布 sanity ──
  const tiers = { major: rivers.filter((r) => r.riverClass === 'major').length, medium: rivers.filter((r) => r.riverClass === 'medium').length, minor: rivers.filter((r) => r.riverClass === 'minor').length };
  if (tiers.medium < 10) errors.push('medium 河川が少なすぎる（' + tiers.medium + '）— 分類が機能していない疑い');
  if (shown.length < 120) errors.push('表示河川が少なすぎる（' + shown.length + '）');

  // ── HTML 配線 ──
  if (fs.existsSync(DEV_HTML)) {
    const html = fs.readFileSync(DEV_HTML, 'utf-8');
    if (!/__RIVER_NETWORK_DEBUG__/.test(html)) errors.push('dev HTML に __RIVER_NETWORK_DEBUG__ が無い');
    if (!/mediumMesh/.test(html)) errors.push('dev HTML に medium tier mesh が無い');
    if (!/MEDIUM_HIDE_DISTANCE_M/.test(html)) errors.push('dev HTML に medium LOD が無い');
    if (!/const RiverLayerV2 = /.test(html)) errors.push('RiverLayerV2 が消えた');
  }
  for (const [label, p] of [['production', PROD_HTML], ['protected', PROTECTED_HTML]]) {
    if (!fs.existsSync(p)) { warns.push(label + ' HTML なし'); continue; }
    const h = fs.readFileSync(p, 'utf-8');
    if (/__RIVER_NETWORK_DEBUG__|mediumMesh|MEDIUM_HIDE_DISTANCE_M/.test(h)) errors.push(label + ' HTML に Mission22 の変更が混入している');
  }

  const totalTri = shown.reduce((s, r) => s + (r.triangleCount || 0), 0);
  console.log('[river-network-validate] rivers=' + rivers.length + ' shown=' + shown.length + ' tiers=' + JSON.stringify(tiers) + ' tri=' + totalTri);
  console.log('  nan=' + nan + ' badWidth=' + badWidth + ' giant=' + giant + ' undergroundShown=' + undergroundShown.length + ' displayedConflicts=' + displayedConflicts.length);
  console.log('  gaps: B(unexplained)=' + bGaps.length + ' E(tileBreak)=' + eGaps.length + '  underground除外=' + (doc.undergroundSkipped ?? '?'));
  if (errors.length) { console.log('  -- errors --'); for (const e of errors) console.log('  [ERROR] ' + e); }
  if (warns.length) { console.log('  -- warns --'); for (const w of warns) console.log('  [WARN] ' + w); }

  const report = {
    generatedAt: new Date().toISOString(),
    data: toProjectRelativePath(DATA),
    rivers: rivers.length, shown: shown.length, tiers, totalTriangles: totalTri,
    undergroundSkipped: doc.undergroundSkipped ?? null,
    namedRivers: doc.namedRivers ?? (cov && cov.named) ?? null,
    checks: { nan, badWidth, giant, undergroundShown: undergroundShown.length, displayedConflicts: displayedConflicts.length, bGaps: bGaps.length, eGaps: eGaps.length },
    errorCount: errors.length, warnCount: warns.length, errors, warns,
    RESULT: errors.length === 0 ? 'PASS' : 'FAIL',
  };
  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  await writeJson(REPORT, report);
  console.log('保存:', toProjectRelativePath(REPORT));
  console.log('RESULT:', report.RESULT);
  if (errors.length) process.exitCode = 1;
}

main().catch((e) => { console.error('[river-network-validate] 失敗:', e && e.stack || e); process.exitCode = 1; });
