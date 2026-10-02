// tests/mission04b-river-building-conflict.test.js
// [Mission04-B] 小河川の建物干渉回避（実データ + HTML配線）。
//   純粋ロジックは tests/river-building-conflict.test.js。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from '../tools/lib/paths.js';

const DATA = path.join(PROJECT_ROOT, 'public', 'map-data', 'osaka-city', 'rivers-v2', 'rivers.json');
const html = fs.readFileSync(path.join(PROJECT_ROOT, 'public', 'osaka_3d_buildings.ward-ux-v1.html'), 'utf-8');
const hasData = fs.existsSync(DATA);
const MAJORS = new Set(['淀川', '大和川', '神崎川', '安治川', '木津川', '寝屋川', '道頓堀川']);

test('[Mission04-B] rivers.json: 各riverに riverClass(major/medium/minor/micro) が付く', { skip: !hasData && 'no data' }, () => {
  const d = JSON.parse(fs.readFileSync(DATA, 'utf-8'));
  // [Mission22] 3 階級 → [Mission28] micro 追加で 4 階級
  for (const r of d.rivers) assert.ok(['major', 'medium', 'minor', 'micro'].includes(r.riverClass), `${r.name || r.id}: riverClass=${r.riverClass}`);
  // 7河川はすべて major
  for (const r of d.rivers) if (MAJORS.has(r.name)) assert.equal(r.riverClass, 'major', `${r.name} が major でない`);
});

test('[Mission04-B] major river は suppress されない（品質維持）', { skip: !hasData && 'no data' }, () => {
  const d = JSON.parse(fs.readFileSync(DATA, 'utf-8'));
  const suppressedMajor = d.rivers.filter((r) => r.riverClass === 'major' && r.suppressed);
  assert.deepEqual(suppressedMajor.map((r) => r.name), [], 'major river が suppress されている');
});

test('[Mission04-B] 表示される minor waterway は建物干渉が小さい（centerInFrac<=0.35 / edgeInFrac<=0.40）', { skip: !hasData && 'no data' }, () => {
  const d = JSON.parse(fs.readFileSync(DATA, 'utf-8'));
  const shownMinors = d.rivers.filter((r) => r.riverClass === 'minor' && r.ok && !r.suppressed);
  assert.ok(shownMinors.length > 0, '表示minorが0');
  for (const r of shownMinors) {
    assert.ok((r.conflictCenterInFrac || 0) <= 0.35, `${r.name || r.id}: 表示中なのに centerInFrac=${r.conflictCenterInFrac}`);
    assert.ok((r.conflictEdgeInFrac || 0) <= 0.40, `${r.name || r.id}: 表示中なのに edgeInFrac=${r.conflictEdgeInFrac}`);
  }
});

test('[Mission04-B] minor は conservative 幅（widthRaw <= 30m）', { skip: !hasData && 'no data' }, () => {
  const d = JSON.parse(fs.readFileSync(DATA, 'utf-8'));
  for (const r of d.rivers) {
    if (r.riverClass !== 'minor') continue;
    assert.ok(r.widthRaw <= 30 + 1e-6, `${r.name || r.id}: minor widthRaw=${r.widthRaw} > 30m`);
  }
});

test('[Mission04-B] 干渉検出があり、suppress/shrin で解消している（conflictStats）', { skip: !hasData && 'no data' }, () => {
  const rep = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'data', 'reports', 'river-layer-generation.json'), 'utf-8'));
  assert.ok(rep.conflict, 'conflict レポートが無い');
  assert.ok(rep.conflict.conflictBefore > 0, '干渉検出が0（チェックが機能していない疑い）');
  assert.ok(rep.conflict.suppress + rep.conflict.shrink >= rep.conflict.conflictBefore * 0.5,
    `干渉に対する対処が少なすぎる（before=${rep.conflict.conflictBefore} suppress=${rep.conflict.suppress} shrink=${rep.conflict.shrink}）`);
});

test('[Mission04-B] HTML: build() が suppressed river をスキップする', () => {
  assert.ok(/if \(r\.suppressed\) \{ skippedSuppressed\+\+; continue; \}/.test(html), 'build() が suppressed をスキップしていない');
});

test('[Mission04-B] HTML: riverClass で major/medium/minor/micro を分ける（無い旧データは幅/名前でfallback）', () => {
  // [Mission22] 3 階級 → [Mission28] micro tier 分岐
  assert.ok(/const tier = r\.riverClass \|\| \(\(Number\.isFinite\(r\.width\) && r\.width >= MAJOR_WIDTH_M\)/.test(html), 'tier 優先の分類になっていない');
  assert.ok(/tier === 'major' \? majorPos : tier === 'medium' \? mediumPos : tier === 'micro' \? microPos : minorPos/.test(html), 'micro バケットが無い');
});

test('[Mission04-B] HTML: minor LOD 抑制強化（MINOR_HIDE_DISTANCE_M=4500・中景fade）', () => {
  assert.ok(/const MINOR_HIDE_DISTANCE_M = 4500;/.test(html), 'MINOR_HIDE_DISTANCE_M が 4500 でない');
  assert.ok(/const MINOR_FADE_START_M = 3500;/.test(html), 'MINOR_FADE_START_M が無い');
  // Mission05: band3の値 base に対して追加fade
  assert.ok(/minorMesh\.material\.opacity = base \* \(1 - 0\.85 \* mt\)/.test(html), 'minor 中景fade が無い');
});

test('[Mission04-B] HTML: getConflictDebug デバッグAPIが公開されている', () => {
  assert.ok(/function getConflictDebug\(opts\) \{/.test(html), 'getConflictDebug 未定義');
  const idx = html.indexOf('function getConflictDebug(opts) {');
  const body = html.slice(idx, idx + 1200);
  for (const f of ['sourceId', 'rawWidth', 'finalWidth', 'action', 'suppressed', 'edgeInFrac', 'centerInFrac']) {
    assert.ok(body.includes(f), `getConflictDebug の行に ${f} が無い`);
  }
  assert.ok(/getConflictDebug,\s*\n?\s*\};/.test(html) || /getDefaultStyle, getConflictDebug,/.test(html), 'getConflictDebug が公開されていない');
});

test('[Mission04-B] HTML: [RIVER-CONFLICT] console ログを出す', () => {
  assert.ok(/\[RIVER-CONFLICT\] minor=\$\{minorCount \+ suppress\}/.test(html), '[RIVER-CONFLICT] ログが無い');
});

test('[Mission04-B] geometry/width ロジックは不変（Mission04-Bは表示制御のみ）', () => {
  const body = html.slice(html.indexOf('const RiverLayerV2 = (function () {'));
  assert.ok(/const Y = MAP_LAYER_Y\.WATER;/.test(body), 'y基準が変わっている');
  assert.ok(!/buildRiverRibbon|offsetCenterline/.test(body), 'HTMLがribbon生成をやり直している');
});

test('protected baseline fullward-v3.html は Mission04-B の変更を含まない', () => {
  const fw = fs.readFileSync(path.join(PROJECT_ROOT, 'public', 'osaka_3d_buildings.fullward-v3.html'), 'utf-8');
  assert.ok(!/getConflictDebug|MINOR_FADE_START_M|RIVER-CONFLICT/.test(fw), 'fullward-v3.html に Mission04-B の変更が混入');
});
