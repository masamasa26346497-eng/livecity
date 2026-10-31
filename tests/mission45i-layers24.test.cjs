'use strict';
// Mission 45I: 24区ベクタ（道路/河川/公園/鉄道/名称）。純粋ロジック・ビルダー（合成 fixture）・配信ガード・ページ配線の静的確認。
// ブラウザ実描画ではない。実 PC の旧 OSM タイルでの生成・24区の WebGL 描画は、この環境では未実施。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
const sb = {}; sb.window = sb;
vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'public/mission45i-vec.js'), 'utf8'), sb);
// vm の別 realm の配列/オブジェクトは deepStrictEqual で prototype が違うため、戻り値を JSON 往復して比較する
const V = {}; for (const [k, f] of Object.entries(sb.LC45I)) V[k] = typeof f === 'function' ? (...a) => { const r = f(...a); return r === undefined ? r : JSON.parse(JSON.stringify(r)); } : JSON.parse(JSON.stringify(f));
const B = require('../tools/mission45i-build-layers-24.cjs');
const S = require('../tools/mission45e-preview.cjs');
const wards = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/mission37g-data/osaka-24-wards.json'), 'utf8')).wards;
const html = fs.readFileSync(path.join(ROOT, 'public/mission37g-osaka-24ward-mvp.html'), 'utf8');
const mid = (w) => ({ x: (w.bbox.minX + w.bbox.maxX) / 2, z: (w.bbox.minZ + w.bbox.maxZ) / 2 });
const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), n));

test('vec plan: levels by height/distance, total <= maxWards, nothing when very high', () => {
  const c = mid(wards[0]);
  const near = V.plan({ ...c, height: 3000 }, wards, {});
  assert.strictEqual(near.want[wards[0].wardCode], 'near');
  assert.ok(Object.keys(near.want).length <= V.DEFAULTS.maxWards);
  assert.ok(Object.values(near.want).filter((l) => l === 'near').length <= V.DEFAULTS.nearMax);
  const city = V.plan({ ...c, height: 50000 }, wards, {});
  assert.ok(Object.values(city.want).every((l) => l === 'far'));
  assert.deepStrictEqual(Object.keys(V.plan({ ...c, height: 300000 }, wards, {}).want), []);
});
test('vec plan: hysteresis keeps a mounted ward, drops far ones, reports relevel', () => {
  const w = wards[3];
  const edge = { x: w.bbox.maxX + V.DEFAULTS.nearDist * 1.2, z: mid(w).z, height: 5000 };
  assert.notStrictEqual(V.plan(edge, [w], {}).want[w.wardCode], 'near');
  assert.strictEqual(V.plan(edge, [w], { [w.wardCode]: 'near' }).want[w.wardCode], 'near');
  const gone = V.plan({ x: w.bbox.maxX + 999999, z: w.bbox.maxZ + 999999, height: 5000 }, [w], { [w.wardCode]: 'near' });
  assert.deepStrictEqual(gone.drop, [w.wardCode]);
  const rl = V.plan({ ...mid(w), height: 20000 }, [w], { [w.wardCode]: 'near' });
  assert.deepStrictEqual(rl.relevel, [w.wardCode]);
});
test('vec tiers/layers per level', () => {
  assert.ok(V.tierAllows('near', 'local') && !V.tierAllows('mid', 'local') && V.tierAllows('far', 'major') && !V.tierAllows('far', 'mid'));
  assert.ok(V.tierAllows('near', undefined), 'missing tier = local');
  assert.deepStrictEqual(V.layersFor('far'), ['roads', 'railways']);
});
test('clipOutBox: removes the part inside the bundle box, splits through-lines, keeps outside lines', () => {
  const box = { minX: 0, maxX: 10, minZ: 0, maxZ: 10 };
  assert.deepStrictEqual(V.clipOutBox([[20, 20], [30, 30]], box), [[[20, 20], [30, 30]]]);
  assert.deepStrictEqual(V.clipOutBox([[5, 5], [6, 6]], box), []);
  const through = V.clipOutBox([[-5, 5], [5, 5], [15, 5]], box);
  assert.strictEqual(through.length, 2);
  assert.deepStrictEqual(V.clipOutBox([[1, 1], [2, 2]], null), [[[1, 1], [2, 2]]]);
});

