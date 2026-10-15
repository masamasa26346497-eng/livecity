'use strict';
// Mission 37H: 住吉区以外の実 PLATEAU 建物サンプル（北区・中央区）の静的検証。ネットワーク不要。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));
const SETS = [
  { id: 'kita', code: '27127' },
  { id: 'chuo', code: '27128' },
  { id: 'tennoji', code: '27109' },
  { id: 'nishi', code: '27106' },
];

function idsOf(dir) {
  const ids = [];
  for (const f of fs.readdirSync(path.join(ROOT, dir, 'ids'))) {
    if (f.startsWith('t_')) ids.push(...read(dir + '/ids/' + f));
  }
  return ids;
}

for (const s of SETS) {
  const dir = `public/mission37h-3dtiles/${s.id}-sample`;
  test(`${s.id}: build-report の棟数・ID 一意・bldg_ 接頭辞（新規採番なし）`, () => {
    const rep = read(dir + '/build-report.json');
    const ids = idsOf(dir);
    assert.strictEqual(ids.length, rep.totals.buildings);
    assert.strictEqual(new Set(ids).size, ids.length);
    assert.strictEqual(rep.totals.skipped, 0);
    assert.ok(ids.every((i) => /^bldg_[0-9a-f-]{36}$/.test(i)), 'CityGML gml:id 形式');
  });
  test(`${s.id}: attrs と ids が同じ建物集合で、区コードが一致`, () => {
    const ids = new Set(idsOf(dir));
    const attrIds = new Set();
    for (const f of fs.readdirSync(path.join(ROOT, dir, 'attrs'))) Object.keys(read(dir + '/attrs/' + f).byId).forEach((i) => attrIds.add(i));
    assert.strictEqual(attrIds.size, ids.size);
    for (const i of ids) assert.ok(attrIds.has(i));
    const src = read(dir + '/source.json');
    assert.strictEqual(src.wardCode, s.code);
    assert.ok(src.sourceMeshes.length >= 1 && /PLATEAU/.test(src.source));
    assert.ok(/限定取得/.test(src.note), '区全体と誤称しない');
  });
  test(`${s.id}: tileset.json が region 付きで、全 GLB が実在`, () => {
    const ts = read(dir + '/tileset.json');
    const [w, so, e, n] = ts.root.boundingVolume.region;
    const deg = (r) => (r * 180) / Math.PI;
    assert.ok(deg(w) > 135.3 && deg(e) < 135.7 && deg(so) > 34.5 && deg(n) < 34.8, '大阪市内の緯度経度');
    const uris = [];
    (function walk(nd) { if (nd.content) uris.push(nd.content.uri); (nd.children || []).forEach(walk); })(ts.root);
    assert.ok(uris.length > 0);
    for (const u of uris) assert.ok(fs.existsSync(path.join(ROOT, dir, u)), u);
  });
}

test('区をまたいだ canonicalId 衝突なし（住吉 9 tile + 北・中央・天王寺・西）', () => {
  const all = [...idsOf('public/mission37b-3dtiles/osaka-sumiyoshi-9tile'), ...SETS.flatMap((s) => idsOf(`public/mission37h-3dtiles/${s.id}-sample`))];
  assert.strictEqual(new Set(all).size, all.length);
});

test('37G ページ: 追加 tileset を tileset ごとの配信ベースで扱い、COVERAGE は実際に読み込めたものだけ', () => {
  const h = fs.readFileSync(path.join(ROOT, 'public/mission37g-osaka-24ward-mvp.html'), 'utf8');
  assert.ok(/EXTRA_SET_DEFS/.test(h) && /mission37h-3dtiles\/kita-sample\//.test(h) && /mission37h-3dtiles\/chuo-sample\//.test(h) && /tennoji-sample\//.test(h) && /nishi-sample\//.test(h));
  assert.ok(/tilesBaseOf\(feature\)/.test(h), 'sidecar/attrs は tileset 別 base（tile 名が区間で衝突するため）');
  assert.ok(/for \(const e of extraMeta\)[\s\S]{0,400}COVERAGE\[e\.source\.wardCode\]/.test(h));
  assert.ok(/区全体ではありません/.test(h), '一部配信を明記');
});

test('37H-2/39B: 追加 tileset は選択区でだけ mount し、切替で破棄する／PLATEAU 出典表示', () => {
  const h = fs.readFileSync(path.join(ROOT, 'public/mission37g-osaka-24ward-mvp.html'), 'utf8');
  assert.ok(/async function setBuildingWard/.test(h) && /scene\.primitives\.remove\(e\.tileset\)/.test(h));
  assert.ok(/gen !== bldgGen/.test(h));
  assert.ok(/国土交通省 Project PLATEAU/.test(h));
  assert.ok(!/Cesium3DTileset\.fromUrl\(def\.base/.test(h), '起動時に全 tileset を無条件ロードしない');
});

test('本番 HTML は 37H で変更されていない（参照なし）', () => {
  for (const f of ['public/osaka_3d_buildings.html', 'public/osaka_3d_buildings.fullward-v3.html']) {
    const p = path.join(ROOT, f);
    if (fs.existsSync(p)) assert.ok(!/mission37h/.test(fs.readFileSync(p, 'utf8')));
  }
});
