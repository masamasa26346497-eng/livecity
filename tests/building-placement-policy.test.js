// tests/building-placement-policy.test.js
// [Mission 31G-FIX6] Building Placement Policy（road/water 上の建物の render visibility）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pointInPolys, toPolys, decide, TH } from '../tools/build-building-placement-policy.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const R = (...s) => path.join(ROOT, ...s);
const rpt = (n) => { try { return JSON.parse(fs.readFileSync(R('data', 'reports', n), 'utf-8')); } catch { return null; } };
const htmlPath = R('public', 'osaka_3d_buildings.ward-ux-v1.html');
const html = fs.existsSync(htmlPath) ? fs.readFileSync(htmlPath, 'utf-8') : '';

// ── pure: hole 処理（中州・島は水面内としない §7/§21）──
test('[FIX6] pointInPolys: outer 内でも hole 内なら false（中州の建物を水没させない）', () => {
  const square = (cx, cz, r) => [[cx - r, cz - r], [cx + r, cz - r], [cx + r, cz + r], [cx - r, cz + r], [cx - r, cz - r]];
  const polyWithHole = [square(0, 0, 100), square(0, 0, 20)]; // 40x40 の島
  assert.equal(pointInPolys(0, 0, [polyWithHole]), false, '島の中心は水面外');
  assert.equal(pointInPolys(50, 50, [polyWithHole]), true, '島の外・水面内は true');
  assert.equal(pointInPolys(500, 500, [polyWithHole]), false, 'polygon の外は false');
});

test('[FIX6] toPolys: Polygon / MultiPolygon を [ [outer,hole...], ... ] へ正規化', () => {
  const p = toPolys({ geometryType: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] });
  assert.equal(p.length, 1);
  const mp = toPolys({ geometryType: 'MultiPolygon', coordinates: [[[[0, 0], [1, 0], [1, 1], [0, 0]]], [[[5, 5], [6, 5], [6, 6], [5, 5]]]] });
  assert.equal(mp.length, 2);
});

// ── pure: policy 判定 ──
const emptyConf = new Map();
const mkOv = (o) => ({ waterRatio: 0, roadRatio: 0, waterAreaM2: 0, roadAreaM2: 0, water: null, road: null, total: 100, ...o });

test('[FIX6 §2] footprint がほぼ完全に水面内 → SUPPRESS', () => {
  const d = decide({ id: 'x', fp: [], attr: { usageLabel: '専用住宅' }, areaM2: 80 }, mkOv({ waterRatio: 0.95, waterAreaM2: 76, water: { waterClass: 'river' } }), emptyConf, null);
  assert.equal(d.policy, 'SUPPRESS');
  assert.equal(d.reason, 'building-major-overlap-with-water');
});

test('[FIX6 §4/§6] 部分的な水域重なり（30–85%）→ REVIEW（推測で消さない）', () => {
  const d = decide({ id: 'x', fp: [], attr: {}, areaM2: 80 }, mkOv({ waterRatio: 0.45, waterAreaM2: 36, water: { waterClass: 'river' } }), emptyConf, null);
  assert.equal(d.policy, 'REVIEW');
});

test('[FIX6 §6] 小さな境界かすり → DISPLAY', () => {
  const d = decide({ id: 'x', fp: [], attr: {}, areaM2: 80 }, mkOv({ waterRatio: 0.05, waterAreaM2: 4 }), emptyConf, null);
  assert.equal(d.policy, 'DISPLAY');
});

test('[FIX6 §2] harbor の水域重なりは SUPPRESS せず REVIEW（港湾構造物の可能性）', () => {
  const d = decide({ id: 'x', fp: [], attr: {}, areaM2: 200 }, mkOv({ waterRatio: 0.9, waterAreaM2: 180, water: { waterClass: 'harbor' } }), emptyConf, null);
  assert.equal(d.policy, 'REVIEW');
});

test('[FIX6 §3] 高架・トンネル道路との重なりは EXEMPT（立体交差）', () => {
  const d = decide({ id: 'x', fp: [], attr: {}, areaM2: 200 }, mkOv({ roadRatio: 0.99, roadAreaM2: 190, road: { bridge: true, structure: null } }), emptyConf, null);
  assert.equal(d.policy, 'EXEMPT');
});

test('[FIX6 §2/§3] 駅舎・橋上施設など semantic は EXEMPT', () => {
  const d = decide({ id: 'x', fp: [], attr: { usageLabel: '駅施設' }, areaM2: 500 }, mkOv({ waterRatio: 0.9, waterAreaM2: 400, water: { waterClass: 'river' } }), emptyConf, null);
  assert.equal(d.policy, 'EXEMPT');
});

test('[FIX6 §4] 31E EXPLAIN の建物は SUPPRESS しない（EXEMPT / DISPLAY）', () => {
  const conf = new Map([['x', { action: 'EXPLAIN', resolvedCause: 'over-water-structure', conflictId: 'BW_1' }]]);
  const d = decide({ id: 'x', fp: [], attr: {}, areaM2: 80 }, mkOv({ waterRatio: 0.95, waterAreaM2: 76, water: { waterClass: 'river' } }), conf, null);
  assert.ok(d.policy === 'EXEMPT' || d.policy === 'DISPLAY');
  assert.notEqual(d.policy, 'SUPPRESS');
});

