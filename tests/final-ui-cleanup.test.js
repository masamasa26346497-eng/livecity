// tests/final-ui-cleanup.test.js
// [Mission 32R] FINAL UI CLEANUP（開発用パネルと property card / 最寄駅 / 検索文言）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { CANONICAL_STATION_COUNT } from '../tools/lib/canonical-baseline.js';

const require_ = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HTML_PATH = path.join(ROOT, 'public', 'osaka_3d_buildings.ward-ux-v1.html');
const html = fs.readFileSync(HTML_PATH, 'utf-8');
const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };
const rpt = (n) => rj(path.join(ROOT, 'data', 'reports', n));
const skip = (n) => (!rpt(n) && 'no report');

/** HTML から最寄駅まわりの関数だけを取り出して vm で動かす */
function stationSandbox(stations) {
  const s = html.indexOf('const NearestStation = (function () {');
  const e = html.indexOf('function buildPropertyData(d){');
  assert.ok(s > 0 && e > s);
  const ctx = {
    window: {}, Promise, Math, Number, Array, String,
    fetch: async () => ({ ok: true, json: async () => ({ stations }) }),
  };
  vm.createContext(ctx);
  vm.runInContext(html.slice(s, e) + '; this.NS = NearestStation; this.text = nearestStationText; this.centroid = footprintCentroid;', ctx);
  return ctx;
}
const sq = (cx, cz, h) => [[cx - h, cz - h], [cx + h, cz - h], [cx + h, cz + h], [cx - h, cz + h]];

