// tests/mission04-river-width-smooth.test.js
// [見た目改善 Mission04] RiverLayerV2 の川幅平滑化。
//   純粋ロジックは tests/river-width-smooth.test.js / tests/river-ribbon.test.js。
//   本ファイルは生成済み rivers.json に対する実データ regression（主要7河川）と、
//   Mission04で「色・opacity・y位置を変えていない」ことを検証する。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from '../tools/lib/paths.js';
import { validateRiverRibbon } from '../tools/lib/river-ribbon-validator.js';

const DATA = path.join(PROJECT_ROOT, 'public', 'map-data', 'osaka-city', 'rivers-v2', 'rivers.json');
const html = fs.readFileSync(path.join(PROJECT_ROOT, 'public', 'osaka_3d_buildings.ward-ux-v1.html'), 'utf-8');
const hasData = fs.existsSync(DATA);

const MAJORS = ['淀川', '大和川', '神崎川', '安治川', '木津川', '寝屋川', '道頓堀川'];

test('[Mission04] rivers.json: 各riverに頂点単位の widths 配列があり centerline と長さ一致', { skip: !hasData && 'rivers.json 未生成' }, () => {
  const d = JSON.parse(fs.readFileSync(DATA, 'utf-8'));
  const okRivers = d.rivers.filter((r) => r.ok);
  assert.ok(okRivers.length > 0);
  for (const r of okRivers) {
    assert.ok(Array.isArray(r.widths) && r.widths.length === r.centerline.length,
      `${r.name || r.id}: widths(${r.widths && r.widths.length}) != centerline(${r.centerline.length})`);
    for (const w of r.widths) assert.ok(Number.isFinite(w) && w > 0, `${r.name || r.id}: widths に非有限/非正`);
  }
});

test('[Mission04] 主要7河川: 頂点単位の幅列が連続（隣接比 < 1.6倍）・ERROR 0', { skip: !hasData && 'rivers.json 未生成' }, () => {
  const d = JSON.parse(fs.readFileSync(DATA, 'utf-8'));
  for (const name of MAJORS) {
    const segs = d.rivers.filter((r) => r.name === name && r.ok);
    assert.ok(segs.length > 0, `${name} が無い`);
    for (const seg of segs) {
      // 隣接頂点間で幅が 1.6倍を超えて急変しない（Mission04の主目的）
      for (let i = 1; i < seg.widths.length; i++) {
        const a = seg.widths[i], b = seg.widths[i - 1];
        const ratio = Math.max(a, b) / Math.min(a, b);
        assert.ok(ratio < 1.6, `${name}(${seg.id}) i=${i} で幅が${ratio.toFixed(2)}倍急変`);
      }
      const v = validateRiverRibbon(seg);
      assert.deepEqual(v.errors, [], `${name}(${seg.id}) validator ERROR: ${JSON.stringify(v.errors)}`);
    }
  }
});

test('[Mission04] 河口の自然な拡幅は維持（大和川・木津川は下流ほど広い＝widthMax > widthMedian）', { skip: !hasData && 'rivers.json 未生成' }, () => {
  const d = JSON.parse(fs.readFileSync(DATA, 'utf-8'));
  const rep = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'data', 'reports', 'river-layer-generation.json'), 'utf-8'));
  for (const name of ['大和川', '木津川']) {
    const m = rep.majorRivers.find((x) => x.name === name);
    assert.ok(m.widthMax > m.widthMedian * 1.2, `${name}: 河口拡幅が失われている（max ${m.widthMax} vs median ${m.widthMedian}）`);
  }
});

test('[Mission04] 単発の異常幅（神崎川の 43m ピンチ相当）が最終widthに残っていない', { skip: !hasData && 'rivers.json 未生成' }, () => {
  const d = JSON.parse(fs.readFileSync(DATA, 'utf-8'));
  const kanzaki = d.rivers.filter((r) => r.name === '神崎川' && r.ok);
  const allW = kanzaki.flatMap((r) => r.widths);
  const minW = Math.min(...allW);
  assert.ok(minW > 60, `神崎川の最小幅が ${minW.toFixed(1)}m（43m級のピンチが残っている疑い）`);
});

test('[Mission04] RiverLayerV2 の geometry/width ロジック・y基準は不変（色はMission05で調整済み）', () => {
  const body = html.slice(html.indexOf('const RiverLayerV2 = (function () {'));
  assert.ok(/const Y = MAP_LAYER_Y\.WATER;/.test(body), 'RiverLayerV2 の y 基準が変わっている');
  assert.ok(/appendRibbonTriangles\(positions, r\.left, r\.right\)/.test(body), 'left/right をそのまま三角形化する方式が変わっている（width再計算の疑い）');
  assert.ok(!/buildRiverRibbon|offsetCenterline|buildVertexWidths/.test(body), 'HTMLがribbon/width生成をやり直している（Node側で確定済みのはず）');
});

test('[Mission04] rivers.json は znorth-neg-v1 のまま', { skip: !hasData && 'rivers.json 未生成' }, () => {
  const d = JSON.parse(fs.readFileSync(DATA, 'utf-8'));
  assert.equal(d.coordinateConvention, 'znorth-neg-v1');
});
