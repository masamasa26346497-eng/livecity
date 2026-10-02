// tests/fallback-building.test.js
// [追加修正タスク｜fallback建物の色未適用 & 選択範囲外建物の残留表示]
//   純ロジック（usage 正規化 / 既定カテゴリ / ward 所属）+ HTML 配線 + runtime。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { PROJECT_ROOT } from '../tools/lib/paths.js';
import {
  resolveFallbackUsage, toFallbackRecord, normalizeBuildingUsage,
  DEFAULT_BUILDING_CATEGORY, BUILDING_CATEGORY_LABEL, FALLBACK_USAGE_CATEGORY,
} from '../tools/lib/osm-building-fallback.js';

const require = createRequire(import.meta.url);
const HTML_PATH = path.join(PROJECT_ROOT, 'public', 'osaka_3d_buildings.ward-ux-v1.html');
const html = fs.readFileSync(HTML_PATH, 'utf-8');
const cbl = html.slice(html.indexOf('const CityBuildingLOD = (function'), html.indexOf('const CityModeManager = (function'));
const DS_DIR = path.join(PROJECT_ROOT, 'public', 'map-data', 'osaka-city', 'buildings', 'osaka-osm-fallback');
const COLOR_AUDIT = path.join(PROJECT_ROOT, 'data', 'reports', 'fallback-building-color-audit.json');
const SCOPE_AUDIT = path.join(PROJECT_ROOT, 'data', 'reports', 'fallback-building-ward-scope-audit.json');

function run() { return require('./_ward-ux-v1-smoke-harness.cjs').runInlineScript(undefined, { fetchRoot: path.resolve(PROJECT_ROOT, 'public') }); }
async function flush(n = 24) { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); }

// ── 純ロジック: usage 正規化 ──
test('[fallback色] resolveFallbackUsage: 全フィールド非 null / generic は既定カテゴリ', () => {
  const g = resolveFallbackUsage('yes');
  assert.equal(g.usage, null);                 // raw OSM タグは null（既存互換）
  assert.equal(g.normalizedUsage, 'yes');       // 正規化値は非 null
  assert.equal(g.category, DEFAULT_BUILDING_CATEGORY);
  assert.ok(g.usageLabel && g.usageLabel !== 'null' && !/その他\(null\)/.test(g.usageLabel));
  for (const t of ['', undefined, null, 'true', '1', 'nonsense_xyz_999']) {
    const r = resolveFallbackUsage(t);
    assert.ok(r.category && BUILDING_CATEGORY_LABEL[r.category], 'category が既定へ落ちる: ' + t);
    assert.ok(r.usageLabel && typeof r.usageLabel === 'string');
    assert.ok(r.normalizedUsage, 'normalizedUsage 非 null: ' + t);
  }
});

test('[fallback色] resolveFallbackUsage: 具体的な OSM 用途 → 用途カテゴリ', () => {
  assert.equal(resolveFallbackUsage('apartments').category, 'residential_mid');
  assert.equal(resolveFallbackUsage('house').category, 'residential_low');
  assert.equal(resolveFallbackUsage('detached').category, 'residential_low');
  assert.equal(resolveFallbackUsage('warehouse').category, 'industrial');
  assert.equal(resolveFallbackUsage('office').category, 'office');
  assert.equal(resolveFallbackUsage('retail').category, 'commercial');
  assert.equal(resolveFallbackUsage('hospital').category, 'medical');
  assert.equal(resolveFallbackUsage('school').category, 'school');
  assert.equal(resolveFallbackUsage('hotel').category, 'hotel');
  assert.equal(resolveFallbackUsage('train_station').category, 'public');
  // カテゴリは HTML の PRESET_WALL_COLOR / BLDG_PRESET のキーと同じ空間
  for (const cat of new Set(Object.values(FALLBACK_USAGE_CATEGORY))) {
    assert.ok(BUILDING_CATEGORY_LABEL[cat], cat + ' のラベルが無い');
  }
});

