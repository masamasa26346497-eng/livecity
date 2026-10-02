// tests/umeda-inferred-roof.test.js
// [Mission 35A] 梅田 推定屋根（INFERRED_ROOF）PoC
//   - 実 PLATEAU LOD2 と推定を絶対に混同しない（§1）
//   - 証拠が無ければ推定しない（§6）。高さ・階数だけで形を決めない（§4）
//   - 棟の向きを長辺だけで決め打ちしない（§18）
//   - footprint / 全高 / canonicalId / projection を壊さない（§14/§15）
//   - HIGH だけを通常表示（§9）。dev のみ、production/protected は触らない（§33）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ROOF_TYPES, CONFIDENCE, NO_EVIDENCE, OSM_ROOF_SHAPE_MAP, MANUAL_CANDIDATE_TYPES,
  footprintShape, inferRoof, evaluate, FLAT_FAMILY, SLOPED_FAMILY, QUALITY, meetsQuality,
} from '../tools/lib/umeda-roof-inference.js';
import { UMEDA } from '../tools/audit/umeda-roof-evidence.js';
import { ROOF_TYPES as GT_TYPES, CLASSIFY, classifyRoof, stratifiedSplit, triNormalArea } from '../tools/audit/umeda-roof-groundtruth.js';
import {
  GUARD, GENERATION_VERSION, ROOF_SOURCE, NO_GEOMETRY_TYPES, NEEDS_IMAGERY_TYPES, MANUAL_TYPES,
  pointInRing, distToRing, buildSlopedRoof, guardRoof, buildWalls, mergeGeometry,
} from '../tools/build-umeda-inferred-roof.js';
import { REAL_LOD, TOTAL_BUILDINGS, REQUIRED_NAMES } from '../tools/validate/umeda-inferred-roof.js';
import { ringIoU } from '../tools/audit/umeda-roof-evaluate.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEV = path.join(ROOT, 'public', 'osaka_3d_buildings.ward-ux-v1.html');
const PROD = path.join(ROOT, 'public', 'osaka_3d_buildings.html');
const html = fs.readFileSync(DEV, 'utf-8');
const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };
const rpt = (n) => rj(path.join(ROOT, 'data', 'reports', n));
const skip = (n) => (!rpt(n) && 'no report');

const SQUARE = [[0, 0], [20, 0], [20, 10], [0, 10], [0, 0]];

// ── §4/§6 証拠が無ければ推定しない ───────────────────────────────────────
test('35A §6 証拠が無い建物は NO_ROOF_EVIDENCE で UNKNOWN のまま', () => {
  const r = inferRoof({ canonicalId: 'x', ring: SQUARE, areaM2: 200, heightM: 31 }, {});
  assert.equal(r.evidence, NO_EVIDENCE);
  assert.equal(r.roofType, 'UNKNOWN');
  assert.equal(r.confidence, 'LOW');
});

test('35A §4 高さ・階数・用途だけでは屋根タイプを決めない', () => {
  // 高さも用途も違う 3 棟。証拠が無い以上どれも UNKNOWN でなければならない。
  for (const b of [{ heightM: 6, usageCategory: 'residential' },
    { heightM: 31, usageCategory: 'commercial' },
    { heightM: 120, usageCategory: 'office' }]) {
    const r = inferRoof({ canonicalId: 'x', ring: SQUARE, areaM2: 200, ...b }, {});
    assert.equal(r.roofType, 'UNKNOWN', JSON.stringify(b));
  }
});

test('35A §4 細長い footprint でも形の証拠が無ければ GABLE にしない', () => {
  const thin = [[0, 0], [60, 0], [60, 6], [0, 6], [0, 0]];
  const s = footprintShape(thin);
  assert.ok(s.elongation > 5, '細長さは測れている: ' + s.elongation);
  assert.equal(inferRoof({ canonicalId: 'x', ring: thin, areaM2: 360, heightM: 7 }, {}).roofType, 'UNKNOWN');
});

