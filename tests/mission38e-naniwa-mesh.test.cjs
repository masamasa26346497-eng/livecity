'use strict';
// Mission 38E: 浪速区 PLATEAU メッシュ 51357399 の生成物検証（外部通信なし。コミット済み成果物を読むだけ）。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'public/mission38e-3dtiles/naniwa-mesh');
const proj = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/areas/osaka-city.json'), 'utf8')).projection;
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

function attrs() {
  const m = new Map();
  for (const f of fs.readdirSync(path.join(OUT, 'attrs'))) {
    const t = readJson(path.join(OUT, 'attrs', f));
    for (const [id, a] of Object.entries(t.byId)) m.set(id, { h: a[0], x: a[2], z: a[3], file: f });
  }
  return m;
}
function walk(dir) {
  return fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile())
    .map((e) => path.join(e.parentPath || e.path, e.name));
}

test('出典・取得方法・SHA256 が source.json に記録され、PLATEAU 公式 URL を指す', () => {
  const s = readJson(path.join(OUT, 'source.json'));
  assert.equal(s.wardId, 'naniwa');
  assert.match(s.sourceZipUrl, /^https:\/\/assets\.cms\.plateau\.reearth\.io\//);
  assert.deepEqual(s.sourceMeshes, ['51357399']);
  assert.match(s.gmlSha256, /^[0-9a-f]{64}$/);
  assert.match(s.fetchMethod, /Range/);
  assert.equal(s.counts.read, 2522);
  assert.equal(s.counts.inWard + s.counts.outsideWard + s.counts.duplicate, s.counts.read);
  assert.equal(s.counts.duplicate, 0);
});

test('canonicalId は bldg_<uuid> で重複 0、件数が source.json と一致', () => {
  const a = attrs();
  const s = readJson(path.join(OUT, 'source.json'));
  assert.equal(a.size, s.counts.inWard);
  for (const id of a.keys()) assert.match(id, /^bldg_[0-9a-f-]{36}$/);
});

test('全棟を逆投影した緯度経度が浪速区の地理的目安範囲（N03 bbox±0.002°）内', () => {
  const south = 34.64801 - 0.002, north = 34.67002 + 0.002, west = 135.48054 - 0.002, east = 135.51074 + 0.002;
  for (const [id, b] of attrs()) {
    const lat = proj.centerLat - b.z / proj.metersPerDegree;
    const lon = b.x / (Math.cos(proj.centerLat * Math.PI / 180) * proj.metersPerDegree) + proj.centerLon;
    assert.ok(lat > south && lat < north && lon > west && lon < east, `${id} ${lat},${lon}`);
    assert.ok(b.h > 0 && b.h < 300, `${id} h=${b.h}`);
  }
});

test('既存データ（平野subset・テスト用住吉/東住吉/平野・37H 4区）とIDが重複しない', () => {
  const mine = new Set(attrs().keys());
  let overlap = 0;
  const others = [];
  const B = path.join(ROOT, 'public/__test__/ward-poc/buildings');
  for (const d of fs.readdirSync(B, { withFileTypes: true }).filter((e) => e.isDirectory())) {
    for (const f of walk(path.join(B, d.name))) {
      if (f.endsWith('.json')) others.push(f);
    }
  }
  const h = path.join(ROOT, 'public/mission37h-3dtiles');
  for (const f of walk(h)) if (f.includes(path.sep + 'attrs' + path.sep)) others.push(f);
  assert.ok(others.length > 100, 'comparison corpus too small');
  for (const f of others) {
    const j = readJson(f);
    const ids = j.buildings ? j.buildings.map((b) => b.id) : Object.keys(j.byId || {});
    for (const id of ids) if (mine.has(id)) overlap++;
  }
  assert.equal(overlap, 0);
});

test('tileset の参照ファイルがすべて存在し、追加容量が10MB以下', () => {
  const ts = readJson(path.join(OUT, 'tileset.json'));
  const uris = [];
  (function rec(t) { if (t.content && t.content.uri) uris.push(t.content.uri); (t.children || []).forEach(rec); })(ts.root);
  assert.ok(uris.length >= 7);
  for (const u of uris) assert.ok(fs.existsSync(path.join(OUT, u)), u);
  const total = walk(OUT).reduce((n, f) => n + fs.statSync(f).size, 0);
  assert.ok(total <= 10 * 1024 * 1024, `total=${total}`);
});