test('[FIX6 §4] 31E MANUAL_REVIEW の建物は REVIEW 維持（原則 DISPLAY・推測で消さない）', () => {
  const conf = new Map([['x', { action: 'MANUAL_REVIEW', resolvedCause: 'possible-osm-water-boundary-error', conflictId: 'BW_2' }]]);
  const d = decide({ id: 'x', fp: [], attr: {}, areaM2: 80 }, mkOv({ waterRatio: 0.99, waterAreaM2: 79, water: { waterClass: 'river' } }), conf, null);
  assert.equal(d.policy, 'REVIEW');
});

test('[FIX6 §3] 通常道路への 30–85% 重なり（都市計画決定幅）→ REVIEW/DISPLAY、SUPPRESS しない', () => {
  const d = decide({ id: 'x', fp: [], attr: {}, areaM2: 200 }, mkOv({ roadRatio: 0.5, roadAreaM2: 100, road: {} }), emptyConf, null);
  assert.notEqual(d.policy, 'SUPPRESS');
});

// ── データ検証（precompute 済みのとき）──
const man = (() => { try { return JSON.parse(fs.readFileSync(R('data', 'processed', 'osaka-city', 'derived', 'building-placement', 'manifest.json'), 'utf-8')); } catch { return null; } })();

test('[FIX6 §11] canonical building 件数 615,617 を維持（source 不変）', { skip: !man && 'no precompute' }, () => {
  assert.equal(man.canonicalBuildingCount, 615617);
  const c = man.policyCounts;
  assert.equal(c.DISPLAY + c.SUPPRESS + c.REVIEW + c.EXEMPT, 615617, 'policy 合計 = 総棟数');
});

test('[FIX6 §16] SUPPRESS は総棟数の 2% 未満（大量誤 SUPPRESS なし）', { skip: !man && 'no precompute' }, () => {
  assert.ok(man.policyCounts.SUPPRESS / 615617 < 0.02, 'SUPPRESS ' + man.policyCounts.SUPPRESS);
});

test('[FIX6 §25] placement tile は SUPPRESS/REVIEW/EXEMPT のみ・SUPPRESS reason は許可集合内', { skip: !man && 'no precompute' }, () => {
  const dir = R('data', 'processed', 'osaka-city', 'derived', 'building-placement');
  const allowedSuppress = new Set(['building-major-overlap-with-water', 'building-almost-entirely-inside-road-area']);
  let checked = 0;
  for (const t of man.tiles.slice(0, 40)) {
    const tile = JSON.parse(fs.readFileSync(path.join(dir, t.file), 'utf-8'));
    for (const e of Object.values(tile.policies)) {
      assert.ok(['SUPPRESS', 'REVIEW', 'EXEMPT'].includes(e.policy), 'invalid policy ' + e.policy);
      if (e.policy === 'SUPPRESS') assert.ok(allowedSuppress.has(e.reason), 'unexplained suppress: ' + e.reason);
      checked++;
    }
  }
  assert.ok(checked > 0);
});

test('[FIX6 §25] building-placement validator が PASS', { skip: !rpt('building-placement-validation.json') && 'no report' }, () => {
  const v = rpt('building-placement-validation.json');
  assert.equal(v.RESULT, 'PASS', JSON.stringify(v.errors || []));
  assert.equal(v.checks.explainBuildingWronglySuppressed, 0);
  assert.equal(v.checks.missingId, 0);
  assert.equal(v.checks.invalidPolicy, 0);
  assert.equal(v.checks.canonicalBuildingCountUnchanged, true);
});

// ── runtime 統合（HTML 静的）──
test('[FIX6 §12/§13/§23/§24] runtime は placement を tile lookup し SUPPRESS を除外', { skip: !html && 'no html' }, () => {
  assert.match(html, /async function ensurePlacement\(tx, tz\)/);
  assert.match(html, /building-placement\/tile_\$\{tx\}_\$\{tz\}\.json/);
  // ward filter の後に placement
  assert.match(html, /f\.attributes\.wardId\) === wardId[\s\S]{0,200}await ensurePlacement/);
  assert.match(html, /pp\.policy === 'SUPPRESS'\) \{[\s\S]{0,40}suppressedInTile\+\+;[\s\S]{0,400}continue;/);
});

test('[FIX6 §14/§19] placement debug API + status', { skip: !html && 'no html' }, () => {
  assert.match(html, /getPlacementDebug\(\)/);
  assert.match(html, /window\.__PLACEMENT_DEBUG__ = function/);
  assert.match(html, /抑制 水/);
  assert.match(html, /function pickSuppressed\(px, pz\)/);
});

test('[FIX6 §0/§9/§11] runtime は canonical geometry / source を書き換えない', { skip: !html && 'no html' }, () => {
  const s = html.indexOf('const CanonicalRuntime = (function');
  const e = html.indexOf("console.log('[CanonicalRuntime] READY');");
  const block = html.slice(s, e);
  assert.doesNotMatch(block, /\.coordinates\s*=\s*[^=]/);
  assert.doesNotMatch(block, /build-canonical|writeFileSync|fs\./);
});