// ── §18 棟の向きを長辺だけで決め打ちしない ───────────────────────────────
test('35A §18 roof:shape=gabled でも roof:orientation が無ければ UNKNOWN', () => {
  const r = inferRoof({ canonicalId: 'x', ring: SQUARE, areaM2: 200, heightM: 7 },
    { osmRoof: { shape: 'gabled', orientation: null, matchIoU: 0.9 } });
  assert.equal(r.roofType, 'UNKNOWN');
  assert.equal(r.wouldBe, 'GABLE');
  assert.match(r.reason, /roof:orientation/);
});

test('35A §18 roof:orientation があるときだけ棟の向きを決める', () => {
  const s = footprintShape(SQUARE);
  const along = inferRoof({ canonicalId: 'x', ring: SQUARE, areaM2: 200, heightM: 7 },
    { osmRoof: { shape: 'gabled', orientation: 'along', matchIoU: 0.9 } });
  assert.equal(along.roofType, 'GABLE');
  assert.equal(along.ridgeDeg, s.longAxisDeg);
  const across = inferRoof({ canonicalId: 'x', ring: SQUARE, areaM2: 200, heightM: 7 },
    { osmRoof: { shape: 'gabled', orientation: 'across', matchIoU: 0.9 } });
  assert.equal(across.ridgeDeg, (s.longAxisDeg + 90) % 180);
});

// ── §9 信頼度 ────────────────────────────────────────────────────────────
test('35A §9 footprint 一致が低い OSM タグは HIGH にしない', () => {
  const mk = (iou) => inferRoof({ canonicalId: 'x', ring: SQUARE, areaM2: 200, heightM: 12 },
    { osmRoof: { shape: 'flat', matchIoU: iou } }).confidence;
  assert.equal(mk(0.90), 'HIGH');
  assert.equal(mk(0.45), 'MEDIUM');
  assert.equal(mk(0.10), 'LOW');
  assert.ok(CONFIDENCE.includes('HIGH') && CONFIDENCE.includes('LOW'));
});

test('35A §21 COMPLEX は自動生成しない（手作業候補）', () => {
  for (const shape of ['mansard', 'dome', 'round', 'gambrel']) {
    const r = inferRoof({ canonicalId: 'x', ring: SQUARE, areaM2: 200, heightM: 12 },
      { osmRoof: { shape, matchIoU: 0.9 } });
    assert.equal(r.roofType, 'COMPLEX');
    assert.equal(r.manualCandidate, true);
    assert.equal(r.confidence, 'LOW', shape + ' は通常表示の候補にしない');
  }
  assert.ok(MANUAL_CANDIDATE_TYPES.has('COMPLEX') && MANUAL_TYPES.has('COMPLEX'));
});

test('35A §7 屋根タイプの語彙が仕様どおり', () => {
  for (const t of ['FLAT', 'FLAT_WITH_PENTHOUSE', 'MULTI_LEVEL_FLAT', 'GABLE', 'HIP', 'SHED', 'COMPLEX', 'UNKNOWN']) {
    assert.ok(ROOF_TYPES.includes(t), t);
    assert.ok(GT_TYPES.includes(t), 'ground truth 側にも ' + t);
  }
  assert.ok(Object.values(OSM_ROOF_SHAPE_MAP).every((v) => ROOF_TYPES.includes(v)));
});

// ── §16/§17 航空写真が要る型は自動生成しない ─────────────────────────────
test('35A §16/§17 塔屋・段差は航空写真が要る型として隔離されている', () => {
  assert.ok(NEEDS_IMAGERY_TYPES.has('FLAT_WITH_PENTHOUSE'));
  assert.ok(NEEDS_IMAGERY_TYPES.has('MULTI_LEVEL_FLAT'));
  // 用途や高さから塔屋を生やす経路が無いこと
  assert.ok(!/penthouse[^\n]*(heightM|storeys|usageCategory)/i.test(fs.readFileSync(path.join(ROOT, 'tools', 'lib', 'umeda-roof-inference.js'), 'utf-8')));
});

test('35A §19 FLAT は LOD1 の上面のまま（geometry を作らない）', () => {
  assert.ok(NO_GEOMETRY_TYPES.has('FLAT'));
  assert.ok(NO_GEOMETRY_TYPES.has('UNKNOWN'));
});