function manifestOf(size, o) { return Object.assign({ tileSize: size, coordinateSystem: 'meters-local', coordinateConvention: 'znorth-neg-v1', bboxLocal: { minX: -30000, maxX: 30000, minZ: -30000, maxZ: 30000 } }, o || {}); }
function fixture(w, opts) {
  const src = tmp('lc45i-src-');
  const c = mid(w), size = 2000, tx = Math.floor(c.x / size), tz = Math.floor(c.z / size);
  for (const l of ['roads', 'waterways', 'parks', 'railways']) {
    fs.mkdirSync(path.join(src, l));
    fs.writeFileSync(path.join(src, l, 'manifest.json'), JSON.stringify(manifestOf(size, opts)));
    const f = [];
    if (l === 'roads') f.push({ id: 'r1', kind: 'line', tier: 'major', name: '御堂筋', p: [[c.x, c.z], [c.x + 200, c.z]] }, { id: 'r2', kind: 'line', tier: 'local', p: [[c.x, c.z + 50], [c.x + 30, c.z + 50]] }, { id: 'r1b', kind: 'line', tier: 'mid', name: '御堂筋', p: [[c.x, c.z + 9], [c.x + 20, c.z + 9]] });
    if (l === 'railways') f.push({ id: 'k1', kind: 'line', name: '大阪メトロ', p: [[c.x, c.z + 80], [c.x + 100, c.z + 80]] });
    fs.writeFileSync(path.join(src, l, `tile_${tx}_${tz}.json`), JSON.stringify({ features: f }));
  }
  return src;
}
test('builder: generates new files only, names from source, never touches source, skips existing, plan writes nothing', () => {
  const w = wards[0], src = fixture(w), root = path.join(tmp('lc45i-out-'), 'layers');
  const before = fs.readFileSync(path.join(src, 'roads', fs.readdirSync(path.join(src, 'roads')).find((f) => f.startsWith('tile_'))), 'utf8');
  const plan = B.run({ src, layersRoot: root, wards: [w.wardId], plan: true });
  assert.strictEqual(plan.plan, true);
  assert.ok(!fs.existsSync(root), 'plan writes nothing');
  const cov = B.run({ src, layersRoot: root, wards: [w.wardId] });
  assert.strictEqual(cov.stages.generated, 1);
  assert.strictEqual(cov.stages.served, false);
  assert.strictEqual(cov.stages.browserRendered, false);
  const dir = path.join(root, w.wardId, 'layers');
  for (const f of ['roads', 'waterways', 'parks', 'railways', 'labels', 'layers-report']) assert.ok(fs.existsSync(path.join(dir, f + '.json')) || f === 'waterways' || f === 'parks', f);
  const lab = JSON.parse(fs.readFileSync(path.join(dir, 'labels.json'), 'utf8')).items;
  assert.strictEqual(lab.filter((i) => i.kind === 'road' && i.name === '御堂筋').length, 1, 'one item per name, longest/major wins');
  assert.ok(lab.some((i) => i.kind === 'rail' && i.name === '大阪メトロ'));
  assert.ok(lab.every((i) => Number.isFinite(i.x) && Number.isFinite(i.z)));
  const rep = JSON.parse(fs.readFileSync(path.join(dir, 'layers-report.json'), 'utf8'));
  assert.strictEqual(rep.layers.roads.tiers.major, 1);
  assert.match(rep.license, /ODbL/);
  const again = B.run({ src, layersRoot: root, wards: [w.wardId] });
  assert.strictEqual(again.wards[0].stage, 'skipped-exists');
  assert.strictEqual(fs.readFileSync(path.join(src, 'roads', fs.readdirSync(path.join(src, 'roads')).find((f) => f.startsWith('tile_'))), 'utf8'), before);
});
test('builder: wards with no source data are reported honestly, not faked', () => {
  const src = fixture(wards[0]), root = path.join(tmp('lc45i-out-'), 'layers');
  const cov = B.run({ src, layersRoot: root, wards: [wards[5].wardId] });
  assert.strictEqual(cov.wards[0].stage, 'no-source-data');
  assert.strictEqual(cov.stages.generated, 0);
  assert.ok(!fs.existsSync(path.join(root, wards[5].wardId)));
});
test('builder: refuses a root inside the repo, a 45D root, a foreign non-empty dir, and the source', () => {
  const src = fixture(wards[0]);
  assert.throws(() => B.checkRoot(path.join(ROOT, 'public', 'x'), src), /outside the repository/);
  const d45 = tmp('lc45i-45d-'); fs.writeFileSync(path.join(d45, '.livecity-45d-root.json'), '{}');
  assert.throws(() => B.checkRoot(d45, src), /45D root/);
  const foreign = tmp('lc45i-foreign-'); fs.writeFileSync(path.join(foreign, 'x.txt'), 'x');
  assert.throws(() => B.checkRoot(foreign, src), /not empty/);
  assert.throws(() => B.checkRoot(path.join(src, 'sub'), src), /separate from the source/);
  assert.throws(() => B.run({ src, layersRoot: tmp('lc45i-o-'), wards: ['nope'] }), /unknown ward/);
});

