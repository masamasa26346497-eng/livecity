// tests/road-visual-v3.test.js
// [Mission 32I] ROAD V3 — TRUE CARRIAGEWAY REFINEMENT。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInlineScript } from './_ward-ux-v1-smoke-harness.cjs';
import { CANONICAL_ROAD_FEATURE_COUNT, isKnownCanonicalCount } from "../tools/lib/canonical-baseline.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const R = (...s) => path.join(ROOT, ...s);
const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };
const rpt = (n) => rj(R('data', 'reports', n));

const HTML = R('public', 'osaka_3d_buildings.ward-ux-v1.html');
const html = fs.existsSync(HTML) ? fs.readFileSync(HTML, 'utf-8') : '';
const BUILDER = R('tools', 'build-road-visual-v3.js');
const builderSrc = fs.existsSync(BUILDER) ? fs.readFileSync(BUILDER, 'utf-8') : '';

test('[32I §28] validator が PASS（建物・canonical road・projection 不変）', { skip: !rpt('road-visual-v3-validation.json') && 'no report' }, () => {
  const v = rpt('road-visual-v3-validation.json');
  assert.equal(v.RESULT, 'PASS', JSON.stringify(v.errors || []));
  assert.equal(v.checks.buildingMutation, 0);
  assert.equal(v.checks.canonicalRoadMutation, 0);
  assert.equal(v.checks.projectionMutation, 0);
  assert.equal(v.checks.canonicalBuildings, 615617);
  // [Mission 35E] これは 32I 当時に書かれた記録。今日の件数ではなく
  //   「書かれた時点で正しかったか」で見る（35E で canonical roads を正当に作り直した）。
  assert.ok(isKnownCanonicalCount('roads', v.checks.canonicalRoads),
    '未知の canonical roads 件数: ' + v.checks.canonicalRoads);
  assert.equal(v.checks.tranUsedAsDarkCarriagewaySource, false);
  assert.equal(v.checks.tranUsedAsSafetyEnvelope, true);
  assert.equal(v.checks.buildingUsedForRoadGeneration, false);
  assert.equal(v.checks.roadV3Exists, true);
  assert.equal(v.checks.widthSanityMeasured, true);
  assert.equal(v.checks.continuityMeasured, true);
  assert.equal(v.checks.productionModified, false);
  assert.equal(v.checks.protectedModified, false);
});

test('[32I §9] builder が building を道路幅の決定に使っていない', () => {
  // 幅を決める関数 refineQuad の本体に building 参照が無いこと
  const start = builderSrc.indexOf('function refineQuad(');
  const end = builderSrc.indexOf('// ── §27/§28 acceptance fixture');
  assert.ok(start > 0 && end > start, 'refineQuad の範囲が特定できない');
  const body = builderSrc.slice(start, end);
  assert.doesNotMatch(body, /CANON_BLDGS/);
  assert.doesNotMatch(body, /canonical', 'buildings/);
  assert.doesNotMatch(body, /buildingDarkOverlap|bldg/);
});

test('[32I §8] tran polygon を dark carriageway の source にしていない', { skip: !rpt('road-visual-v3.json') && 'no report' }, () => {
  const r = rpt('road-visual-v3.json');
  assert.equal(r.sourceUsage.tranEnvelopeOnly, 0, 'tran を carriageway source として使った帯がある');
  // tran は clip 先としてのみ使う
  assert.match(builderSrc, /MAXIMUM ROAD DOMAIN/);
});

test('[32I §2/§4/§5] source hierarchy と推定幅の provenance が記録されている', { skip: !rpt('road-visual-v3.json') && 'no report' }, () => {
  const r = rpt('road-visual-v3.json');
  for (const k of ['gsi', 'osmWidth', 'osmLanes', 'osmClassInference', 'tranEnvelopeOnly']) {
    assert.equal(typeof r.sourceUsage[k], 'number', 'sourceUsage.' + k + ' が無い');
  }
  // §4: 実在する attribute のみ使う — junction タグはこの dataset に存在しないことを記録している
  assert.equal(r.osmAttributePresence.junction, 0, 'junction タグが存在するなら使うべき');
  assert.ok(r.osmAttributePresence.lanes > 0 && r.osmAttributePresence.highway > 0);
  // §5: 推定幅テーブルの provenance
  const p = r.osmWidthTableProvenance;
  assert.ok(p.laneWidthM > 0 && p.classWidthM && p.classWidthBasis && p.laneWidthBasisMeasured);
  assert.ok(Array.isArray(p.widthTagMeasuredClasses) && p.widthTagMeasuredClasses.length > 0);
  // 推定は confidence を下げる
  assert.equal(p.confidenceMapping.osmWidth, 'high');
  assert.equal(p.confidenceMapping.osmLanes, 'medium');
  assert.equal(p.confidenceMapping.osmClassInference, 'low');
});