// ── §14/§15 geometry の拘束 ──────────────────────────────────────────────
test('35A §15 勾配屋根を載せても全高は canonical の高さのまま', () => {
  const g = buildSlopedRoof(SQUARE, 12, 'GABLE', 0);
  assert.ok(g, '生成できる');
  assert.ok(Math.abs(g.ridgeY - 12) < 1e-6, 'ridgeY=' + g.ridgeY);
  assert.ok(g.wallTopY < 12 && g.wallTopY > 0, 'wallTopY=' + g.wallTopY);
  let maxY = -Infinity;
  for (let i = 1; i < g.positions.length; i += 3) maxY = Math.max(maxY, g.positions[i]);
  assert.ok(maxY <= 12 + 1e-6, '全高を超えない maxY=' + maxY);
});

test('35A §14 屋根の頂点が footprint の外へ出ない', () => {
  const g = buildSlopedRoof(SQUARE, 12, 'GABLE', 0);
  const bad = guardRoof(g, SQUARE, 12);
  assert.equal(bad.ok, true, 'guard が通る: ' + JSON.stringify(bad));
  for (let i = 0; i < g.positions.length; i += 3) {
    const x = g.positions[i], z = g.positions[i + 2];
    assert.ok(pointInRing(x, z, SQUARE) || distToRing(x, z, SQUARE) <= GUARD.footprintEpsM,
      '外へ出た頂点 ' + x + ',' + z);
  }
});

test('35A §14 非凸 footprint でも棟が外へはみ出さない', () => {
  // L 字。OBB の端は建物の外になる。
  const L = [[0, 0], [40, 0], [40, 10], [12, 10], [12, 30], [0, 30], [0, 0]];
  const g = buildSlopedRoof(L, 10, 'GABLE', 0);
  if (g && g.ok) {
    assert.equal(guardRoof(g, L, 10).ok, true);
    for (let i = 0; i < g.positions.length; i += 3) {
      assert.ok(pointInRing(g.positions[i], g.positions[i + 2], L)
        || distToRing(g.positions[i], g.positions[i + 2], L) <= GUARD.footprintEpsM);
    }
  } else {
    // 収まらないなら作らない、が正しい挙動（§30）
    assert.equal(g.ok, false);
    assert.ok(g.reason, '作らなかった理由が付く: ' + JSON.stringify(g));
  }
});

test('35A §24 LOD1 を消す以上、壁も自前で出す（屋根だけを宙に浮かせない）', () => {
  const g = buildSlopedRoof(SQUARE, 12, 'GABLE', 0);
  const w = buildWalls(SQUARE, g.wallTopY);
  assert.ok(w.indices.length >= 6 * (SQUARE.length - 1), '各辺に壁がある');
  const ys = new Set();
  for (let i = 1; i < w.positions.length; i += 3) ys.add(w.positions[i]);
  assert.deepEqual([...ys].sort((a, b) => a - b), [0, g.wallTopY], '壁は 0 から軒まで');
  const m = mergeGeometry(g, w);
  assert.equal(m.positions.length, g.positions.length + w.positions.length);
  assert.equal(m.indices.length, g.indices.length + w.indices.length);
  assert.ok(Math.max(...m.indices) < m.positions.length / 3, 'index が範囲内へ付け替わっている');
  assert.equal(guardRoof({ ok: true, ...m }, SQUARE, 12).ok, true, '壁も footprint の内側');
});

test('35A §30 guard は footprint の外にある頂点を必ず捕まえる', () => {
  const fake = { ok: true, positions: [0, 1, 0, 200, 1, 200, 10, 1, 5], indices: [0, 1, 2], ridgeY: 5, wallTopY: 3, roofHeightM: 2, slopeDeg: 20 };
  const r = guardRoof(fake, SQUARE, 12);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'roof-outside-footprint');
});

