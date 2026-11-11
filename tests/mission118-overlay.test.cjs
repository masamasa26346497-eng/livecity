'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const S = require('../tools/mission116/combined-server.cjs');
const K = require('../tools/mission116/seam-check.cjs');

const w = (p, c) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, c); };
const MARK = JSON.stringify({ schema: 'livecity.mission45i.layers/1' });
function layersRoot(dir, wards) {
  w(path.join(dir, '.livecity-45i-layers.json'), MARK);
  for (const [ward, cv] of Object.entries(wards)) {
    w(path.join(dir, ward, 'layers', 'layers-report.json'), JSON.stringify(cv >= 2 ? { ward, clipVersion: cv } : { ward }));
    w(path.join(dir, ward, 'layers', 'roads.json'), JSON.stringify({ from: dir.split(path.sep).pop(), ward }));
  }
}
function fixture(primary, supp) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'm118-'));
  const b = path.join(tmp, 'bld'), l1 = path.join(tmp, 'v1'), l2 = path.join(tmp, 'v2');
  for (const ward of ['nishi', 'chuo', 'kita']) w(path.join(b, ward + '25', 'tileset.json'), '{}');
  layersRoot(l1, primary);
  if (supp) layersRoot(l2, supp);
  return { b, l1, l2 };
}
const get = (port, p) => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port, path: p, headers: { Host: '127.0.0.1:' + port } }, (r) => {
    let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => res({ s: r.statusCode, body: d }));
  }).on('error', rej);
});

