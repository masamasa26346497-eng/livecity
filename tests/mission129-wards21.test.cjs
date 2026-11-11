'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const M = require('../tools/mission129/wards21.cjs');

function glb(n) { const b = Buffer.alloc(n); b.write('glTF', 0, 'latin1'); b.writeUInt32LE(2, 4); b.writeUInt32LE(n, 8); return b; }
function mkWard(root, w, o) {
  o = o || {};
  const d = path.join(root, w.wardId + '25');
  fs.mkdirSync(path.join(d, 'tiles'), { recursive: true });
  fs.mkdirSync(path.join(d, 'ids'), { recursive: true });
  fs.writeFileSync(path.join(d, 'tileset.json'), JSON.stringify({ root: {} }));
  fs.writeFileSync(path.join(d, 'tiles', 't.glb'), o.badGlb ? Buffer.from('nope-nope-nope-nope-nope') : glb(32));
  fs.writeFileSync(path.join(d, 'ids', 't.json'), JSON.stringify(o.dup ? ['bldg_a', 'bldg_a'] : ['bldg_a', 'bldg_b']));
}

test('target is exactly 21 unique wards, minus the three observed ones', () => {
  const t = M.target21().map((w) => w.wardId);
  assert.strictEqual(t.length, 21);
  assert.strictEqual(new Set(t).size, 21);
  for (const o of ['nishi', 'fukushima', 'yodogawa']) assert.ok(!t.includes(o));
  assert.strictEqual(M.OBSERVED.length, 3);
});
test('data check: ok / missing / invalid GLB / duplicate ids; never browser accepted', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'm129-'));
  const t = M.target21();
  mkWard(root, t[0]);
  mkWard(root, t[1], { badGlb: true });
  mkWard(root, t[2], { dup: true });
  const s = M.check(root, [t[0].wardId, t[1].wardId, t[2].wardId, t[3].wardId]);
  assert.strictEqual(s.dataOk, 1);
  assert.deepStrictEqual(s.missing, [t[3].wardId]);
  assert.deepStrictEqual(s.problems.sort(), [t[1].wardId, t[2].wardId].sort());
  assert.strictEqual(s.browserAcceptedWards, 0);
  assert.ok(s.rows.every((r) => r.browserAccepted === false));
});
test('ecef/local conversion round-trips the geoToThree origin', () => {
  const a = 6378137, e2 = 0.00669437999014, lat = 34.604208 * Math.PI / 180, lon = 135.52502 * Math.PI / 180;
  const N = a / Math.sqrt(1 - e2 * Math.sin(lat) ** 2);
  const ll = M.ecefToLonLat(N * Math.cos(lat) * Math.cos(lon), N * Math.cos(lat) * Math.sin(lon), N * (1 - e2) * Math.sin(lat));
  const l = M.toLocal(ll.lat, ll.lon);
  assert.ok(Math.abs(l.x) < 1 && Math.abs(l.z) < 1);
});
test('--out refuses to overwrite; tool and template use no write-token, delete or paid API', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'm129-'));
  const out = path.join(root, 'o.json');
  fs.writeFileSync(out, '{}');
  assert.throws(() => M.check(root, [], out), /refusing/);
  const tpl = fs.readFileSync(path.join(__dirname, '../tools/mission129/fetch-21-readonly.workflow.yml.template'), 'utf8');
  assert.ok(/LIVECITY_3D_DATA_READ_TOKEN/.test(tpl));
  assert.ok(!/LIVECITY_3D_DATA_TOKEN/.test(tpl));
  assert.ok(!/upload-artifact|-X (POST|PUT|PATCH|DELETE)|gh release (delete|upload)/.test(tpl));
  const src = fs.readFileSync(path.join(__dirname, '../tools/mission129/wards21.cjs'), 'utf8');
  assert.ok(!/unlink|rmSync|rmdir|https?\.request|fetch\(/.test(src));
});