test('server: layers served only from a marked root, whitelist, loopback data, no links, no traversal', () => {
  const w = wards[0], src = fixture(w), root = path.join(tmp('lc45i-out-'), 'layers');
  B.run({ src, layersRoot: root, wards: [w.wardId] });
  const lp = S.layersPlan(root);
  assert.deepStrictEqual(lp.wards, [w.wardId]);
  assert.ok(S.resolveLayers(lp, `${w.wardId}/layers/roads.json`));
  assert.ok(S.resolveLayers(lp, `${w.wardId}/layers/labels.json`));
  assert.strictEqual(S.resolveLayers(lp, `${w.wardId}/layers/secret.json`), null);
  assert.strictEqual(S.resolveLayers(lp, `${w.wardId}/layers/../roads.json`), null);
  assert.strictEqual(S.resolveLayers(lp, `nope/layers/roads.json`), null);
  assert.strictEqual(S.resolveLayers(null, `${w.wardId}/layers/roads.json`), null);
  const idx = JSON.parse(S.indexJson([], false, null, lp));
  assert.deepStrictEqual(idx.layersWards, [{ ward: w.wardId }]);
  assert.deepStrictEqual(JSON.parse(S.indexJson([], false, null, null)).layersWards, []);
  assert.throws(() => S.layersPlan(tmp('lc45i-nomarker-')), /no 45I marker/);
  assert.throws(() => S.layersPlan(path.join(ROOT, 'tests')), /outside the repository/);
  try {
    const link = path.join(root, w.wardId, 'layers', 'parks.json');
    fs.symlinkSync(path.join(root, w.wardId, 'layers', 'roads.json'), link);
    assert.strictEqual(S.resolveLayers(lp, `${w.wardId}/layers/parks.json`), null, 'symlink refused');
  } catch (e) { if (e.code !== 'EPERM' && e.code !== 'EEXIST') throw e; }
});

test('viewer wiring: LC45I loaded, independent vec manager, generation token, sumiyoshi bundle exclusion, cache release, no Google', () => {
  assert.match(html, /<script src="mission45i-vec\.js"><\/script>/);
  assert.match(html, /function vecTick/);
  assert.match(html, /vecTick\(c, pos\.h, gen\)/);
  assert.match(html, /LC45I\.plan\(/);
  assert.match(html, /gen !== bldgGen \|\| !allMode \|\| vecAll\.get\(w\.wardCode\) !== rec/);
  assert.match(html, /LC45I\.clipOutBox/);
  assert.match(html, /onlyRR = wardCode === BASE_WARD/);   // 45J: vecContext に移動
  assert.match(html, /ctx\.onlyRR && id !== 'roads' && id !== 'railways'/);
  assert.match(html, /jsonCache\.delete\(f\)/);
  assert.match(html, /layersWards/);
  assert.match(html, /labels\.json'\)\.then/);
  assert.doesNotMatch(fs.readFileSync(path.join(ROOT, 'public/mission45i-vec.js'), 'utf8'), /googleapis|maps\.google/);
  const ps1 = fs.readFileSync(path.join(ROOT, 'tools/mission45e-preview.ps1'), 'utf8');
  assert.match(ps1, /LayersRoot/);
  assert.ok(!/[^\x00-\x7F]/.test(ps1), 'ps1 stays ASCII');
});
