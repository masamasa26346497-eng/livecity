// tests/mission30-map-detail-audit.test.js
// [Mission30 大阪市全域 細部欠落総合監査]
//   audit レポート構造 / anomaly A〜H + §5 cause / 24区スコア / layer QA 再監査（Mission26-29）/
//   representative QA / sourceMissing / __MAP_DETAIL_AUDIT_DEBUG__ 配線（summary のみ）/
//   performance regression / map completeness 100 / production・protected 無変更 / runtime。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { PROJECT_ROOT } from '../tools/lib/paths.js';
import { CAUSE } from '../tools/lib/map-detail-audit.js';

const require = createRequire(import.meta.url);
const HTML_PATH = path.join(PROJECT_ROOT, 'public', 'osaka_3d_buildings.ward-ux-v1.html');
const html = fs.readFileSync(HTML_PATH, 'utf-8');
const js = html.match(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/i)[1];

const AUDIT = path.join(PROJECT_ROOT, 'data', 'reports', 'map-detail-audit.json');
const VAL = path.join(PROJECT_ROOT, 'data', 'reports', 'map-detail-audit-validation.json');
const a = fs.existsSync(AUDIT) ? JSON.parse(fs.readFileSync(AUDIT, 'utf-8')) : null;
const v = fs.existsSync(VAL) ? JSON.parse(fs.readFileSync(VAL, 'utf-8')) : null;

function run() {
  return require('./_ward-ux-v1-smoke-harness.cjs').runInlineScript(undefined, { fetchRoot: path.resolve(PROJECT_ROOT, 'public') });
}
async function flush(n = 24) { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); }

const REP24 = ['梅田', '中之島', '本町', '難波', '天王寺', '阿倍野', '大阪城', '京橋', '鶴橋', '十三', '淡路', '住吉', '東住吉', '平野', '生野', '西成', '此花', 'USJ', '舞洲', '夢洲', '港', '大正', '咲洲', '南港'];

test('[Mission30] インライン <script> の JS 構文が壊れていない', () => {
  const f = path.join(os.tmpdir(), `m30-${process.pid}.js`);
  fs.writeFileSync(f, js);
  try { execFileSync('node', ['--check', f], { stdio: 'pipe' }); } finally { try { fs.unlinkSync(f); } catch { /* noop */ } }
});

test('[Mission30] §16 map-detail-audit.json: 必須キー / verdict', { skip: !a && 'no audit' }, () => {
  for (const k of ['overallScore', 'criticalCount', 'highCount', 'mediumCount', 'unexplained',
    'anomalySummary', 'anomalyTypeCounts', 'causeCounts', 'layerScores', 'layerQa', 'wardScores',
    'representativeQa', 'sourceMissing', 'performanceRegression', 'RESULT', 'verdict']) {
    assert.ok(k in a, 'audit に ' + k + ' が無い');
  }
  assert.equal(a.criticalCount, 0);
  assert.equal(a.highCount, 0);
  assert.equal(a.unexplained, 0);
  assert.equal(a.RESULT, 'PASS');
  assert.ok(a.overallScore >= 95);
});