test('[fallback範囲] toFallbackRecord: wardId / normalizedUsage / usageCategory / usageLabel を保持', () => {
  const rec = toFallbackRecord(42, [[0, 0], [10, 0], [10, 10], [0, 10]], { building: 'yes' }, 'hole', 'kita');
  assert.equal(rec.wardId, 'kita');
  assert.equal(rec.usage, null);
  assert.equal(rec.normalizedUsage, 'yes');
  assert.equal(rec.usageCategory, 'other');
  assert.ok(rec.usageLabel && !/null/.test(rec.usageLabel));
  // wardId 未指定 → null（後方互換。3〜4 引数呼び出しも壊れない）
  assert.equal(toFallbackRecord(1, [[0, 0], [10, 0], [10, 10], [0, 10]], { building: 'yes' }).wardId, null);
  const r2 = toFallbackRecord(2, [[0, 0], [9, 0], [9, 9], [0, 9]], { building: 'apartments' }, 'hole', 'yodogawa');
  assert.equal(r2.usage, 'apartments'); // [Mission29 §2] 既存互換
  assert.equal(r2.usageCategory, 'residential_mid');
});

// ── build 出力データ ──
test('[fallback] 生成済み dataset: 全建物が wardId / usageCategory / usageLabel を持つ', { skip: !fs.existsSync(DS_DIR) && 'no dataset' }, () => {
  const wardIds = new Set(JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'public', 'map-data', 'osaka-city', 'boundaries', 'ward-classification-polygons.json'), 'utf-8')).wards.map((w) => w.wardId));
  let n = 0, bad = 0;
  for (const f of fs.readdirSync(DS_DIR)) {
    if (!/^tile_.*\.json$/.test(f)) continue;
    for (const b of JSON.parse(fs.readFileSync(path.join(DS_DIR, f), 'utf-8')).buildings || []) {
      n++;
      if (!b.wardId || !wardIds.has(b.wardId)) bad++;
      assert.ok(b.usageCategory && BUILDING_CATEGORY_LABEL[b.usageCategory], b.id + ' usageCategory=' + b.usageCategory);
      assert.ok(b.usageLabel && b.usageLabel !== 'null' && !/その他\(null\)/.test(b.usageLabel), b.id + ' usageLabel=' + b.usageLabel);
      assert.ok(b.normalizedUsage, b.id + ' normalizedUsage 欠落');
    }
  }
  assert.ok(n > 1000, 'fallback 建物が少なすぎる: ' + n);
  assert.equal(bad, 0, 'wardId 欠落/無効 ' + bad + ' 件');
});

// ── HTML 配線 ──
test('[fallback色] CityBuildingLOD: fallback は薄い用途色 tint（灰色ベタ塗りにしない）', () => {
  assert.ok(/function fallbackTint\(category\)/.test(cbl), 'fallbackTint が無い');
  assert.ok(/const FALLBACK_TINT_WHITE_BLEND = /.test(cbl), 'tint 白ブレンド定数が無い');
  assert.ok(/b\.__lodTint = fallbackTint\(b\.usageCategory\)/.test(cbl), 'fallback 建物へ tint 付与が無い');
  assert.ok(/const T = b\.__lodTint \|\| ONE3;/.test(cbl), 'appendBuilding が tint を使っていない');
  // PLATEAU LOD は tint 無し（ONE3）＝従来と同一
  assert.ok(/const ONE3 = \[1, 1, 1\];/.test(cbl));
});

