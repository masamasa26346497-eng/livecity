'use strict';
// Mission 40A: 浪速区（PR#41 由来の PLATEAU 2 メッシュ・4,267 棟）の 37G 統合の静的検証。ネットワーク・ブラウザ不要。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));
const SETS = ['naniwa-mesh', 'naniwa-mesh2'].map((s) => 'public/mission38e-3dtiles/' + s);
const idsOf = (dir) => fs.readdirSync(path.join(ROOT, dir, 'ids')).filter((f) => f.startsWith('t_')).flatMap((f) => read(dir + '/ids/' + f));
const html = () => fs.readFileSync(path.join(ROOT, 'public/mission37g-osaka-24ward-mvp.html'), 'utf8');

test('浪速区 2 tileset: 区コード 27111、合計 4,267 棟、ID 形式は bldg_ のまま', () => {
  let total = 0;
  for (const d of SETS) {
    const src = read(d + '/source.json'), rep = read(d + '/build-report.json');
    assert.strictEqual(src.wardCode, '27111');
    assert.ok(/PLATEAU/.test(src.source) && /限定取得|メッシュ単位/.test(src.note), '区全体と誤称しない');
    const ids = idsOf(d);
    assert.strictEqual(ids.length, rep.totals.buildings);
    assert.strictEqual(new Set(ids).size, ids.length);
    assert.ok(ids.every((i) => /^bldg_[0-9a-f-]{36}$/.test(i)));
    total += ids.length;
  }
  assert.strictEqual(total, 4267);
});

test('浪速区 2 tileset 間と、既存 5 区との canonicalId 衝突なし（二重表示なし）', () => {
  const existing = [
    ...idsOf('public/mission37b-3dtiles/osaka-sumiyoshi-9tile'),
    ...['kita', 'chuo', 'tennoji', 'nishi'].flatMap((s) => idsOf(`public/mission37h-3dtiles/${s}-sample`)),
  ];
  const naniwa = SETS.flatMap(idsOf);
  assert.strictEqual(new Set(naniwa).size, naniwa.length);
  const ex = new Set(existing);
  assert.deepStrictEqual(naniwa.filter((i) => ex.has(i)), []);
});

test('tile 名は 2 tileset で衝突しうる → attrs/ids/GLB は tileset 別に実在し、参照が全て解決する', () => {
  const names = SETS.map((d) => new Set(fs.readdirSync(path.join(ROOT, d, 'tiles'))));
  const shared = [...names[0]].filter((n) => names[1].has(n));
  assert.ok(shared.length > 0, '同名 tile があるため tileset 別 base が必須');
  for (const d of SETS) {
    const ts = read(d + '/tileset.json');
    const uris = [];
    (function walk(n) { if (n.content) uris.push(n.content.uri); (n.children || []).forEach(walk); })(ts.root);
    assert.ok(uris.length > 0);
    for (const u of uris) assert.ok(fs.existsSync(path.join(ROOT, d, u)), d + '/' + u);
    const attrIds = new Set(fs.readdirSync(path.join(ROOT, d, 'attrs')).flatMap((f) => Object.keys(read(d + '/attrs/' + f).byId)));
    assert.deepStrictEqual([...attrIds].sort(), [...idsOf(d)].sort());
  }
});

test('追加バイナリは小さい（合計 6MB 未満）', () => {
  let bytes = 0;
  (function walk(p) { for (const e of fs.readdirSync(p, { withFileTypes: true })) { const f = path.join(p, e.name); e.isDirectory() ? walk(f) : (bytes += fs.statSync(f).size); } })(path.join(ROOT, 'public/mission38e-3dtiles'));
  assert.ok(bytes < 6 * 1024 * 1024, String(bytes));
});

test('37G ページ: 浪速区 2 tileset を登録し、1 区複数 tileset の mount/解放/合算が配線されている', () => {
  const h = html();
  assert.ok(/id: 'naniwa-mesh',\s+base: 'mission38e-3dtiles\/naniwa-mesh\/'/.test(h));
  assert.ok(/id: 'naniwa-mesh2',\s+base: 'mission38e-3dtiles\/naniwa-mesh2\/'/.test(h));
  assert.ok(/extraMeta\.filter\(\(m\) => m\.source\.wardCode === wardCode\)/.test(h), '区コードで複数 meta を取得');
  assert.ok(/Promise\.allSettled/.test(h) && /gen !== bldgGen/.test(h));
  assert.ok(/for \(const e of extraSets\.splice\(0\)\) \{ scene\.primitives\.remove\(e\.tileset\)/.test(h), '区切替で全 extra を解放');
  assert.ok(/a\.tiles \+= tiles; a\.buildings \+= n/.test(h), 'COVERAGE 合算');
  assert.ok(/tilesBaseOf\(feature\)/.test(h) && /extraSets\.find\(\(e\) => e\.base === tilesBaseOf\(picked\)\)/.test(h), 'sidecar は tileset 別 _lcBase');
});

test('回帰: 課金ロック・Google 参照なし・POI 予算/LRU が維持されている', () => {
  const h = html();
  assert.ok(!/places\.googleapis\.com|maps\.googleapis\.com/.test(h));
  assert.ok(/maxCachedWards: 3/.test(h));
  assert.ok(/mission37k-poi-select\.js/.test(h));
  assert.ok(/国土交通省 Project PLATEAU/.test(h));
});