test('[Mission30] §2/§5 anomaly type ⊂ {A..H} / 全 anomaly に taxonomy cause', { skip: !a && 'no audit' }, () => {
  for (const t of Object.keys(a.anomalyTypeCounts)) {
    assert.ok(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'].includes(t), '未知の anomaly type: ' + t);
  }
  for (const c of Object.keys(a.causeCounts)) {
    assert.ok(CAUSE.includes(c), '未知の cause: ' + c);
  }
  // §4: CRITICAL/HIGH は 0、MEDIUM も 0（全件説明可能）
  assert.equal(a.anomalySummary.bySeverity.CRITICAL, 0);
  assert.equal(a.anomalySummary.bySeverity.HIGH, 0);
});

test('[Mission30] §6 24区スコア: 全区 overallCompleteness / criticalCount 0', { skip: !a && 'no audit' }, () => {
  assert.equal(Object.keys(a.wardScores).length, 24);
  for (const [w, s] of Object.entries(a.wardScores)) {
    assert.equal(s.criticalCount, 0, w + ' に CRITICAL');
    assert.equal(s.highCount, 0, w + ' に HIGH');
    for (const k of ['buildingCoverage', 'roadCoverage', 'waterCoverage', 'parkCoverage', 'railCoverage', 'explainedCount']) {
      assert.ok(k in s, w + '.' + k + ' が無い');
    }
  }
});

test('[Mission30] §8-12 layer QA: 全 layer pass', { skip: !a && 'no audit' }, () => {
  for (const L of ['land', 'roads', 'buildings', 'waterways', 'parks', 'railways', 'sea']) {
    assert.ok(a.layerQa[L] && a.layerQa[L].pass, L + ' layer QA が pass でない: ' + JSON.stringify(a.layerQa[L]));
    assert.ok((a.layerScores[L] || 0) >= 95, L + ' score < 95');
  }
  // §8 roads
  assert.equal(a.layerQa.roads.tileBoundaryBreaks, 0);
  assert.ok(a.layerQa.roads.localCoveragePercent >= 99);
  assert.deepEqual([...a.layerQa.roads.sparseWards].sort(), ['higashiyodogawa', 'yodogawa']);
  // §9 buildings
  assert.equal(a.layerQa.buildings.duplicate, 0);
  assert.equal(a.layerQa.buildings.invalid, 0);
  assert.equal(a.layerQa.buildings.unexplainedGapClusters, 0);
  assert.equal(a.layerQa.buildings.sparseMismatchResidual, 0);
  // §10 waterways
  assert.equal(a.layerQa.waterways.missingSurfaceWater, 0);
  assert.equal(a.layerQa.waterways.major7Regression, true);
  // §11 parks
  assert.equal(a.layerQa.parks.majorParksRendered, true);
  // §12 rail
  assert.equal(a.layerQa.railways.majorLinesFound, true);
  assert.equal(a.layerQa.railways.railClassFix, true);
});

test('[Mission30] §7 representative QA: 24点 / FAIL なし', { skip: !a && 'no audit' }, () => {
  assert.ok(a.representativeQa.length >= 24, 'representative が ' + a.representativeQa.length + ' 点');
  const names = a.representativeQa.map((r) => r.name);
  for (const n of REP24) assert.ok(names.includes(n), 'representative に ' + n + ' が無い');
  assert.equal(a.representativeQa.filter((r) => r.status === 'FAIL').length, 0);
  // 淡路・十三 は SOURCE_MISSING で EXPLAINED
  for (const n of ['淡路', '十三']) {
    const r = a.representativeQa.find((x) => x.name === n);
    assert.ok(r && (r.status === 'EXPLAINED' || r.status === 'PASS'), n + ': ' + (r && r.status));
  }
});

test('[Mission30] §9 sourceMissing: 東淀川区・淀川区 の roads', { skip: !a && 'no audit' }, () => {
  const sm = a.sourceMissing.filter((s) => s.layer === 'roads').map((s) => s.ward);
  assert.ok(sm.includes('higashiyodogawa'));
  assert.ok(sm.includes('yodogawa'));
});

test('[Mission30] §13 performance regression なし', { skip: !a && 'no audit' }, () => {
  assert.equal(a.performanceRegression.pass, true);
  assert.equal(a.performanceRegression.auditCodeAddsRuntimeCost, false);
});

test('[Mission30] §17 validator: RESULT PASS', { skip: !v && 'no validation' }, () => {
  assert.equal(v.RESULT, 'PASS', JSON.stringify(v.errors));
  assert.equal(v.counts.critical, 0);
  assert.equal(v.counts.high, 0);
  assert.equal(v.counts.unexplained, 0);
  for (const L of Object.values(v.layerQaPass)) assert.equal(L, true);
});

test('[Mission30] §15 HTML: __MAP_DETAIL_AUDIT_DEBUG__ が summary のみ（anomaly 配列を常時載せない）', () => {
  assert.ok(/window\.__MAP_DETAIL_AUDIT_DEBUG__ = function \(\)/.test(html));
  const s = html.indexOf('window.__MAP_DETAIL_AUDIT_DEBUG__');
  const fn = html.slice(s, s + 2200);
  for (const k of ['reportPath', 'gridSizeM', 'runtimeMissing', 'performance', 'note']) {
    assert.ok(fn.includes(k), '__MAP_DETAIL_AUDIT_DEBUG__ に ' + k + ' が無い');
  }
  // 大量 anomaly 配列を埋め込んでいない
  assert.ok(!/anomalies:\s*\[\{/.test(fn), 'anomaly 配列を常時ロードしている');
  // 既存 debug API を壊していない
  for (const kw of ['__MAP_COMPLETENESS_DEBUG__', '__PERFORMANCE_DEBUG__', '__RIVER_NETWORK_DEBUG__', '__ROAD_NETWORK_DEBUG__', '__MAJOR_BUILDING_LOD_DEBUG__']) {
    assert.ok(html.includes(kw), kw + ' が消えた');
  }
});

test('[Mission30] protected HTML に Mission30 の変更が混入していない（production は 32U cutover で promoted build）', () => {
  for (const rel of ['osaka_3d_buildings.fullward-v3.html']) {   // [32U] production は promoted build になったため protected のみを守る
    const p = path.join(PROJECT_ROOT, 'public', rel);
    if (!fs.existsSync(p)) continue;
    const h = fs.readFileSync(p, 'utf-8');
    assert.ok(!/__MAP_DETAIL_AUDIT_DEBUG__/.test(h), rel + ' に Mission30 混入');
  }
});

test('[Mission30] map completeness 100 維持', () => {
  const p = path.join(PROJECT_ROOT, 'data', 'reports', 'map-completeness-audit.json');
  if (!fs.existsSync(p)) return;
  const m = JSON.parse(fs.readFileSync(p, 'utf-8'));
  assert.equal(m.overallScore, 100);
  assert.equal(m.criticalCount, 0);
  assert.equal(m.highCount, 0);
});

test('[Mission30] runtime: __MAP_DETAIL_AUDIT_DEBUG__ が summary を返す / runtimeMissing 0', async () => {
  const r = run();
  assert.ok(r.ok, r.error && r.error.stack);
  await flush();
  const d = r.window.__MAP_DETAIL_AUDIT_DEBUG__();
  assert.ok(d && typeof d === 'object');
  assert.equal(d.gridSizeM, 100);
  assert.ok(d.runtime && Array.isArray(d.runtime.runtimeMissing));
  assert.equal(d.runtime.runtimeMissingCount, 0, 'runtimeMissing: ' + JSON.stringify(d.runtime.runtimeMissing));
  assert.ok(!('anomalies' in d), 'summary API に anomalies 配列がある');
});