test('[fallback範囲] CityBuildingLOD: fallback を区ごとに分割し applyBand で区スコープ', () => {
  assert.ok(/const FALLBACK_KEY_PREFIX = 'osm-fallback:';/.test(cbl));
  assert.ok(/if \(wardId === 'osm-fallback'\) \{/.test(cbl), 'fallback の区分割分岐が無い');
  assert.ok(/FALLBACK_KEY_PREFIX \+ fw/.test(cbl), '区キーが無い');
  assert.ok(/const wardScoped = !cityActive && !!curWard;/.test(cbl), 'Ward Mode 判定が無い');
  assert.ok(/wardScoped && wid !== curWard/.test(cbl), '非選択区 PLATEAU LOD の非表示化が無い');
  assert.ok(/s\.fbWard === curWard/.test(cbl), 'fallback の区スコープ判定が無い');
  // City Mode は従来どおり band 制御（applyBand に cityActive 判定がある）
  assert.ok(/CityModeManager\.isActive\(\)/.test(cbl), 'applyBand が City Mode を見ていない');
  assert.ok(/wid\.startsWith\(FALLBACK_KEY_PREFIX\)/.test(cbl), 'getStats が区キーを集計しない');
});

test('[fallback] Mission27 の band ロジック / setCameraDistance は不変', () => {
  assert.ok(/minor: visible && far, major: visible && \(far \|\| mid\)/.test(cbl), 'bandVisibility が変わった');
  assert.ok(/function setCameraDistance\(r\) \{\s*lastCameraDistance = r;\s*applyBand\(\);\s*\}/.test(cbl), 'setCameraDistance が変わった');
  assert.ok(!/requestAnimationFrame[\s\S]{0,200}applyBand\(\)/.test(html), 'applyBand が per-frame');
  const callers = (cbl.match(/applyBand\(\)/g) || []).length;
  assert.ok(callers >= 3 && callers <= 8, 'applyBand 呼び出し ' + callers);
});

test('[fallback色] popup: usage null を生で出さない', () => {
  assert.ok(/function usageDisplayName\(d\)/.test(html), 'usageDisplayName ヘルパが無い');
  assert.ok(!/\(UN\[d\.usage\]\|\|'その他'\)\+' \('\+d\.usage\+'\)'/.test(html), '生の その他+コード が残っている');
  assert.ok(!/\(UN\[d\.usage\]\|\|'その他'\)\+'（コード:'\+d\.usage/.test(html), '生の （コード:null） が残っている');
  assert.ok(/usageDisplayName\(d\)\+usageCodeSuffix\(d\)/.test(html));
});

test('[fallback] __FALLBACK_BUILDING_DEBUG__ / クリック建物デバッグ', () => {
  assert.ok(/window\.__FALLBACK_BUILDING_DEBUG__ =/.test(html));
  assert.ok(/function getFallbackDebug\(\)/.test(cbl));
  const fn = cbl.slice(cbl.indexOf('function getFallbackDebug'));
  for (const k of ['selectedWard', 'visibleFallbackBuildings', 'visiblePlateauBuildings', 'outOfWardVisibleCount', 'fallbackByWard']) {
    assert.ok(fn.includes(k), 'getFallbackDebug に ' + k + ' が無い');
  }
  assert.ok(/window\.__LAST_BUILDING_PICK__ = \{/.test(html), 'クリック建物デバッグが無い');
});

test('[fallback] protected HTML に本タスクの変更が混入していない（production は 32U cutover で promoted build）', () => {
  for (const rel of ['osaka_3d_buildings.fullward-v3.html']) {   // [32U] production は promoted build になったため protected のみを守る
    const p = path.join(PROJECT_ROOT, 'public', rel);
    if (!fs.existsSync(p)) continue;
    const h = fs.readFileSync(p, 'utf-8');
    assert.ok(!/__FALLBACK_BUILDING_DEBUG__|fallbackTint|FALLBACK_KEY_PREFIX|__lodTint/.test(h), rel + ' に混入');
  }
});

test('[fallback] インライン <script> の構文が壊れていない', () => {
  const js = html.match(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/i)[1];
  const f = path.join(os.tmpdir(), `fb-${process.pid}.js`);
  fs.writeFileSync(f, js);
  try { execFileSync('node', ['--check', f], { stdio: 'pipe' }); } finally { try { fs.unlinkSync(f); } catch { /* noop */ } }
});

test('[fallback] audit / validator レポートが PASS', { skip: !fs.existsSync(COLOR_AUDIT) && 'no audit' }, () => {
  assert.equal(JSON.parse(fs.readFileSync(COLOR_AUDIT, 'utf-8')).RESULT, 'PASS');
  if (fs.existsSync(SCOPE_AUDIT)) assert.equal(JSON.parse(fs.readFileSync(SCOPE_AUDIT, 'utf-8')).RESULT, 'PASS');
});

test('[fallback] runtime: 例外なく評価 / __FALLBACK_BUILDING_DEBUG__ が形を返す', async () => {
  const r = run();
  assert.ok(r.ok, r.error && r.error.stack);
  await flush();
  const d = r.window.__FALLBACK_BUILDING_DEBUG__();
  assert.ok(d && typeof d === 'object', 'デバッグ API が null');
  assert.ok('selectedWard' in d && 'visibleFallbackBuildings' in d && 'outOfWardVisibleCount' in d);
  // 既存 API 回帰
  assert.ok(typeof r.window.__MAJOR_BUILDING_LOD_DEBUG__ === 'function');
  assert.ok(typeof r.window.__BUILDING_COVERAGE_DEBUG__ === 'function');
});