test('[32R §1-§3] property card は開発用パネルより前面。card 表示中はパネルを card の左へ退避し、画面内に収める', () => {
  assert.match(html, /#prop-card\{z-index:99998 !important;max-height:calc\(100vh - var\(--lc-topbar-h\) - 28px\);overflow-y:auto !important\}/);
  assert.match(html, /body\.lc-prop-card-open #canonical-runtime-status\{right:calc\(20px \+ 280px \+ 12px\) !important\}/);
  // パネルは消さない（QA 用）。z-index はパネル < card
  const panelZ = Number(html.match(/'position:fixed', 'right:12px', 'bottom:12px', 'z-index:(\d+)'/)[1]);
  assert.ok(panelZ < 99998);
  assert.match(html, /new MutationObserver\(sync\)\.observe\(card, \{ attributes: true, attributeFilter: \['style'\] \}\)/);
  // 狭い画面（card が下端シート）ではパネルを動かさず薄くして操作を妨げない
  assert.match(html, /body\.lc-prop-card-open #canonical-runtime-status\{right:12px !important;opacity:\.35;pointer-events:none\}/);
});

test('[32R §5-§9] 最寄駅: 直書きの駅リスト・乱数・徒歩時間を使わない', () => {
  assert.doesNotMatch(html, /const STATIONS = \[/);
  assert.doesNotMatch(html, /walkMin/);
  assert.doesNotMatch(html, /'（徒歩'\+/);
  assert.doesNotMatch(html, /弁天町駅/);
  assert.match(html, /document\.getElementById\('pc-station'\)\.textContent = nearestStationText\(d\);/);
  // 公開している駅データは canonical と同一。件数は canonical-baseline が正本
  //   （35F で 233 → 253。北部の駅が旧 PBF の切断で欠けていた）。
  const pub = fs.readFileSync(path.join(ROOT, 'public', 'map-data', 'osaka-city', 'derived', 'rail-stations.json'));
  const canon = fs.readFileSync(path.join(ROOT, 'data', 'processed', 'osaka-city', 'canonical', 'rail', 'stations.json'));
  assert.ok(pub.equals(canon));
  assert.equal(JSON.parse(pub).stations.length, CANONICAL_STATION_COUNT);
});

test('[32R §7/§8] 最寄駅は建物重心からの world 距離で決まり、直線距離として表示する', async () => {
  const ctx = stationSandbox([
    { stationId: 'a', name: '大阪', point: [0, 0] },
    { stationId: 'b', name: '北新地駅', point: [500, 0] },
    { stationId: 'c', name: '遠い', point: [0, 3000] },
  ]);
  assert.equal(ctx.text({ id: 'x', fp: sq(0, 0, 5) }), '駅データ読み込み中…');
  await ctx.NS.load();
  assert.equal(ctx.NS.isReady(), true);
  assert.equal(ctx.text({ id: 'x', fp: sq(80, 10, 5) }), '大阪駅（直線距離 約80m）');
  assert.equal(ctx.text({ id: 'y', fp: sq(420, 0, 5) }), '北新地駅（直線距離 約80m）', '「駅」を二重に付けない');
  assert.equal(ctx.text({ id: 'z', fp: sq(0, 2000, 5) }), '遠い駅（直線距離 約1.0km）');
  const q = ctx.window.__NEAREST_STATION_DEBUG__().lastQuery;
  assert.equal(q.station, '遠い');
  assert.equal(q.distanceM, 1000);
  // 面積重心（L 字でも頂点平均ではない）
  const c = ctx.centroid([[0, 0], [10, 0], [10, 1], [1, 1], [1, 10], [0, 10]]);
  assert.ok(Math.abs(c[0] - 54.5 / 19) < 1e-9 && Math.abs(c[1] - 54.5 / 19) < 1e-9, JSON.stringify(c));
  assert.equal(ctx.text({ id: 'w', fp: [] }), '—');
});

test('[32R §10] 駅データの北端（OSM 抽出 34.74°）より北、または北端の方が近い建物では駅名を断定しない', async () => {
  const ctx = stationSandbox([{ stationId: 'a', name: '崇禅寺', point: [0, -14112] }]);
  await ctx.NS.load();
  const limitZ = ctx.window.__NEAREST_STATION_DEBUG__().coverage.northLimitZ;
  assert.equal(limitZ, Math.round(-((34.74 - 34.604208) * 111320)));
  const cov = rpt('osm-source-coverage.json');
  assert.equal(cov.latCliff.cliffLat, 34.74, 'HTML の北端は osm-source-coverage.json の実測値と一致');
  assert.equal(ctx.text({ id: 'north', fp: sq(0, -15576, 5) }), '—（この付近は駅データ未整備）');
  assert.equal(ctx.text({ id: 'edge', fp: sq(0, -14700, 5) }), '—（この付近は駅データ未整備）', '北端までの距離 < 最寄駅までの距離');
  assert.equal(ctx.text({ id: 'south', fp: sq(0, -14000, 5) }), '崇禅寺駅（直線距離 約110m）');
});

test('[32R §11-§13] 検索: 範囲判定は 24 区。文言に特定エリア名を使わない。開発版 HTML に旧表記が無い', () => {
  assert.doesNotMatch(html, /南港南/);
  assert.match(html, /showSearchMsg\(`「\$\{spot\.name\}」は現在の3Dデータ提供範囲外です。方向のみ表示しています。`\);/);
  assert.match(html, /const inRange = isInside3dDataArea\(x, z\);/);
  assert.doesNotMatch(html, /const inRange = Math\.abs\(x\) <= 2400 && Math\.abs\(z\) <= 550;/);
  assert.match(html, /<div class="meta">PLATEAU CityGML \/ 大阪市 24区<\/div>/);
});

test('[32R §14] runtime: 駅データを読み、検索の範囲判定が 24 区で動く', async () => {
  const { runInlineScript } = require_('./_ward-ux-v1-smoke-harness.cjs');
  const boot = runInlineScript(HTML_PATH, { fetchRoot: path.join(ROOT, 'public') });
  assert.ok(boot.ok, boot.error && boot.error.message);
  const w = boot.window;
  for (let i = 0; i < 100 && !w.__NEAREST_STATION_DEBUG__().ready; i++) await new Promise((r) => setTimeout(r, 50));
  const d = w.__NEAREST_STATION_DEBUG__();
  assert.equal(d.ready, true);
  assert.equal(d.count, CANONICAL_STATION_COUNT);
  assert.equal(d.source, 'map-data/osaka-city/derived/rail-stations.json');
  assert.equal(w.__CANONICAL_SELF_CHECK__().total, 0);
});

test('[32R §15/§19] validator が PASS', { skip: skip('final-ui-cleanup-validation.json') }, () => {
  const v = rpt('final-ui-cleanup-validation.json');
  assert.equal(v.RESULT, 'PASS', JSON.stringify(v.errors));
  assert.equal(v.classification, 'FINAL_UI_CLEANUP_SUCCESS');
  for (const k of ['buildingV2Mutation', 'roadV3Mutation', 'projectionMutation']) assert.equal(v[k], 0, k);
  assert.equal(v.propertyCardVisibleAboveDevPanel, true);
  assert.equal(v.nearestStationUsesCanonicalStationData, true);
  assert.equal(v.nearestStationUsesWorldDistance, true);
  assert.equal(v.staleNankoMinamiSearchText, false);
  assert.equal(v.productionModified, false);
  assert.equal(v.protectedModified, false);
});