test('35A §30 屋根の高さの上限・下限が決まっている', () => {
  assert.ok(GUARD.maxRoofHeightShare > 0 && GUARD.maxRoofHeightShare <= 0.5);
  assert.ok(GUARD.maxRoofHeightM > 0 && GUARD.minRoofHeightM > 0);
  assert.ok(GUARD.maxSlopeDeg <= 60 && GUARD.minSlopeDeg >= 5);
  // 屋根が全高の 35% を超えないように切られている
  const g = buildSlopedRoof(SQUARE, 12, 'GABLE', 0);
  assert.equal(g.ok, true);
  assert.ok(g.roofHeightM <= 12 * GUARD.maxRoofHeightShare + 1e-9, 'roofHeightM=' + g.roofHeightM);
  assert.ok(g.roofHeightM <= GUARD.maxRoofHeightM);
  assert.ok(g.slopeDeg >= GUARD.minSlopeDeg && g.slopeDeg <= GUARD.maxSlopeDeg, 'slopeDeg=' + g.slopeDeg);
  // 低すぎる建物には屋根を作らない
  assert.equal(buildSlopedRoof(SQUARE, 1.0, 'GABLE', 0).ok, false);
});

// ── §10 ground truth ─────────────────────────────────────────────────────
test('35A §10 実 LOD2 の面から屋根タイプを判定できる（水平面＝FLAT）', () => {
  const flat = { positions: [0, 10, 0, 20, 10, 0, 20, 10, 10, 0, 10, 0, 20, 10, 10, 0, 10, 10],
    indices: [0, 1, 2, 3, 4, 5] };
  const r = classifyRoof(flat, 200);
  assert.ok(FLAT_FAMILY.has(r.type), r.type + ' / ' + r.reason);
});

test('35A §10 傾いた 2 面は勾配屋根として判定される', () => {
  const gable = { positions: [0, 6, 0, 20, 6, 0, 20, 9, 5, 0, 9, 5,
    0, 9, 5, 20, 9, 5, 20, 6, 10, 0, 6, 10],
    indices: [0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7] };
  const r = classifyRoof(gable, 200);
  assert.ok(SLOPED_FAMILY.has(r.type) || r.type === 'COMPLEX', r.type + ' / ' + r.reason);
});

test('35A §10 三角形の法線と面積が正しい', () => {
  const t = triNormalArea([0, 0, 0], [2, 0, 0], [0, 0, 2]);
  assert.ok(Math.abs(t.area - 2) < 1e-6, 'area=' + t.area);
  assert.ok(Math.abs(Math.abs(t.n[1]) - 1) < 1e-6, '水平面の法線は ±Y');
});

test('35A §11 train/validation は屋根タイプ別に層化されている', () => {
  const recs = [];
  for (let i = 0; i < 100; i++) recs.push({ canonicalId: 'a' + i, roofType: 'FLAT' });
  for (let i = 0; i < 30; i++) recs.push({ canonicalId: 'b' + i, roofType: 'GABLE' });
  const s = stratifiedSplit(recs, 0.3, 7);
  const val = new Set(s.validation.map((r) => r.canonicalId));
  const vf = recs.filter((r) => val.has(r.canonicalId) && r.roofType === 'FLAT').length;
  const vg = recs.filter((r) => val.has(r.canonicalId) && r.roofType === 'GABLE').length;
  assert.ok(vf >= 28 && vf <= 32, 'FLAT の validation 数 ' + vf);
  assert.ok(vg >= 8 && vg <= 10, 'GABLE の validation 数 ' + vg);
  // 同じ seed なら同じ分割
  assert.deepEqual(stratifiedSplit(recs, 0.3, 7).validation.map((r) => r.canonicalId), s.validation.map((r) => r.canonicalId));
});

test('35A §11 CLASSIFY の閾値が意味のある範囲にある', () => {
  assert.ok(CLASSIFY.flatCosMin > 0.9 && CLASSIFY.flatCosMin < 1);
  assert.ok(CLASSIFY.slopeMinDeg >= 5 && CLASSIFY.slopeMaxDeg <= 80);
  assert.ok(CLASSIFY.penthouseMaxAreaShare < 0.5);
});

