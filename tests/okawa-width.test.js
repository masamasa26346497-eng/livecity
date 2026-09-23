// tests/okawa-width.test.js
// [追加修正タスク｜大川の実幅補正]
//   強実測 named river（riverbank polygon 十分）の過剰 shrink を防ぐ一般化ロジック +
//   大川専用 regression + 他主要河川の非劣化。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from '../tools/lib/paths.js';
import { resolveRiverWidth } from '../tools/lib/river-width.js';

const RIVERS = path.join(PROJECT_ROOT, 'public', 'map-data', 'osaka-city', 'rivers-v2', 'rivers.json');
const AUDIT = path.join(PROJECT_ROOT, 'data', 'reports', 'okawa-width-audit.json');
const rj = fs.existsSync(RIVERS) ? JSON.parse(fs.readFileSync(RIVERS, 'utf-8')) : null;
const audit = fs.existsSync(AUDIT) ? JSON.parse(fs.readFileSync(AUDIT, 'utf-8')) : null;
const bySeg = (nm) => (rj ? rj.rivers.filter((r) => r.normName === nm && r.ok) : []);

// ── 幅計測 純ロジック ──
test('[大川] resolveRiverWidth: riverbank polygon から横断計測 / samples を返す', () => {
  // 合成: 東西に伸びる centerline、上下に 40m 幅の riverbank polygon
  const line = { name: 'テスト川', waterClass: 'river', p: [[0, 0], [100, 0], [200, 0], [300, 0]] };
  const bank = { name: 'テスト川', waterClass: 'river', p: [[-10, -20], [310, -20], [310, 20], [-10, 20]] };
  const w = resolveRiverWidth(line, [bank], { bufferM: 300 });
  assert.equal(w.method, 'measured');
  assert.ok(Math.abs(w.width - 40) < 3, 'measured width ≈ 40m: ' + w.width);
  assert.ok(w.matchedRiverbanks >= 1);
  assert.ok(Array.isArray(w.samples) && w.samples.length >= 3, 'samples[] を返す');
});

test('[大川] resolveRiverWidth: riverbank が無ければ default（measured にならない）', () => {
  const line = { name: '無帯川', waterClass: 'river', p: [[0, 0], [500, 0]] };
  const w = resolveRiverWidth(line, [], { bufferM: 300 });
  assert.notEqual(w.method, 'measured');
  assert.equal(w.matchedRiverbanks, 0);
});

// ── build 側の一般化ロジック（build-river-layer.js のソース検査）──
test('[大川] build-river-layer: 強実測 medium は建物干渉 shrink の対象外（一般化・ハードコードなし）', () => {
  const src = fs.readFileSync(path.join(PROJECT_ROOT, 'tools', 'build-river-layer.js'), 'utf-8');
  assert.ok(/function isStrongWideMeasured\(wres\)/.test(src), 'isStrongWideMeasured が無い');
  assert.ok(/wres\.method === 'measured'\s*\n?\s*&& \(wres\.matchedRiverbanks \|\| 0\) >= STRONG_RB_MIN/.test(src), '判定が matchedRiverbanks ベースでない');
  assert.ok(/const STRONG_RB_MIN = \d+;/.test(src));
  assert.ok(/const STRONG_MEASURED_MIN_W = \d+;/.test(src));
  // 大川という名前で分岐していない（一般化: 名前の等値比較で幅を決めていない）
  assert.ok(!/===\s*['"]大川['"]|['"]大川['"]\s*===|name\s*==\s*['"]大川['"]/.test(src),
    'build-river-layer が 大川 という名前で分岐している（ハードコード）');
  // conflictSegs から強実測 medium を除外
  assert.ok(/si\.riverClass === 'medium' && isStrongWideMeasured\(si\.wres\)/.test(src));
});

