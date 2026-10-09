'use strict';
// Mission 37D 追加: 町丁目（住吉区）— 名称正規化 / 全件数・ID 一意 / 座標範囲 / ラベル切替 / 建物選択との両立（静的）
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const TN = require('../public/mission37d-data/town-normalize.js');
const { build } = require('../tools/mission37d-build-towns.cjs');

const ROOT = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'public', 'mission37d-sumiyoshi-mvp.html'), 'utf8');

test('正規化: 漢数字・全角数字・空白・接頭辞の揺れを同じキーにする', () => {
  const n = TN.normalizeTownName;
  assert.strictEqual(n('長居東四丁目'), '長居東4丁目');
  assert.strictEqual(n('長居東4丁目'), '長居東4丁目');
  assert.strictEqual(n('長居東４丁目'), '長居東4丁目');
  assert.strictEqual(n(' 長居東 四 丁目 '), '長居東4丁目');
  assert.strictEqual(n('大阪市住吉区我孫子西二丁目'), '住吉区我孫子西2丁目');
  assert.strictEqual(n('万代十二丁目'), '万代12丁目');
  assert.strictEqual(n('我孫子西2丁'), '我孫子西2丁目');
});

test('正規化: 丁目に隣接しない漢数字は変換しない', () => {
  assert.strictEqual(TN.normalizeTownName('四天王寺'), '四天王寺');
  assert.strictEqual(TN.normalizeTownName('三宅西'), '三宅西');
  assert.strictEqual(TN.kanjiToInt('二十'), 20);
  assert.strictEqual(TN.kanjiToInt('十'), 10);
  assert.strictEqual(TN.kanjiToInt('abc'), null);
});

test('照合: 丁目省略は前方一致、完全一致が最優先', () => {
  const rec = (name) => ({ key: TN.normalizeTownName(name), wardKey: '住吉区' });
  const k = TN.normalizeTownName;
  assert.strictEqual(TN.matchTown(k('長居東四丁目'), rec('長居東四丁目')), 3);
  assert.strictEqual(TN.matchTown(k('住吉区長居東4丁目'), rec('長居東四丁目')), 3);
  assert.strictEqual(TN.matchTown(k('長居東'), rec('長居東四丁目')), 2);
  assert.strictEqual(TN.matchTown(k('居東'), rec('長居東四丁目')), 1);
  assert.strictEqual(TN.matchTown(k('存在しない町'), rec('長居東四丁目')), 0);
  assert.strictEqual(TN.matchTown('', rec('長居東四丁目')), 0);
});

const data = build();

test('全件数: 住吉区は管理境界データの 104 件、ID・名称キーは一意', () => {
  assert.strictEqual(data.count, 104);
  assert.strictEqual(data.records.length, 104);
  assert.strictEqual(new Set(data.records.map((r) => r.id)).size, 104);
  assert.strictEqual(new Set(data.records.map((r) => r.key)).size, 104);
  for (const r of data.records) {
    assert.strictEqual(r.ward, '住吉区');
    assert.match(r.id, /^27120:\d{6}$/);
  }
});

test('形状: 暫定形状の有無を件数どおりに区別し、新規の形状は作らない', () => {
  assert.strictEqual(data.geometry.withGeometry + data.geometry.withoutGeometry, 104);
  assert.ok(data.geometry.withGeometry > 0, 'TOWN_POLYGONS から 1 件も結合できていない');
  for (const r of data.records) {
    assert.strictEqual(r.geometryStatus, r.rings.length ? 'legacy-unverified' : 'none');
  }
});

test('座標範囲: 全頂点が有限で、住吉区周辺（ローカル x/z ±8km）に収まる', () => {
  for (const r of data.records) {
    for (const ring of r.rings) {
      assert.ok(ring.length >= 3);
      for (const [x, z] of ring) {
        assert.ok(Number.isFinite(x) && Number.isFinite(z), r.id);
        assert.ok(Math.abs(x) < 8000 && Math.abs(z) < 8000, r.id + ' が範囲外: ' + x + ',' + z);
      }
    }
    if (r.rings.length) {
      assert.ok(r.cx >= r.bbox[0] - 1 && r.cx <= r.bbox[2] + 1, r.id + ' の重心が bbox 外(x)');
      assert.ok(r.cz >= r.bbox[1] - 1 && r.cz <= r.bbox[3] + 1, r.id + ' の重心が bbox 外(z)');
    } else {
      assert.strictEqual(r.cx, null);
    }
  }
});

test('統計: ある町丁目だけに付き、無い町丁目は null（捏造しない）', () => {
  for (const r of data.records) {
    if (r.stats) assert.ok(Number.isFinite(r.stats.population));
    else assert.strictEqual(r.stats, null);
  }
});

test('ラベル切替: 区名 / 町名 / 町丁目名の 3 段階と件数上限がある', () => {
  assert.match(html, /const TOWN_TIER = \{ ward: 4500, base: 1800 \}/);
  assert.match(html, /const TOWN_CAP = \{ base: \d+, full: \d+ \}/);
  assert.match(html, /function tierOf\(h\)/);
  assert.match(html, /declutter\(fullItems, TOWN_CAP\.full\)/);
  assert.match(html, /declutter\(baseItems, TOWN_CAP\.base\)/);
  assert.match(html, /camera\.changed\.addEventListener\(scheduleLabels\)/);
});

test('レイヤー: 町丁目境界 / 町丁目名ラベルが LayerRegistry に登録され、既存ラベル層は残る', () => {
  assert.match(html, /LayerRegistry\.register\(TownUI\.boundaryLayer\)/);
  assert.match(html, /LayerRegistry\.register\(TownUI\.labelLayerTown\)/);
  assert.match(html, /LayerRegistry\.register\(labelLayer\)/);
  assert.match(html, /id: 'towns'/);
  assert.match(html, /id: 'townlabels'/);
});

test('建物選択との両立: 町丁目は建物 / POI を pick できなかったときだけ判定し、canonicalId 経路は不変', () => {
  const h = html.indexOf('handler.setInputAction(async (click)');
  assert.ok(h > 0);
  const body = html.slice(h, html.indexOf('Cesium.ScreenSpaceEventType.LEFT_CLICK);', h));
  const iPoi = body.indexOf('picked.id.poi');
  const iTown1 = body.indexOf('clickTown(click.position)');
  const iCid = body.indexOf("picked.getProperty('canonicalId')");
  assert.ok(iPoi >= 0 && iTown1 > iPoi, 'POI 判定より前に町丁目判定が走っている');
  assert.ok(iCid > 0 && body.indexOf("/^bldg_/") > iCid);
  assert.strictEqual((body.match(/clickTown\(click\.position\)/g) || []).length, 2);
  // 町丁目の境界 / 塗りは pick 対象にしない（建物 pick を奪わない）
  assert.match(html, /allowPicking: false/);
  assert.doesNotMatch(html.slice(html.indexOf('const boundaryLayer'), html.indexOf('const labelLayerTown')), /id: \{/);
});

test('検索: 町丁目を区付きで表示し、0 件 / 未接続を明示する', () => {
  assert.match(html, /kind: '町丁目'/);
  assert.match(html, /町丁目データが未接続のため/);
  assert.match(html, /に一致する町丁目・駅・地名・施設はありません/);
  assert.match(html, /TownUI\.select\(h\.town, true\)/);
});

test('不変条件: 本番 HTML / 37B / 37C を参照して書き換えていない', () => {
  assert.doesNotMatch(html, /fetch\([^)]*osaka_3d_buildings/);
  assert.doesNotMatch(html, /writeFile/);
});
