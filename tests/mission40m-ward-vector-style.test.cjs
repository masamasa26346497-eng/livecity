'use strict';
// 40M: 区単位の道路・河川の視認性（階層別の線幅・透明度・距離表示、区境界外のクリップ）。静的 + 抽出した純粋関数の評価。
const test = require('node:test'), assert = require('node:assert');
const fs = require('fs'), path = require('path');
const page = fs.readFileSync(path.join(__dirname, '..', 'public/mission37g-osaka-24ward-mvp.html'), 'utf8');

function extract(name) {
  const i = page.indexOf('function ' + name);
  assert.ok(i >= 0, name);
  let d = 0, j = page.indexOf('{', i);
  for (let k = j; k < page.length; k++) {
    if (page[k] === '{') d++;
    else if (page[k] === '}' && --d === 0) return page.slice(i, k + 1);
  }
  throw new Error('unbalanced ' + name);
}

test('区単位の道路スタイルは階層別に細く、細街路は距離で絞る。住吉の束 roadStyle は不変', () => {
  const ward = extract('roadStyleWard');
  assert.match(ward, /major.*width: 4\.5/s);
  assert.match(ward, /local|width: 1\.8/);
  assert.match(ward, /maxDist: 3000/);
  assert.match(ward, /maxDist: 12000/);
  const old = extract('roadStyle');
  assert.match(old, /width: 7\.5/);
  assert.match(old, /width: 3\.0/);
  assert.match(page, /roads: \(b, o, lv\) => makeLineLayer\('roads\.json', lv \? \(f\) => \(LC45I\.tierAllows\(lv, f\.tier\) \? roadStyleWard\(f\) : null\) : roadStyleWard/);
  assert.match(page, /makeLineLayer\('roads\.json', roadStyle\)\)\)/);   // 住吉束はそのまま
});

test('makeWardClip: 区内の線は保持、完全に外の線は捨て、境界をまたぐ線は隣接頂点 1 点まで', () => {
  const pointInRing = new Function(extract('pointInRing') + '; return pointInRing;')();
  const makeWardClip = new Function('pointInRing', extract('makeWardClip') + '; return makeWardClip;')(pointInRing);
  const clip = makeWardClip([{ outer: [[0, 0], [100, 0], [100, 100], [0, 100], [0, 0]] }]);
  assert.deepStrictEqual(clip([[10, 10], [20, 20]]), [[[10, 10], [20, 20]]]);
  assert.deepStrictEqual(clip([[500, 500], [600, 600]]), []);
  const r = clip([[50, 50], [150, 50], [300, 50], [900, 50]]);
  assert.deepStrictEqual(r, [[[50, 50], [150, 50]]]);
  // 穴（holes）の内側は区外扱い
  const c2 = makeWardClip([{ outer: [[0, 0], [100, 0], [100, 100], [0, 100], [0, 0]], holes: [[[40, 40], [60, 40], [60, 60], [40, 60], [40, 40]]] }]);
  assert.deepStrictEqual(c2([[50, 50], [55, 55]]), []);
});

test('mountWardVec は区ポリゴンでクリップし、取得不能なら従来動作。Google 参照なし', () => {
  assert.match(page, /makeWardClip\(w\.polygons\)/);
  assert.match(page, /clipKind = 'none'/);
  assert.match(page, /distanceDisplayCondition: ddc/);
  assert.doesNotMatch(extract('makeWardClip') + extract('roadStyleWard'), /google/i);
});