// ── 大川 regression（§6/§7）──
test('[大川] 実幅補正: median width が大幅改善（旧 8.4m → 実測 ~88m）', { skip: !rj && 'no rivers.json' }, () => {
  const segs = bySeg('大川');
  assert.ok(segs.length >= 1, '大川 が rivers.json に無い');
  for (const r of segs) {
    assert.equal(r.riverClass, 'medium');
    assert.equal(r.widthMethod, 'measured-strong', '強実測フラグが付いていない');
    assert.ok(r.conflictAction == null || r.conflictAction === 'keep', 'まだ shrink されている: ' + r.conflictAction);
    assert.ok(r.widthMedian >= 60, '大川 median width ' + r.widthMedian + 'm がまだ細い（>= 60 期待）');
    assert.ok(r.widthMedian <= 120, '大川 median width ' + r.widthMedian + 'm が広すぎる');
    // 幾何健全性
    assert.deepEqual(r.validationErrors || [], []);
    assert.ok((r.maxTriangleEdge || 0) < 2000, 'giant triangle edge');
    assert.ok((r.maxTriangleArea || 0) < 30000, 'giant triangle area');
  }
});

test('[大川] audit レポート: 実測 riverbank / diagnosis', { skip: !audit && 'no audit' }, () => {
  const o = audit.okawa;
  assert.equal(o.resolved, true);
  assert.ok(o.measurement.strongMeasurement, '強実測フラグ');
  assert.ok(o.measurement.perSegment[0].matchedRiverbanks >= 6, 'riverbank ' + o.measurement.perSegment[0].matchedRiverbanks);
  assert.ok(o.measurement.allRawSamples.median >= 60, '実測 median ' + o.measurement.allRawSamples.median);
  assert.ok(o.drawn[0].finalMedianWidth >= 60);
  assert.ok(/妥当/.test(o.diagnosis), 'diagnosis: ' + o.diagnosis);
});

// ── 他主要河川の非劣化（§0/§7）──
test('[大川] 主要7河川 regression: width median 不変（Mission04 baseline）', { skip: !rj && 'no rivers.json' }, () => {
  const EXPECT = { '淀川': 400, '大和川': 110, '神崎川': 127, '安治川': 67, '木津川': 173, '寝屋川': 60, '道頓堀川': 42 };
  for (const [nm, exp] of Object.entries(EXPECT)) {
    const segs = rj.rivers.filter((r) => r.name === nm && r.ok);
    assert.ok(segs.length > 0, nm + ' が無い');
    const all = segs.flatMap((s) => s.widths || []).filter(Number.isFinite).sort((a, b) => a - b);
    const med = all[Math.floor(all.length / 2)];
    const ratio = med / exp;
    assert.ok(ratio > 0.8 && ratio < 1.25, nm + ' median ' + med.toFixed(1) + ' が baseline ' + exp + ' から乖離');
    for (const s of segs) { assert.equal(s.riverClass, 'major'); assert.deepEqual(s.validationErrors || [], []); }
  }
});

test('[大川] 堂島川・土佐堀川（同じ強実測ロジック対象）は劣化していない', { skip: !rj && 'no rivers.json' }, () => {
  for (const [nm, lo, hi] of [['堂島川', 55, 80], ['土佐堀川', 40, 65]]) {
    const segs = bySeg(nm);
    assert.ok(segs.length > 0, nm + ' が無い');
    for (const r of segs) {
      assert.ok(r.widthMedian >= lo && r.widthMedian <= hi, nm + ' median ' + r.widthMedian + ' が [' + lo + ',' + hi + '] 外');
      assert.deepEqual(r.validationErrors || [], []);
      assert.ok(r.conflictAction == null || r.conflictAction === 'keep', nm + ' が shrink された');
    }
  }
});

test('[大川] 狭い運河（東横堀川）は依然として細い＝過補正していない', { skip: !rj && 'no rivers.json' }, () => {
  const segs = bySeg('東横堀川');
  assert.ok(segs.length > 0);
  for (const r of segs) {
    assert.ok(r.widthMedian <= 20, '東横堀川 median ' + r.widthMedian + ' — 狭い運河が太くなっている（強実測の閾値が緩すぎ）');
  }
});

// ── production / protected 不変 ──
test('[大川] protected HTML は変更していない（この修正は build データのみ）（production は 32U cutover で promoted build）', () => {
  for (const rel of ['osaka_3d_buildings.fullward-v3.html']) {   // [32U] production は promoted build になったため protected のみを守る
    const p = path.join(PROJECT_ROOT, 'public', rel);
    if (!fs.existsSync(p)) continue;
    const h = fs.readFileSync(p, 'utf-8');
    assert.ok(!/measured-strong|isStrongWideMeasured|STRONG_MEDIUM_MAX_W/.test(h), rel + ' に大川補正が混入');
  }
});
