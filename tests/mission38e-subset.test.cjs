'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { inWard, repPoint, loadWard } = require('../tools/mission38e-build-subset.cjs');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'public/mission38e-3dtiles/hirano-subset');
const SRC = path.join(ROOT, 'public/__test__/ward-poc/buildings/osaka-hirano');
const read = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

function dirBytes(d) {
  let n = 0;
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    n += e.isDirectory() ? dirBytes(p) : fs.statSync(p).size;
  }
  return n;
}

test('source.json は部分3D・PLATEAU未証明を明記している', () => {
  const s = read(path.join(OUT, 'source.json'));
  assert.strictEqual(s.plateauOriginalMatch, 'unverified');
  assert.match(s.note, /PLATEAU 100%/);
  assert.strictEqual(s.droppedOutsideWard + s.keptInWard, s.sourceBuildings);
});

test('追加容量は 10MB 以下（プレビューHTML含む）', () => {
  const total = dirBytes(path.join(ROOT, 'public/mission38e-3dtiles')) + fs.statSync(path.join(ROOT, 'public/mission38e-3d-preview.html')).size;
  assert.ok(total < 10 * 1024 * 1024, 'bytes=' + total);
});

test('ids sidecar の canonicalId は元データの building.id と一致し、重複・新規採番がない', () => {
  const srcIds = new Set();
  const manifest = read(path.join(SRC, 'manifest.json'));
  for (const t of manifest.tiles) for (const b of read(path.join(SRC, t.file)).buildings) srcIds.add(b.id);
  const all = [];
  for (const f of fs.readdirSync(path.join(OUT, 'ids'))) {
    if (f.startsWith('t_')) all.push(...read(path.join(OUT, 'ids', f)));
  }
  const rep = read(path.join(OUT, 'build-report.json'));
  assert.strictEqual(all.length, rep.totals.buildings);
  assert.strictEqual(new Set(all).size, all.length);
  for (const id of all) {
    assert.match(id, /^bldg_/);
    assert.ok(srcIds.has(id), 'unknown id ' + id);
  }
});

test('残した建物はすべて N03 平野区ポリゴン内（ward ラベルは根拠にしない）', () => {
  const ward = loadWard('hirano');
  const s = read(path.join(OUT, 'source.json'));
  const inTiles = new Set();
  for (const key of s.tiles) {
    const j = read(path.join(SRC, 'tile_' + key + '.json'));
    for (const b of j.buildings) {
      const [x, z] = repPoint(b.fp);
      if (inWard(x, z, ward)) inTiles.add(b.id);
    }
  }
  const kept = [];
  for (const f of fs.readdirSync(path.join(OUT, 'ids'))) if (f.startsWith('t_')) kept.push(...read(path.join(OUT, 'ids', f)));
  assert.ok(kept.length > 0);
  for (const id of kept) assert.ok(inTiles.has(id));
});

test('tileset.json は参照する GLB / sidecar をすべて持つ', () => {
  const ts = read(path.join(OUT, 'tileset.json'));
  const uris = [];
  (function walk(n) {
    if (n.content) uris.push(n.content.uri);
    if (n.extras && n.extras.idsUri) uris.push(n.extras.idsUri);
    (n.children || []).forEach(walk);
  })(ts.root);
  assert.ok(uris.length > 0);
  for (const u of uris) assert.ok(fs.existsSync(path.join(OUT, u)), 'missing ' + u);
});

test('プレビューHTMLは 37G 本体・課金APIを参照しない', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public/mission38e-3d-preview.html'), 'utf8');
  assert.ok(!/mission37g-osaka/.test(html.replace(/<!--[\s\S]*?-->/g, '').replace(/本体（[^）]*）/g, '')));
  assert.ok(!/googleapis|maps\.google|PhotorealisticTiles|createGooglePhotorealistic/i.test(html));
  assert.match(html, /canonicalId/);
});

// 38E 監査: ward ラベル（東住吉区）と N03 判定（平野区）の不一致を固定化する。ラベルは根拠にしない。
test('audit: label vs N03 mismatch is documented per tile', () => {
  const { audit } = require('../tools/mission38e-audit-ward.cjs');
  const r = audit('osaka-hirano', ['5_-3', '5_-4', '6_-3', '6_-4']);
  for (const k of Object.keys(r)) {
    assert.deepStrictEqual(Object.keys(r[k].labels), ['東住吉区']);
    assert.deepStrictEqual(Object.keys(r[k].n03), ['hirano']);
    assert.strictEqual(r[k].none, 0);
  }
});
