'use strict';
// Mission 38E: 浪速区 PLATEAU メッシュ 51357389（naniwa-mesh2）の生成物検証。外部通信なし。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const A = path.join(ROOT, 'public/mission38e-3dtiles/naniwa-mesh');
const B = path.join(ROOT, 'public/mission38e-3dtiles/naniwa-mesh2');
const proj = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/areas/osaka-city.json'), 'utf8')).projection;
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
function attrs(dir) {
  const m = new Map();
  for (const f of fs.readdirSync(path.join(dir, 'attrs'))) {
    const t = readJson(path.join(dir, 'attrs', f));
    for (const [id, a] of Object.entries(t.byId)) m.set(id, { h: a[0], x: a[2], z: a[3] });
  }
  return m;
}
function walk(dir) {
  return fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile())
    .map((e) => path.join(e.parentPath || e.path, e.name));
}

test('出典・SHA256・Range取得・件数が source.json に記録されている', () => {
  const s = readJson(path.join(B, 'source.json'));
  assert.equal(s.wardId, 'naniwa');
  assert.match(s.sourceZipUrl, /^https:\/\/assets\.cms\.plateau\.reearth\.io\//);
  assert.deepEqual(s.sourceMeshes, ['51357389']);
  assert.match(s.gmlSha256, /^[0-9a-f]{64}$/);
  assert.match(s.fetchMethod, /Range/);
  assert.equal(s.counts.read, 2388);
  assert.equal(s.counts.inWard + s.counts.outsideWard + s.counts.duplicate + s.counts.existingDuplicate, s.counts.read);
});

test('canonicalId は bldg_<uuid>、一意、source.json の件数と一致', () => {
  const a = attrs(B);
  assert.equal(a.size, readJson(path.join(B, 'source.json')).counts.inWard);
  for (const id of a.keys()) assert.match(id, /^bldg_[0-9a-f-]{36}$/);
});

test('既存 naniwa-mesh（2,466棟）と ID 重複 0', () => {
  const a = attrs(A), b = attrs(B);
  let overlap = 0;
  for (const id of b.keys()) if (a.has(id)) overlap++;
  assert.equal(overlap, 0);
  assert.equal(a.size, 2466);
});

test('全棟の逆投影が浪速区 bbox±0.002° 内、高さが妥当', () => {
  const south = 34.64801 - 0.002, north = 34.67002 + 0.002, west = 135.48054 - 0.002, east = 135.51074 + 0.002;
  for (const [id, b] of attrs(B)) {
    const lat = proj.centerLat - b.z / proj.metersPerDegree;
    const lon = b.x / (Math.cos(proj.centerLat * Math.PI / 180) * proj.metersPerDegree) + proj.centerLon;
    assert.ok(lat > south && lat < north && lon > west && lon < east, `${id} ${lat},${lon}`);
    assert.ok(b.h > 0 && b.h < 300, `${id} h=${b.h}`);
  }
});

test('他の既存セット（平野subset・テスト用・37H）と ID 重複 0', () => {
  const mine = new Set(attrs(B).keys());
  const files = [];
  const T = path.join(ROOT, 'public/__test__/ward-poc/buildings');
  for (const d of fs.readdirSync(T, { withFileTypes: true }).filter((e) => e.isDirectory()))
    for (const f of walk(path.join(T, d.name))) if (f.endsWith('.json')) files.push(f);
  for (const f of walk(path.join(ROOT, 'public/mission37h-3dtiles'))) if (f.includes(path.sep + 'attrs' + path.sep)) files.push(f);
  for (const f of walk(path.join(ROOT, 'public/mission38e-3dtiles/hirano-subset/ids'))) files.push(f);
  let overlap = 0;
  for (const f of files) {
    const j = readJson(f);
    const ids = Array.isArray(j) ? j : j.buildings ? j.buildings.map((x) => x.id) : Object.keys(j.byId || {});
    for (const id of ids) if (mine.has(id)) overlap++;
  }
  assert.ok(files.length > 100);
  assert.equal(overlap, 0);
});

test('tileset の参照ファイルが存在し、追加容量が10MB以下', () => {
  const ts = readJson(path.join(B, 'tileset.json'));
  const uris = [];
  (function rec(t) { if (t.content && t.content.uri) uris.push(t.content.uri); (t.children || []).forEach(rec); })(ts.root);
  assert.ok(uris.length >= 2);
  for (const u of uris) assert.ok(fs.existsSync(path.join(B, u)), u);
  assert.ok(walk(B).reduce((n, f) => n + fs.statSync(f).size, 0) <= 10 * 1024 * 1024);
});
