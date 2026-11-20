'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const A = require('../tools/mission155-coverage-audit.cjs');
require('../public/mission155-diag.js');   // package.json は type:module のため module.exports は空。ブラウザ用 IIFE は globalThis.LC155 に登録される
const D = globalThis.LC155;
const ROOT = path.resolve(__dirname, '..');

function fixture() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lc155-'));
  const mk = (p, o) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, typeof o === 'string' ? o : JSON.stringify(o)); };
  const src = path.join(d, 'src', 'osaka-kita');
  mk(path.join(src, 'tile_-8_-20.json'), { buildings: [{ id: 'a' }, { id: 'b' }] });
  mk(path.join(src, 'tile_-8_-19.json'), { buildings: [{ id: 'c' }, { id: 'd' }, { id: 'e' }] });
  mk(path.join(src, 'tile_-7_-19.json'), { buildings: [{ id: 'f' }] });
  const out = path.join(d, 'out', 'kita');
  mk(path.join(out, 'ids', 't_-8_-20.json'), ['a', 'b']);
  mk(path.join(out, 'ids', 't_-8_-19.json'), ['c', 'd']);
  mk(path.join(out, 'tiles', 't_-8_-20.glb'), 'x');
  mk(path.join(out, 'tiles', 't_-8_-19.glb'), 'x');
  mk(path.join(out, 'tileset.json'), '{"a":"tiles/t_-8_-20.glb","b":"tiles/t_-8_-19.glb"}');
  return { d, src: path.join(d, 'src'), out: path.join(d, 'out') };
}

test('audit separates source / converted / dropped ids and never invents numbers', () => {
  const f = fixture();
  const r = A.run({ root: ROOT, src: f.src, converted: f.out });
  const k = r.wards.find((w) => w.wardId === 'kita');
  assert.strictEqual(k.source.buildings, 6);
  assert.strictEqual(k.convertedLocal.buildings, 4);
  assert.strictEqual(k.causes.C3_droppedIds, 2);
  assert.ok(k.tileIssues.every((t) => t.cause));
  assert.ok(k.repairPlan && /--tiles -7_-19,-8_-19/.test(k.repairPlan.command));
  assert.strictEqual(k.status, 'converted-partial');
  const m = r.wards.find((w) => w.wardId === 'miyakojima');
  assert.strictEqual(m.source.accessible, false);
  assert.strictEqual(m.source.buildings, null);
  assert.strictEqual(m.status, 'not-delivered');
});

test('GLB missing is flagged as C4', () => {
  const f = fixture();
  fs.unlinkSync(path.join(f.out, 'kita', 'tiles', 't_-8_-20.glb'));
  const r = A.run({ root: ROOT, src: f.src, converted: f.out });
  const k = r.wards.find((w) => w.wardId === 'kita');
  assert.strictEqual(k.causes.C4_glbOrTilesetMissing, 1);
});

test('real repo: sumiyoshi is partial (tracked 9 tiles of 52); no ward claims full', () => {
  const r = A.run({ root: ROOT });
  const s = r.wards.find((w) => w.wardId === 'sumiyoshi');
  assert.strictEqual(s.source.buildings, 35031);
  assert.strictEqual(s.publishedGit.buildings, 10546);
  assert.strictEqual(s.status, 'published-partial');
  assert.strictEqual(r.wards.length, 24);
  assert.strictEqual(r.wards.filter((w) => w.status.endsWith('full')).length, 0);
  assert.strictEqual(r.uploaded, false);
});

test('output carries no building ids; the tool has no write/delete/network calls beyond --out', () => {
  const src = fs.readFileSync(path.join(ROOT, 'tools/mission155-coverage-audit.cjs'), 'utf8');
  assert.ok(!/unlink|rmSync|rmdir|copyFile|renameSync|require\('(http|https|net)'\)|fetch\(/.test(src));
  assert.ok(!/bldg_[0-9a-f]{8}/.test(JSON.stringify(A.run({ root: ROOT }))));
});

test('ward polygon test does not treat outside cells as ward (no fabricated gap)', () => {
  const sq = [{ outer: [[0, 0], [1000, 0], [1000, 1000], [0, 1000]], holes: [] }];
  assert.ok(A.cellTouchesWard(0, 0, sq));
  assert.ok(!A.cellTouchesWard(5, 5, sq));
});

test('diag tracks resident / ever-loaded / failed leaf tiles with HTTP class', () => {
  D.reset();
  const mkEv = () => { const l = []; return { addEventListener: (f) => l.push(f), fire: (a) => l.forEach((f) => f(a)) }; };
  const ts = { tileLoad: mkEv(), tileUnload: mkEv(), tileFailed: mkEv() };
  D.track(ts, { id: 'ext-x', base: 'b/', wardId: 'x', wardCode: '1', report: { selectedTiles: 3, totals: { buildings: 30 }, leaf: [{ name: 't_0_0', buildings: 10 }, { name: 't_1_0', buildings: 10 }, { name: 't_2_0', buildings: 10 }] } });
  const tile = (n) => ({ content: { url: 'http://h/tiles/' + n + '.glb' } });
  ts.tileLoad.fire(tile('t_0_0')); ts.tileLoad.fire(tile('t_1_0')); ts.tileUnload.fire(tile('t_1_0'));
  ts.tileFailed.fire({ url: 'http://h/tiles/t_2_0.glb', message: 'Request has failed. Status Code: 404' });
  const s = D.snapshot();
  const row = s.sets[0];
  assert.strictEqual(row.residentTiles, 1);
  assert.strictEqual(row.everLoadedTiles, 2);
  assert.strictEqual(row.residentBuildings, 10);
  assert.strictEqual(row.neverLoadedTiles, 1);
  assert.deepStrictEqual(row.failedKinds, { 'HTTP 404': 1 });
  assert.deepStrictEqual(s.wards.x.leafFailed, ['t_2_0']);
  D.reset();
});

test('rendered json from the panel feeds the audit (rendered != converted)', () => {
  const f = fixture();
  const rj = path.join(f.d, 'r.json');
  fs.writeFileSync(rj, JSON.stringify({ wards: { kita: { leafLoaded: ['t_-8_-20'], leafFailed: ['t_-8_-19'], leafBuildings: 2 } } }));
  const r = A.run({ root: ROOT, src: f.src, converted: f.out, rendered: rj });
  const k = r.wards.find((w) => w.wardId === 'kita');
  assert.strictEqual(k.rendered.buildings, 2);
  assert.strictEqual(k.coverage.renderedPct, 33.33);
  assert.ok(k.tileIssues.some((t) => t.tile === 't_-8_-19' && t.failed));
});

test('viewer wiring: diag script, ?diag=1 only; ps1 is ASCII with no delete/copy', () => {
  const h = fs.readFileSync(path.join(ROOT, 'public/mission37g-osaka-24ward-mvp.html'), 'utf8');
  assert.ok(h.includes('mission155-diag.js') && h.includes("q.get('diag') === '1'") && h.includes('LC155.track('));
  const ps = fs.readFileSync(path.join(ROOT, 'tools/mission155-diagnose-local.ps1'));
  assert.ok(![...ps].some((b) => b > 127));
  assert.ok(!/Remove-Item|Copy-Item|robocopy|Move-Item/.test(ps.toString()));
});