test('overlay: chuo v1 in primary + chuo v2 in supplemental -> supplemental wins (v2 upgrade), others stay primary', async () => {
  const f = fixture({ nishi: 1, chuo: 1 }, { chuo: 2 });
  const p = S.plan({ buildingsRoot: f.b, layersRoot: f.l1, supplementalLayersRoot: f.l2 });
  assert.strictEqual(p.layerSrc.chuo.role, 'supplemental');
  assert.strictEqual(p.layerSrc.nishi.role, 'primary');
  assert.deepStrictEqual(p.overridden.map((x) => x.ward), ['chuo']);
  const { server, port } = await S.listen(p, 0);
  try {
    assert.strictEqual(JSON.parse((await get(port, '/ext-3dtiles/chuo25/layers/roads.json')).body).from, 'v2');
    assert.strictEqual(JSON.parse((await get(port, '/ext-3dtiles/nishi25/layers/roads.json')).body).from, 'v1');
    const idx = JSON.parse((await get(port, '/ext-3dtiles/index.json')).body);
    assert.deepStrictEqual(idx.layerSources.map((x) => [x.ward, x.source, x.clipVersion]), [['chuo25', 'supplemental', 2], ['nishi25', 'primary', 1]]);
    assert.strictEqual(idx.layersReadyWardCount, 2);
    assert.deepStrictEqual(idx.layersWards.map((x) => x.ward), ['chuo25', 'nishi25']);
    assert.strictEqual(idx.verified, false);
    // kita has a 2025 building but no layers anywhere: buildings only
    assert.strictEqual((await get(port, '/ext-3dtiles/kita25/layers/roads.json')).s, 404);
    assert.strictEqual((await get(port, '/ext-3dtiles/kita25/tileset.json')).s, 200);
  } finally { server.close(); }
});
test('overlay: duplicate ward without a clear v2 upgrade fails closed; explicit prefer resolves it', () => {
  const f = fixture({ chuo: 1 }, { chuo: 1 });
  assert.throws(() => S.plan({ buildingsRoot: f.b, layersRoot: f.l1, supplementalLayersRoot: f.l2 }), (e) => e.code === 5 && /refusing to guess/.test(e.message));
  assert.strictEqual(S.plan({ buildingsRoot: f.b, layersRoot: f.l1, supplementalLayersRoot: f.l2, layersPrefer: 'primary' }).layerSrc.chuo.role, 'primary');
  assert.strictEqual(S.plan({ buildingsRoot: f.b, layersRoot: f.l1, supplementalLayersRoot: f.l2, layersPrefer: 'supplemental' }).layerSrc.chuo.role, 'supplemental');
  const g = fixture({ chuo: 2 }, { chuo: 2 });   // both v2: still ambiguous
  assert.throws(() => S.plan({ buildingsRoot: g.b, layersRoot: g.l1, supplementalLayersRoot: g.l2 }), /refusing/);
  const h = fixture({ chuo: 2 }, { chuo: 1 });   // supplemental older: never auto-wins
  assert.throws(() => S.plan({ buildingsRoot: h.b, layersRoot: h.l1, supplementalLayersRoot: h.l2 }), /refusing/);
  assert.throws(() => S.plan({ buildingsRoot: f.b, layersRoot: f.l1, layersPrefer: 'x' }), /primary or supplemental/);
});
test('overlay: supplemental needs a primary, a marker, separate folders; wards are never mixed across roots', () => {
  const f = fixture({ nishi: 1 }, { chuo: 2 });
  assert.throws(() => S.plan({ buildingsRoot: f.b, supplementalLayersRoot: f.l2 }), /needs --layers-root/);
  assert.throws(() => S.plan({ buildingsRoot: f.b, layersRoot: f.l1, supplementalLayersRoot: f.l1 }), /separate|exists in both/);
  const noMarker = fs.mkdtempSync(path.join(os.tmpdir(), 'm118n-'));
  assert.throws(() => S.plan({ buildingsRoot: f.b, layersRoot: f.l1, supplementalLayersRoot: noMarker }), /marker/);
  assert.throws(() => S.plan({ buildingsRoot: f.b, layersRoot: f.l1, supplementalLayersRoot: path.join(__dirname, '..', 'tools') }), /outside the repository/);
  const p = S.plan({ buildingsRoot: f.b, layersRoot: f.l1, supplementalLayersRoot: f.l2 });
  assert.deepStrictEqual(p.overridden, []);
  assert.deepStrictEqual(p.both, ['chuo', 'nishi']);
});
test('overlay: layers-only wards (no 2025 building) are listed but never served as rendered', async () => {
  const f = fixture({ nishi: 1, tsurumi: 1 }, null);
  const p = S.plan({ buildingsRoot: f.b, layersRoot: f.l1 });
  assert.deepStrictEqual(p.layersOnly, ['tsurumi']);
  const { server, port } = await S.listen(p, 0);
  try {
    assert.strictEqual((await get(port, '/ext-3dtiles/tsurumi25/layers/roads.json')).s, 404);
    const idx = JSON.parse((await get(port, '/ext-3dtiles/index.json')).body);
    assert.deepStrictEqual(idx.layersOnlyWards, ['tsurumi']);
    assert.ok(!idx.layersWards.some((x) => x.ward === 'tsurumi25'));
  } finally { server.close(); }
});
test('url lists exactly the ward25 dirs that exist (no legacy pc23 fallback)', () => {
  const f = fixture({ nishi: 1 }, null);
  const p = S.plan({ buildingsRoot: f.b, layersRoot: f.l1 });
  assert.strictEqual(S.urlFor(p, 8137), 'http://127.0.0.1:8137/mission37g-osaka-24ward-mvp.html?ext=chuo25,kita25,nishi25');
  const src = fs.readFileSync(path.join(__dirname, '..', 'tools/mission116/combined-server.cjs'), 'utf8');
  assert.ok(!/pc23/.test(src.replace(/\/\/.*$/gm, '')));
  assert.ok(!/writeFile|unlink|rmSync|rmdir|rename|copyFile|mkdir|appendFile|symlink|https?\.request|fetch\(/.test(src));
});
test('ps1: supplemental params are forwarded, ASCII, no destructive or link commands', () => {
  const t = fs.readFileSync(path.join(__dirname, '..', 'tools/mission116/combined-run.ps1'), 'utf8');
  assert.ok(![...t].some((c) => c.charCodeAt(0) > 127));
  assert.ok(/SupplementalLayersRoot/.test(t) && /--supplemental-layers-root/.test(t) && /--layers-prefer/.test(t));
  assert.ok(!/Remove-Item|Copy-Item|Move-Item|New-Item|robocopy|mklink|SymbolicLink|Junction/i.test(t));
  const strip = t.replace(/^\s*#.*$/gm, '');
  assert.strictEqual((strip.match(/\{/g) || []).length, (strip.match(/\}/g) || []).length);
  assert.strictEqual((strip.match(/\(/g) || []).length, (strip.match(/\)/g) || []).length);
  for (const line of strip.split('\n')) assert.strictEqual((line.match(/'/g) || []).length % 2, 0, line);
});
test('seam: v1 neighbour vertex kept inside a v2 ward counts as overlap; a line end with no neighbour within 3 m counts as gap', () => {
  const sq = (x0, x1) => [{ outer: [[x0, 0], [x1, 0], [x1, 100], [x0, 100]], holes: [] }];
  const A = sq(0, 100), B = sq(100, 200);
  // A (v2): road ends exactly at x=100. B (v1): same road continues, and keeps one vertex at x=98 inside A.
  const linesA = [{ p: [[10, 50], [100, 50]] }, { p: [[10, 80], [100, 80]] }];
  const linesB = [{ p: [[98, 50], [100.5, 50], [150, 50]] }];
  const r = K.seam(linesA, linesB, A, B, 3);
  assert.strictEqual(r.verticesOfBInsideA, 1);
  assert.strictEqual(r.boundaryEndsOfA, 2);
  assert.strictEqual(r.boundaryEndsOfAWithoutNeighbourWithinTol, 1);   // the road at z=80 has no continuation in B
  const r1 = K.seam(linesA, [{ p: [[102, 50], [150, 50]] }], A, B, 1);
  assert.strictEqual(r1.boundaryEndsOfAWithoutNeighbourWithinTol, 2);  // 2 m off is a gap at tol 1, fine at tol 3
  assert.strictEqual(K.seam(linesA, [{ p: [[102, 50], [150, 50]] }, { p: [[101, 80], [150, 80]] }], A, B, 3).boundaryEndsOfAWithoutNeighbourWithinTol, 0);
});