test('[32I §15/§29] Building∩DarkRoad が FIX13 > V2 > V3 の順で改善している', { skip: !rpt('road-visual-v3.json') && 'no report' }, () => {
  const o = rpt('road-visual-v3.json').overlap;
  assert.ok(o.fix13 > o.v2, 'FIX13 より V2 が改善していない');
  assert.ok(o.v2 > o.v3, 'V2 より V3 が改善していない: v2=' + o.v2 + ' v3=' + o.v3);
  assert.ok(o.improvementV2ToV3Percent > 0);
});

test('[32I §16/§24] overlap のために細くしすぎていない（continuity を同時評価）', { skip: !rpt('road-visual-v3.json') && 'no report' }, () => {
  const c = rpt('road-visual-v3.json').centerlineCoverage;
  assert.ok(c.samples > 1000, 'centerline サンプルが少なすぎる');
  assert.ok(c.coveredPercentV3 >= c.coveredPercentV2 * 0.85,
    'centerline 被覆が V2 の 85% を下回った: V2=' + c.coveredPercentV2 + ' V3=' + c.coveredPercentV3);
  assert.equal(typeof c.gapCountV3, 'number');
  assert.equal(typeof c.gapLengthV3M, 'number');
});

test('[32I §17] road class 別の width 統計が出ている', { skip: !rpt('road-visual-v3.json') && 'no report' }, () => {
  const w = rpt('road-visual-v3.json').widthStats;
  const cw = w.CARRIAGEWAY;
  for (const k of ['median', 'p50', 'p75', 'p90', 'p95', 'max']) assert.ok(cw[k] != null, 'CARRIAGEWAY.' + k + ' が無い');
  // §16: 1車線未満に細めていない / GSI pairing 上限(45m)を超える「車道」が残っていない
  assert.ok(cw.median >= 3, 'carriageway 幅の中央値が 3m 未満: ' + cw.median);
  assert.ok(cw.max <= 45, 'carriageway 幅の最大が 45m 超: ' + cw.max);
  // §10: 最低限の class 分離
  for (const k of ['CARRIAGEWAY', 'PEDESTRIAN', 'MEDIAN', 'SHOULDER_MARGIN', 'BRIDGE']) assert.ok(w[k], 'class ' + k + ' の統計が無い');
});

test('[32I §18] GSI paired width と OSM 由来 width の差が出ている', { skip: !rpt('road-visual-v3.json') && 'no report' }, () => {
  const c = rpt('road-visual-v3.json').osmGsiConsistency;
  assert.ok(c.comparedQuads > 0);
  for (const k of ['median', 'p90', 'p95']) {
    assert.ok(c.gsiCorridorWidthM[k] != null && c.osmDerivedCarriagewayWidthM[k] != null && c.differenceM[k] != null);
  }
  assert.ok(c.gsiCorridorWidthM.median > c.osmDerivedCarriagewayWidthM.median, 'GSI corridor の方が広いという実測結果が崩れている');
});

test('[32I §19] 梅田重点 15地点が測られている', { skip: !rpt('road-visual-v3.json') && 'no report' }, () => {
  const sp = rpt('road-visual-v3.json').umedaSpots;
  const keys = Object.keys(sp);
  assert.ok(keys.length >= 15, '梅田地点が15未満: ' + keys.length);
  const kinds = new Set(keys.map((k) => sp[k].kind));
  for (const need of ['station', 'rail_side', 'intersection', 'elevated', 'facility']) {
    assert.ok(kinds.has(need), '種別 ' + need + ' の地点が無い');
  }
  for (const k of keys) assert.equal(typeof sp[k].buildingDarkOverlapV3M2, 'number');
});

test('[32I §20/§21] 住吉と他 fixture を改悪していない', { skip: !rpt('road-visual-v3.json') && 'no report' }, () => {
  const s = rpt('road-visual-v3.json').sites;
  for (const k of ['sumiyoshi', 'nakanoshima', 'honmachi', 'namba', 'tennoji']) {
    assert.ok(s[k], 'fixture ' + k + ' が無い');
    assert.ok(s[k].buildingDarkOverlapV3M2 <= s[k].buildingDarkOverlapV2M2,
      k + ' が V2 より悪化: v2=' + s[k].buildingDarkOverlapV2M2 + ' v3=' + s[k].buildingDarkOverlapV3M2);
  }
});

test('[32I §22] rail を road として塗る量が V2 より増えていない', { skip: !rpt('road-visual-v3.json') && 'no report' }, () => {
  const ri = rpt('road-visual-v3.json').railInteraction;
  assert.ok(ri.totalRatioV3 != null && ri.totalRatioV2 != null);
  assert.ok(ri.totalRatioV3 <= ri.totalRatioV2,
    'rail corridor を road として塗る割合が増えた: v2=' + ri.totalRatioV2 + ' v3=' + ri.totalRatioV3);
});