// ── §12/§13 評価 ─────────────────────────────────────────────────────────
test('35A §12 評価は UNKNOWN を「当たり」に数えない', () => {
  const e = evaluate([
    { truth: 'FLAT', predicted: 'UNKNOWN' },
    { truth: 'GABLE', predicted: 'GABLE' },
    { truth: 'HIP', predicted: 'GABLE' },
  ]);
  assert.equal(e.n, 3);
  assert.equal(e.unknown, 1);
  assert.ok(e.exactAccuracy <= 0.5 + 1e-9, 'exact=' + e.exactAccuracy);
  assert.ok(e.coverage < 1, 'coverage=' + e.coverage);
});

test('35A §13 品質基準が仕様の数字である', () => {
  assert.equal(QUALITY.roofTypeAccuracy, 0.85);
  assert.equal(QUALITY.ridgeMedianDeg, 10);
  assert.equal(QUALITY.roofIoUMedian, 0.85);
  assert.equal(meetsQuality({ exactAccuracy: 0.9, ridgeErrorDeg: { median: 5 }, roofIoU: { median: 0.9 }, n: 10 }), true);
  assert.equal(meetsQuality({ exactAccuracy: 0.5, ridgeErrorDeg: { median: 5 }, roofIoU: { median: 0.9 }, n: 10 }), false);
});

test('35A ringIoU は同一 ring で 1 に近く、離れた ring で 0', () => {
  assert.ok(ringIoU(SQUARE, SQUARE) > 0.95);
  assert.equal(ringIoU(SQUARE, [[500, 500], [520, 500], [520, 510], [500, 510], [500, 500]]), 0);
});

// ── §22 provenance ───────────────────────────────────────────────────────
test('35A §22 生成物に出所がすべて入っている', { skip: (() => {
  const r = rj(path.join(ROOT, 'public', 'map-data', 'osaka-city', 'derived-umeda-inferred-roof', 'inferred-roofs.json'));
  return r ? false : 'not built';
})() }, () => {
  const r = rj(path.join(ROOT, 'public', 'map-data', 'osaka-city', 'derived-umeda-inferred-roof', 'inferred-roofs.json'));
  for (const b of r.buildings) {
    for (const k of ['canonicalId', 'geometrySource', 'representation', 'roofSource',
      'roofInferenceMethod', 'roofInferenceConfidence', 'roofType', 'generationVersion']) {
      assert.ok(b[k] != null, k + ' が無い: ' + b.canonicalId);
    }
    assert.equal(b.representation, 'INFERRED_ROOF');
    assert.equal(b.geometrySource, 'PLATEAU_LOD1', '推定の土台は LOD1（実 LOD2 をコピーしていない §10）');
    assert.equal(b.roofSource, ROOF_SOURCE);
    assert.equal(b.generationVersion, GENERATION_VERSION);
    assert.equal(b.roofInferenceConfidence, 'HIGH', '§9 通常表示は HIGH のみ');
  }
});

test('35A §24 生成物に壁が入っている（地面から軒まで）', { skip: (() => {
  const r = rj(path.join(ROOT, 'public', 'map-data', 'osaka-city', 'derived-umeda-inferred-roof', 'inferred-roofs.json'));
  return r && r.buildings.length ? false : 'not built';
})() }, () => {
  const r = rj(path.join(ROOT, 'public', 'map-data', 'osaka-city', 'derived-umeda-inferred-roof', 'inferred-roofs.json'));
  for (const b of r.buildings) {
    assert.ok(b.wallIndexCount > 0, '壁が無い: ' + b.canonicalId);
    const ys = new Set();
    for (let i = 1; i < b.positions.length; i += 3) ys.add(b.positions[i]);
    assert.ok(ys.has(0), '地面に接する頂点が無い: ' + b.canonicalId);
    assert.ok(ys.has(b.wallTopY) && ys.has(b.ridgeY), '軒と棟がある');
    assert.equal(Math.max(...ys), b.totalHeightM, '最高点は canonical の全高（§15）');
  }
});

test('35A §1 推定の namespace が実 LOD2 と分かれている', { skip: (() => {
  const m = rj(path.join(ROOT, 'public', 'map-data', 'osaka-city', 'derived-umeda-inferred-roof', 'manifest.json'));
  return m ? false : 'not built';
})() }, () => {
  const m = rj(path.join(ROOT, 'public', 'map-data', 'osaka-city', 'derived-umeda-inferred-roof', 'manifest.json'));
  assert.equal(m.representation, 'INFERRED_ROOF');
  assert.ok(m.warning && /推定|PLATEAU 実 LOD2 ではない/.test(m.warning));
  assert.ok(!/building-lod-high/.test(m.namespace || ''));
});

