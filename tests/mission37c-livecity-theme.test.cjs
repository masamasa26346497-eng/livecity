'use strict';
/**
 * Mission 37C — Live City テーマ版 Cesium ページの静的ガード。
 *   npm test には未登録。 node --test tests/mission37c-livecity-theme.test.cjs
 *
 * 守りたいこと:
 *   1. 本番 HTML 2 ファイル / Mission 37B の POC 2 ファイルに手が入っていない
 *   2. canonicalId 体系が変わっていない（37C は読むだけ。採番しない）
 *   3. 投影定数が 37B / geoToThree() と同一
 *   4. レイヤー束の中身が manifest と合っていて、範囲外の座標が混ざっていない
 *   5. Cesium 標準 UI を消す指定と、地図の帰属表示を残す指定が両方ある
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PAGE = path.join(ROOT, 'public/mission37c-livecity-theme.html');
const SET = 'osaka-sumiyoshi-9tile';
const BUNDLE = path.join(ROOT, 'public/mission37c-layers', SET);
const TILESET_DIR = path.join(ROOT, 'public/mission37b-3dtiles', SET);
const html = fs.readFileSync(PAGE, 'utf-8');
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf-8'));
const manifest = readJson(path.join(BUNDLE, 'manifest.json'));

const tool = require('../tools/mission37c-build-theme-layers.cjs');

// ── 1. 触ってはいけないファイル ─────────────────────────────────
test('[37C] 本番 HTML と Mission 37B の POC に 37C のコードが混ざっていない', () => {
  const protectedFiles = [
    'public/osaka_3d_buildings.html',
    'public/osaka_3d_buildings.fullward-v3.html',
    'public/mission37b-livecity-cesium-tiles.html',
    'public/mission37b-3dtiles-poc.html',
  ];
  for (const f of protectedFiles) {
    const p = path.join(ROOT, f);
    if (!fs.existsSync(p)) continue;
    const src = fs.readFileSync(p, 'utf-8');
    for (const marker of ['mission37c', '__mission37c', 'lc-header', 'LayerRegistry']) {
      assert.ok(!src.includes(marker), f + ' に 37C の ' + marker + ' が入っている');
    }
  }
});

test('[37C] 37B の tileset / GLB / sidecar には触れていない（読むだけ）', () => {
  // ページは 37B の生成物を URL で参照するだけで、書き換えるコードを持たない
  assert.match(html, /mission37b-3dtiles\/' \+ SET \+ '\//);
  for (const bad of ['tileset.json\', JSON.stringify', 'writeFile', 'localStorage.setItem']) {
    assert.ok(!html.includes(bad), 'ページが 37B 生成物を書き換えようとしている: ' + bad);
  }
  assert.ok(fs.existsSync(path.join(TILESET_DIR, 'tileset.json')), '37B の tileset が無い');
});

// ── 2. canonicalId 体系 ─────────────────────────────────────────
test('[37C] canonicalId は 37B と同じ経路・同じ条件で取る', () => {
  assert.match(html, /getProperty\('canonicalId'\)/);
  assert.match(html, /\/\^bldg_\/\.test\(id\)/);
  // 新規採番をしていないこと
  assert.ok(!/canonicalId\s*=\s*['"`]/.test(html.replace(/getProperty\('canonicalId'\)/g, '')),
    'ページ内で canonicalId を生成している');
});

test('[37C] 属性サイドカーの id は 37B の ids/*.json と完全一致する', () => {
  const idsDir = path.join(TILESET_DIR, 'ids');
  const attrDir = path.join(BUNDLE, 'attrs');
  let checked = 0;
  for (const entry of manifest.buildings.tiles) {
    if (!entry.file) continue;
    const leafIds = path.join(idsDir, 't_' + entry.tx + '_' + entry.tz + '.json');
    if (!fs.existsSync(leafIds)) continue;
    const ids = readJson(leafIds);
    const attrs = readJson(path.join(attrDir, 't_' + entry.tx + '_' + entry.tz + '.json'));
    assert.equal(attrs.count, Object.keys(attrs.byId).length);
    for (const id of ids) {
      assert.ok(/^bldg_/.test(id), '想定外の canonicalId 形式: ' + id);
      assert.ok(Object.prototype.hasOwnProperty.call(attrs.byId, id),
        '3D Tiles の canonicalId が属性サイドカーに無い: ' + id);
    }
    checked += ids.length;
  }
  assert.ok(checked > 10000, '照合した canonicalId が少なすぎる: ' + checked);
});

// ── 3. 投影 ─────────────────────────────────────────────────────
test('[37C] 投影定数が Mission 37B / geoToThree() と同一', () => {
  assert.match(html, /clat:\s*34\.604208/);
  assert.match(html, /clon:\s*135\.525020/);
  assert.match(html, /mpd:\s*111320/);
  // znorth-neg-v1: 北 = -Z
  assert.match(html, /toLat\s*=\s*\(z\)\s*=>\s*PROJ\.clat\s*-\s*z\s*\/\s*PROJ\.mpd/);
  assert.equal(manifest.coordinateConvention, 'znorth-neg-v1');
  assert.equal(manifest.projection.clat, 34.604208);
  assert.equal(manifest.projection.clon, 135.525020);
  assert.equal(manifest.projection.metersPerDegree, 111320);

  // Mission 37B の Primitive 版 POC が持つ定数と突き合わせる（同じ値であること）
  const b37b = fs.readFileSync(path.join(ROOT, 'public/mission37b-livecity-cesium-tiles.html'), 'utf-8');
  assert.match(b37b, /SEARCH_CLAT = 34\.604208/);
  assert.match(b37b, /SEARCH_CLON = 135\.525020/);
  assert.match(b37b, /SEARCH_MPD\s*=\s*111320/);
});

// ── 4. レイヤー束 ───────────────────────────────────────────────
test('[37C] manifest のレイヤー一覧と実ファイルが一致する', () => {
  const expect = ['roads', 'railways', 'waterways', 'parks', 'labels'];
  assert.deepEqual(manifest.layers.map((l) => l.layer), expect);
  for (const l of manifest.layers) {
    const p = path.join(BUNDLE, l.file);
    assert.ok(fs.existsSync(p), '無い: ' + l.file);
    const j = readJson(p);
    const n = j.features ? j.features.length : j.items.length;
    assert.equal(n, l.count, l.layer + ' の件数が manifest と違う');
    assert.ok(n > 0, l.layer + ' が空');
  }
});

test('[37C] ベクタの頂点が bbox の外へ出ていない（切り出しが効いている）', () => {
  const b = manifest.bboxLocal;
  for (const l of manifest.layers.filter((x) => x.layer !== 'labels')) {
    const j = readJson(path.join(BUNDLE, l.file));
    for (const f of j.features) {
      for (const [x, z] of f.p) {
        // clipLine は境界の 1 つ外側の頂点を残すので、少し余裕を見る
        assert.ok(x >= b.minX - 4000 && x <= b.maxX + 4000, l.layer + ' x=' + x + ' が極端に外側');
        assert.ok(z >= b.minZ - 4000 && z <= b.maxZ + 4000, l.layer + ' z=' + z + ' が極端に外側');
      }
    }
  }
});

test('[37C] ラベルは bbox の中だけ・importance を持つ', () => {
  const b = manifest.bboxLocal;
  const j = readJson(path.join(BUNDLE, 'labels.json'));
  const kinds = new Set();
  for (const it of j.items) {
    assert.ok(it.x >= b.minX && it.x <= b.maxX && it.z >= b.minZ && it.z <= b.maxZ, '範囲外のラベル: ' + it.name);
    assert.ok(it.name && it.kind, 'name/kind の無いラベル');
    kinds.add(it.kind);
  }
  assert.ok(kinds.has('station'), '駅ラベルが無い');
  assert.ok(kinds.has('ward'), '区ラベルが無い');
});

test('[37C] 建物属性は全タイル分あり、高さが妥当', () => {
  assert.ok(manifest.buildings.buildings > 10000, '建物属性が少ない: ' + manifest.buildings.buildings);
  assert.equal(manifest.buildings.ward, '住吉区');
  for (const t of manifest.buildings.tiles) {
    const j = readJson(path.join(BUNDLE, t.file));
    assert.deepEqual(j.fields, ['h', 'usage', 'repX', 'repZ', 'z0']);
    for (const [id, a] of Object.entries(j.byId)) {
      assert.match(id, /^bldg_/);
      assert.ok(a[0] > 0 && a[0] < 400, '高さが異常: ' + id + ' = ' + a[0]);
    }
  }
});

test('[37C] 用途コードの対応表が全件を引ける', () => {
  const labels = manifest.usageLabels && manifest.usageLabels.labels;
  assert.ok(labels && Object.keys(labels).length >= 10, '用途ラベルが無い');
  let total = 0, covered = 0;
  for (const t of manifest.buildings.tiles) {
    for (const a of Object.values(readJson(path.join(BUNDLE, t.file)).byId)) {
      total++;
      if (a[1] != null && labels[a[1]]) covered++;
    }
  }
  assert.equal(covered, total, '用途ラベルで引けない建物がある: ' + (total - covered) + '/' + total);
});

// ── 5. ページの作り ─────────────────────────────────────────────
test('[37C] Cesium 標準 UI を全部オフにしている', () => {
  for (const opt of ['baseLayerPicker: false', 'geocoder: false', 'homeButton: false',
    'sceneModePicker: false', 'navigationHelpButton: false', 'animation: false',
    'timeline: false', 'fullscreenButton: false', 'infoBox: false', 'selectionIndicator: false']) {
    assert.ok(html.includes(opt), 'Viewer オプションが無い: ' + opt);
  }
  assert.match(html, /\.cesium-viewer-toolbar[^{]*\{[^}]*display:\s*none/);
});

test('[37C] 地図の帰属表示は残している（ion ロゴだけ外す）', () => {
  assert.match(html, /\.cesium-credit-logoContainer[^{]*\{\s*display:\s*none/);
  assert.ok(!/\.cesium-widget-credits[^{]*\{[^}]*display:\s*none/.test(html), 'クレジットごと消している');
  assert.match(html, /地理院タイル/);
  assert.match(html, /OpenStreetMap contributors/);
  // 常時表示（Credit の第2引数 true）
  assert.ok(!/new Cesium\.Credit\([^)]*,\s*false\)/.test(html), '折りたたみ扱いのクレジットがある');
});

test('[37C] レイヤーは registry 経由で、6 種類すべて登録されている', () => {
  assert.match(html, /LayerRegistry\.register\(/);
  for (const id of ['buildings', 'roads', 'railways', 'waterways', 'parks', 'labels']) {
    assert.ok(new RegExp("id: '" + id + "'").test(html), 'レイヤー未登録: ' + id);
  }
  // 各レイヤーは mount / applyVisible だけを実装する形になっている
  assert.match(html, /applyVisible\(on\)/);
});

test('[37C] 面レイヤーの高さが water < park < road < rail の順になっている', () => {
  const m = html.match(/const LAYER_H = \{([^}]*)\}/);
  assert.ok(m, 'LAYER_H が無い');
  const h = {};
  for (const [, k, v] of m[1].matchAll(/(\w+):\s*([\d.]+)/g)) h[k] = +v;
  assert.ok(h.waterways < h.parks, 'water が park より上');
  assert.ok(h.parks < h.roads, 'park が road より上');
  assert.ok(h.roads < h.railways, 'road が rail より上');
});

test('[37C] 背景地図の既定は白地図で、調整項目が 5 つある', () => {
  assert.match(html, /const DEFAULT_BASEMAP = 'gsi-blank'/);
  for (const k of ['brightness', 'contrast', 'saturation', 'gamma', 'alpha']) {
    assert.ok(new RegExp("\\['" + k + "'").test(html), '背景調整が足りない: ' + k);
  }
});

test('[37C] 選択色は Live City ブルー', () => {
  assert.match(html, /accent:\s*'#50a0ff'/);
  assert.match(html, /picked\.color = Cesium\.Color\.fromCssColorString\(C\.accent\)/);
});

// ── 6. 切り出しロジックの単体テスト ─────────────────────────────
test('[37C] clipLine: 範囲内の連なりを切り出し、境界の外側 1 点を残す', () => {
  const box = { minX: 0, maxX: 10, minZ: 0, maxZ: 10 };
  // 左から入って右へ抜ける
  const runs = tool.clipLine([[-5, 5], [2, 5], [8, 5], [15, 5]], box);
  assert.equal(runs.length, 1);
  assert.deepEqual(runs[0], [[-5, 5], [2, 5], [8, 5], [15, 5]]);
  // 一度出てまた入る → 2 本に割れる
  const two = tool.clipLine([[1, 1], [50, 1], [2, 2], [3, 3]], box);
  assert.equal(two.length, 2);
  // 全部外 → 空
  assert.deepEqual(tool.clipLine([[99, 99], [98, 98]], box), []);
  // 1 点しか残らない断片は捨てる
  assert.deepEqual(tool.clipLine([[99, 99], [5, 5], [99, 99]], box).length, 1);
});

test('[37C] localBox: 建物タイル範囲がローカル矩形になる', () => {
  const b = tool.localBox({ tx0: -6, tx1: -4, tz0: -3, tz1: -1 });
  assert.deepEqual(b, { minX: -3000, maxX: -1500, minZ: -1500, maxZ: 0 });
  assert.equal(tool.BUILDING_TILE_SIZE, 500);
});