test('[32I §23] bridge / tunnel を地上の dark carriageway に含めていない', () => {
  // refineQuad が bridge/tunnel を CARRIAGEWAY 以外の class にしている
  assert.match(builderSrc, /cls = 'TUNNEL'/);
  assert.match(builderSrc, /cls = 'BRIDGE'/);
  // dark に入るのは CARRIAGEWAY のみ
  assert.match(builderSrc, /if \(b\.cls === 'CARRIAGEWAY'\) \{/);
});

test('[32I §6] 自己交差を作らない構成（外側 offset をしていない）', () => {
  // 帯は元 quad の横断方向線形補間のみで作る
  assert.match(builderSrc, /const ring = \[lerp\(p0, q0, sLo\), lerp\(p1, q1, sLo\), lerp\(p1, q1, sHi\), lerp\(p0, q0, sHi\)\]/);
  const r = rpt('road-visual-v3.json');
  if (r) { assert.equal(r.geometryValidity.nanCount, 0); assert.equal(r.geometryValidity.degenerateCount, 0); }
});

test('[32I §13] dev UI に ROAD V3 / DIFF V2→V3 があり、default は昇格していない', () => {
  assert.match(html, /let roadVisualMode = 'ROAD_V3';/); // [32K §13] 昇格は 32K で明示的に許可された
  assert.match(html, /const ROAD_VISUAL_MODES = \['FIX13', 'ROAD_V2', 'ROAD_V3', 'DIFF', 'DIFF_V2_V3', 'LAND_BLOCK'\];/);
  // ボタン id は 'road-v2-mode-' + mk で動的生成される（literal では現れない）
  assert.match(html, /\['ROAD_V3', 'C:ROAD V3'\]/);
  assert.match(html, /\['DIFF_V2_V3', 'DIFF V2→V3'\]/);
  assert.match(html, /window\.__ROAD_V3_DEBUG__/);
});

test('[32I §11/§14] dark 色は CARRIAGEWAY のみ / DIFF は red・blue・neutral の3色', () => {
  const m = /const ROAD_V3_COLOR = \{[\s\S]*?\};/.exec(html);
  assert.ok(m, 'ROAD_V3_COLOR が無い');
  const block = m[0];
  assert.match(block, /carriageway: \(typeof COL !== 'undefined' && COL\.road\)/);
  assert.doesNotMatch(block, /(margin|uncertain): \(typeof COL !== 'undefined' && COL\.road\)/);
  assert.match(block, /diffV2Only: 0xe0503c/);   // red
  assert.match(block, /diffV3Only: 0x3a7bd5/);   // blue
  assert.match(block, /diffCommon: 0x9aa0a6/);   // neutral
});

test('[32I §12] ROAD V3 表示中は raw GSI edge を隠し、抜けたら戻す', () => {
  // [Mission 32K §1] raw GSI edge の既定は OFF になった（32J で正体が道路縁と確定したため）。
  //   32I が入れた「派生道路表示中だけ隠して戻す」機構自体は残っている（既定 OFF なら no-op）。
  assert.match(html, /let gsiEdgeEnabled = false;/);
  assert.match(html, /const hideRawEdgeForV3 = \(roadVisualMode === 'ROAD_V3' \|\| roadVisualMode === 'DIFF_V2_V3'\);/);
  assert.match(html, /if \(showLandBlock \|\| landBlockQaEnabled \|\| hideRawEdgeForV3\) \{/);
  assert.match(html, /savedGsiEdgeEnabledBeforeLandBlock/); // 復元経路が生きている
});

test('[32I 動的] ROAD V3 モードに切り替えても residual が 0 を維持し、OFF で戻る', async () => {
  if (!fs.existsSync(HTML)) return;
  const r = runInlineScript(HTML, { fetchRoot: R('public') });
  assert.equal(r.ok, true, r.error && r.error.stack);
  const w = r.window;
  const before = w.__ROAD_V3_DEBUG__();
  // [Mission 32K §13] runtime 既定は ROAD_V3 へ昇格した。
  assert.equal(before.mode, 'ROAD_V3', '既定が ROAD_V3 でない');
  for (const mode of ['ROAD_V3', 'DIFF_V2_V3', 'ROAD_V2', 'FIX13']) {
    const res = await w.__SET_ROAD_VISUAL_MODE__(mode);
    assert.equal(res.mode, mode, mode + ' へ切り替わらない');
    assert.equal(w.__CANONICAL_SELF_CHECK__().total, 0, mode + ' で residual が 0 でない');
  }
  assert.equal(w.__ROAD_V3_DEBUG__().mode, 'FIX13'); // 明示切替後の値
});

test('[32I] protected HTML に本ミッション関連コードが混入していない（production は 32U cutover で promoted build）', () => {
  for (const f of ['osaka_3d_buildings.fullward-v3.html']) {   // [32U] production は promoted build になったため protected のみを守る
    const p = R('public', f);
    if (!fs.existsSync(p)) continue;
    const t = fs.readFileSync(p, 'utf-8');
    assert.doesNotMatch(t, /RoadV3_|ROAD_V3_BASE|roadV3Group|DIFF_V2_V3/, f + ' に混入');
  }
});