// ── ランタイム（dev HTML）─────────────────────────────────────────────────
test('35A §1 dev の命名が REAL / ESTIMATED / BASE を区別している', () => {
  for (const n of REQUIRED_NAMES) assert.ok(html.includes(n), n + ' が dev に無い');
  assert.ok(html.includes('InferredRoofLayer'));
  assert.ok(/INFERRED_ROOF は推定であり PLATEAU 実 LOD2 ではない/.test(html), '混同しない旨の注記');
});

test('35A §23 実 LOD が推定より優先される（判定順）', () => {
  const iHigh = html.indexOf('BuildingLODLayer.isSuppressedBuilding(f.canonicalId)');
  const iInf = html.indexOf('__INFERRED_ROOF_LAYER__.isSuppressedBuilding');
  assert.ok(iHigh > 0 && iInf > 0);
  assert.ok(iInf > iHigh, '実 LOD2/LOD3 の判定のほうが先に来る');
});

test('35A §24 推定屋根を出す棟は LOD1 の tile を作り直す', () => {
  const s = html.indexOf('const InferredRoofLayer');
  const e = html.indexOf('window.__UMEDA_ROOF_MODE__', s);
  assert.ok(e > s, 'InferredRoofLayer の範囲が取れる');
  const body = html.slice(s, e);
  assert.ok(/invalidateBuildingTiles/.test(body),
    'HD ランドマーク 0 件だと何もしない invalidateLandmarkHdTiles に頼らない');
  assert.ok(!/CanonicalRuntime\.invalidateLandmarkHdTiles\(/.test(body), 'もう呼んでいない');
  assert.ok(/affectedTiles/.test(body));
});

test('35A §26 QA 色は dev だけ。通常表示では用途色のまま', () => {
  const s = html.indexOf('const InferredRoofLayer');
  const body = html.slice(s, html.indexOf('window.__UMEDA_ROOF_MODE__', s));
  assert.ok(/QA_COLOR = \{ HIGH: 0x35c46a, MEDIUM: 0xf0902a \}/.test(body));
  assert.ok(/if \(qa\) color = QA_COLOR/.test(body), 'QA モードのときだけ色を変える');
});

test('35A §27 クリック診断が「推定」と明示する', () => {
  assert.ok(/representation: 'INFERRED_ROOF', real: false, inferred: true/.test(html));
  assert.ok(/notGeneratedReason/.test(html), '作らなかった理由も返す');
  assert.ok(html.includes('__INFERRED_ROOF_INSPECT__'));
});

test('35A §28 3 モード切替がある', () => {
  assert.ok(html.includes('__UMEDA_ROOF_MODE__'));
  for (const m of ["'lod1'", "'real+inferred'"]) assert.ok(html.includes(m), m);
});

// ── §33 production / protected ───────────────────────────────────────────
test('35A §33 production に推定屋根が入っていない', { skip: fs.existsSync(PROD) ? false : 'no production' }, () => {
  // [Mission 35G] cutover 後は推定屋根のコードも production に入る。
  //   35A の要点は「証拠が足りないので推定屋根を通常表示にしない」ことなので、
  //   **既定で off** かつトグルが非表示の箱の中にあることで守る。
  const prod = fs.readFileSync(PROD, 'utf-8');
  assert.match(prod, /InferredRoofLayer/, 'cutover 後は入っているはず');
  assert.match(prod, /let group = null, enabled = false, qaMode = false, loaded = false, loading = null;/,
    '推定屋根が既定 on になっている');
  // 有効化するのは「real+inferred」を明示的に選んだときだけ（通常表示では off に戻す）
  assert.match(prod, /if \(m === 'real\+inferred'\) \{[^}]*InferredRoofLayer\.setEnabled\(true\);/);
  assert.match(prod, /InferredRoofLayer\.setEnabled\(false\);/);
});

// ── レポート（生成済みのときだけ）─────────────────────────────────────────
test('35A §5 航空写真の有無を事実として記録している', { skip: skip('umeda-roof-evidence.json') }, () => {
  const ev = rpt('umeda-roof-evidence.json');
  assert.ok(ev.aerialImagery, '航空写真の調査結果がある');
  assert.equal(typeof ev.aerialImagery.filesFound, 'number');
  assert.equal(ev.umeda.lod1OnlyTargets + ev.umeda.realHighLod, ev.umeda.canonicalPlateauTotal);
});

test('35A §3 対象は「LOD1 のみ」の PLATEAU 建物だけ', { skip: skip('umeda-inferred-roof-build.json') }, () => {
  const b = rpt('umeda-inferred-roof-build.json');
  const ev = rpt('umeda-roof-evidence.json');
  if (ev) assert.equal(b.stats.targets, ev.umeda.lod1OnlyTargets);
  assert.ok(b.stats.generated <= b.stats.targets);
});

test('35A §32 coverage で成功を測らない（生成数より証拠数が多くならない）', { skip: skip('umeda-inferred-roof-build.json') }, () => {
  const b = rpt('umeda-inferred-roof-build.json');
  const withShape = (b.stats.byEvidence || {})['osm-roof-shape'] || 0;
  assert.ok(b.stats.generated <= withShape, '証拠の数を超えて作っていない');
  const noEv = (b.stats.byEvidence || {})[NO_EVIDENCE] || 0;
  assert.ok(noEv > 0, '証拠が無い棟は LOD1 のまま残っている（これは失敗ではない §32）');
});

test('35A §1 実 PLATEAU LOD の数が変わっていない', { skip: (() => {
  const m = rj(path.join(ROOT, 'public', 'map-data', 'osaka-city', 'derived-v2-osmv2', 'building-lod-high', 'manifest.json'));
  return m ? false : 'no high lod manifest';
})() }, () => {
  const m = rj(path.join(ROOT, 'public', 'map-data', 'osaka-city', 'derived-v2-osmv2', 'building-lod-high', 'manifest.json'));
  assert.equal(m.lod2Count, REAL_LOD.lod2);
  assert.equal(m.lod3Count, REAL_LOD.lod3);
  assert.equal(m.buildingCount, REAL_LOD.total);
});

test('35A canonical の建物数が変わっていない', { skip: (() => {
  const m = rj(path.join(ROOT, 'data', 'processed', 'osaka-city', 'canonical', 'buildings-v2-osmv2', 'manifest.json'));
  return m ? false : 'no canonical manifest';
})() }, () => {
  const m = rj(path.join(ROOT, 'data', 'processed', 'osaka-city', 'canonical', 'buildings-v2-osmv2', 'manifest.json'));
  assert.equal(m.featureCount, TOTAL_BUILDINGS);
});

test('35A §37 PoC の範囲は梅田だけ', () => {
  assert.equal(UMEDA.id, 'umeda');
  assert.equal(UMEDA.radiusM, 700);
  const b = rpt('umeda-inferred-roof-build.json');
  if (b) assert.equal(b.area.id, 'umeda');
});

test('35A §35 validator の判定が両方の結果を出せる', { skip: skip('umeda-inferred-roof-validation.json') }, () => {
  const v = rpt('umeda-inferred-roof-validation.json');
  for (const k of ['realLodUnmodified', 'fabricatedPlateauLod2', 'inferredRoofClearlySeparated',
    'canonicalIdMutation', 'footprintMutation', 'projectionMutation',
    'highConfidenceOnlyForNormalDisplay', 'productionModified', 'protectedModified']) {
    assert.ok(k in v, k + ' が validation に無い');
  }
  assert.ok(['UMEDA_INFERRED_ROOF_POC_SUCCESS', 'UMEDA_INFERRED_ROOF_POC_FAILED'].includes(v.classification));
  assert.equal(v.fabricatedPlateauLod2, false);
  assert.equal(v.footprintMutation, 0);
  assert.equal(v.projectionMutation, 0);
  assert.equal(v.canonicalIdMutation, 0);
});
