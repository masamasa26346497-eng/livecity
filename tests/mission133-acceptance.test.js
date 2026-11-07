import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { buildAcceptanceTable, buildAcceptanceRow, renderMarkdown } from '../tools/lib/acceptance-table.js';
import { isUnsafeTarMember, assetNameFor, validWardKey, isMainModule } from '../tools/restore-release-assets.js';
import { extractTarGzSafe, parseTar } from '../tools/lib/safe-tar.js';
import { httpGroups, summarizeHttp } from '../tools/verify-ward-layers.js';

const okLayer = { status: 'ok', features: 3 };
const allHttp = { checked: 4, ok200: 4, byLayer: { buildings: { allOk: true }, roads: { allOk: true }, waterways: { allOk: true }, riversV2: { allOk: true }, waterSurface: { allOk: true } } };
const complete = (k) => ({ wardKey: k, ward: k, declared: { buildings: 10 }, http: allHttp, layers: { buildings: { status: 'ok', tilesPresent: 1, tilesDeclared: 1, buildingsLoaded: 10 }, roads: { ...okLayer }, waterways: { status: 'ok', water: { lines: 2, polygons: 1 } } }, checks: { insideWard: { ratio: 0.97 } }, waterKind: 'polygon+line', localData: 'complete' });
const px = { pixelDiff: 120, pass: true };
const fullBrowser = () => ({ buildings: px, roads: px, water: px, waterLine: px, waterPolygon: px, roadLine: px, alignment: { pass: true }, click: { canonicalId: 'b1', expectedId: 'b1' }, fps: 40 });

test('在庫が完備でもブラウザ証拠が無ければ not-verified', () => {
  const r = buildAcceptanceRow(complete('fukushima'), undefined);
  assert.equal(r.verdict, 'not-verified');
  assert.match(r.reasonNotRun, /ブラウザ検証未実行/);
});

test('データ欠落は理由コード付き', () => {
  const r = buildAcceptanceRow({ wardKey: 'nishi', ward: 'nishi', layers: { buildings: { status: 'missing', code: 'missing-file' } } }, undefined);
  assert.match(r.reasonNotRun, /buildings:missing-file/);
  assert.match(r.reasonNotRun, /waterways:absent/);
});

test('全ゲートが揃った時のみ browser-verified。偽陽性ケースは各々落ちる', () => {
  assert.equal(buildAcceptanceRow(complete('a'), fullBrowser()).verdict, 'browser-verified');
  const neg = (name, mutB, mutR) => {
    const r = complete('a'); if (mutR) mutR(r);
    const b = fullBrowser(); if (mutB) mutB(b);
    const row = buildAcceptanceRow(r, b);
    assert.equal(row.verdict, 'not-verified', name);
    return row;
  };
  neg('water pixel 0', (b) => { b.water = { pixelDiff: 0, pass: true }; });
  neg('alignment', (b) => { b.alignment = { pass: false }; });
  neg('roads missing', (b) => { delete b.roads; });
  assert.ok(neg('click id missing', (b) => { delete b.click; }).gateFailures.includes('clickCanonicalId'));
  assert.ok(neg('click id mismatch', (b) => { b.click.canonicalId = 'other'; }).gateFailures.includes('clickCanonicalId'));
  assert.ok(neg('http missing', null, (r) => { delete r.http; }).gateFailures.includes('http200'));
  assert.ok(neg('roads http 404', null, (r) => { r.http = { ...allHttp, byLayer: { ...allHttp.byLayer, roads: { allOk: false } } }; }).gateFailures.includes('http200'));
  assert.ok(neg('legacy http without byLayer', null, (r) => { r.http = { checked: 5, ok200: 5 }; }).gateFailures.includes('http200'));
  assert.ok(neg('coverage low', null, (r) => { r.checks.insideWard.ratio = 0.5; }).gateFailures.includes('wardCoverage'));
  assert.ok(neg('coverage unverified', null, (r) => { r.checks = {}; }).gateFailures.includes('wardCoverage'));
  assert.ok(neg('water polygon evidence missing', (b) => { delete b.waterPolygon; }).gateFailures.includes('pixel:waterPolygon'));
  assert.ok(neg('water line evidence missing', (b) => { delete b.waterLine; }).gateFailures.includes('pixel:waterLine'));
  assert.ok(neg('road line evidence missing', (b) => { delete b.roadLine; }).gateFailures.includes('pixel:roadLine'));
  assert.ok(neg('road surface declared but no evidence', null, (r) => { r.layers.roads.surface = true; }).gateFailures.includes('pixel:roadSurface'));
  assert.ok(neg('no road features', null, (r) => { r.layers.roads = { status: 'missing' }; }).gateFailures.includes('roads:no-features'));
});

test('24区に満たない/未検証があれば allVerified は false', () => {
  const keys = Array.from({ length: 24 }, (_, i) => `w${i}`);
  const results = keys.map(complete);
  const all = Object.fromEntries(keys.map((k) => [k, fullBrowser()]));
  assert.equal(buildAcceptanceTable(results, all).allVerified, true);
  const some = { ...all }; delete some.w5;
  const t = buildAcceptanceTable(results, some);
  assert.equal(t.allVerified, false);
  assert.equal(t.browserVerified, 23);
  assert.match(renderMarkdown(t), /24区完成ではない/);
  assert.equal(buildAcceptanceTable(results.slice(0, 21), {}).allVerified, false);
  // 画素差だけの旧形式（click/http/coverage無し）では誰も完成にならない
  const legacy = Object.fromEntries(keys.map((k) => [k, { buildings: px, roads: px, water: px, alignment: { pass: true } }]));
  assert.equal(buildAcceptanceTable(keys.map((k) => ({ ...complete(k), http: undefined })), legacy).browserVerified, 0);
});

test('verify HTTP: 道路 manifest/tiles と水面を独立に検査し missing を明示', () => {
  const plan = { buildingManifestUrl: 'b', cityTileUrls: { roads: ['r1', 'r2'], waterways: ['w1'] } };
  const g = httpGroups(plan);
  assert.ok(g.roads.some((u) => u.endsWith('/roads/manifest.json')) && g.roads.includes('r1') && g.roads.includes('r2'));
  assert.ok(g.waterSurface.length === 1 && g.riversV2.length === 1);
  const st = {}; for (const u of Object.values(g).flat()) st[u] = 200;
  st.r2 = 404;
  const s = summarizeHttp(g, st);
  assert.equal(s.byLayer.roads.allOk, false);
  assert.equal(s.byLayer.roads.missing, 1);
  assert.equal(s.byLayer.waterways.allOk, true);
  assert.ok(s.notOk.includes('404 r2'));
});

test('restore: 危険な tar メンバー名を拒否し、asset 名/区キーを検証する', () => {
  for (const bad of ['/etc/passwd', '../x', 'a/../../x', 'C:\\x', 'a\\..\\b', '']) assert.equal(isUnsafeTarMember(bad), true, bad);
  for (const good of ['kita/tileset.json', './kita/a.glb']) assert.equal(isUnsafeTarMember(good), false, good);
  assert.equal(assetNameFor('kita'), 'plateau2025-kita.tar.gz');
  assert.equal(validWardKey('kita'), true);
  assert.equal(validWardKey('../kita'), false);
});

test('restore: CLI起動判定は fileURLToPath ベース（URL pathname 非依存・%20含むパス）', () => {
  const p = path.join(os.tmpdir(), 'dir with space', 'restore.js');
  const url = new URL(`file://${p.split(path.sep).map(encodeURIComponent).join('/')}`).href;
  assert.equal(isMainModule(url, p), true);
  assert.equal(isMainModule(url, p + 'x'), false);
  assert.equal(isMainModule(url, undefined), false);
  // 旧実装(new URL().pathname)は %20 が残り一致しない
  assert.notEqual(path.resolve(new URL(url).pathname), path.resolve(p));
  // Windows 形式 file URL（/C:/...）でも例外にならない
  assert.doesNotThrow(() => isMainModule('file:///C:/livecity/tools/restore-release-assets.js', 'C:\\livecity\\tools\\restore-release-assets.js'));
});

// ── 安全な tar 展開 ───────────────────────────────────────────────
function header({ name, size = 0, type = '0', link = '' }) {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100); h.write('0000644\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116);
  h.write(size.toString(8).padStart(11, '0') + '\0', 124); h.write('00000000000\0', 136);
  h.fill(0x20, 148, 156); h.write(type, 156); h.write(link, 157, 100); h.write('ustar\0', 257); h.write('00', 263);
  let sum = 0; for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return h;
}
const pad = (b) => Buffer.concat([b, Buffer.alloc((512 - (b.length % 512)) % 512)]);
function entry(name, data = '', opts = {}) { const d = Buffer.from(data); return Buffer.concat([header({ name, size: d.length, ...opts }), pad(d)]); }
const tgz = (...es) => zlib.gzipSync(Buffer.concat([...es, Buffer.alloc(1024)]));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'm133-'));
const pax = (kv) => { const rec = ` ${kv}\n`; let len = rec.length + 1; while (String(len).length + rec.length !== len) len = String(len).length + rec.length; return `${len}${rec}`; };

test('safe-tar: 正常アーカイブを展開し tileset.json を数える', () => {
  const d = tmp(), dest = path.join(d, '_x_kita');
  const r = extractTarGzSafe(tgz(entry('kita/', '', { type: '5' }), entry('kita/tileset.json', '{}'), entry('kita/a.b3dm', 'xx')), dest);
  assert.deepEqual([r.files, r.tilesets], [2, 1]);
  assert.equal(fs.readFileSync(path.join(dest, 'kita/a.b3dm'), 'utf8'), 'xx');
  assert.equal(fs.existsSync(dest + '.staging'), false);
});

test('safe-tar: symlink / hardlink / 特殊type / ../ / 絶対パス は全体拒否し何も残さない', () => {
  const cases = {
    symlink: [entry('ok.txt', 'a'), entry('evil', '', { type: '2', link: '/etc' })],
    hardlink: [entry('ok.txt', 'a'), entry('evil', '', { type: '1', link: 'ok.txt' })],
    chardev: [entry('dev', '', { type: '3' })],
    gnuLongName: [entry('././@LongLink', '../../x\0', { type: 'L' })],
    paxGlobal: [entry('pax_global_header', pax('path=../x'), { type: 'g' })],
    dotdot: [entry('a/../../escape', 'x')],
    absolute: [entry('/tmp/escape', 'x')],
  };
  for (const [name, es] of Object.entries(cases)) {
    const d = tmp(), dest = path.join(d, '_x_w');
    assert.throws(() => extractTarGzSafe(tgz(...es), dest), undefined, name);
    assert.deepEqual(fs.readdirSync(d), [], `${name}: 部分成果が残っていない`);
  }
});

test('safe-tar: PAX path で .. へ逃がす/未知キー(linkpath)は拒否、安全な PAX path は適用', () => {
  const d = tmp();
  assert.throws(() => extractTarGzSafe(tgz(entry('PaxHeader', pax('path=../../evil'), { type: 'x' }), entry('innocent', 'x')), path.join(d, 'a')), /unsafe member/);
  assert.throws(() => extractTarGzSafe(tgz(entry('PaxHeader', pax('linkpath=/etc'), { type: 'x' }), entry('innocent', 'x')), path.join(d, 'b')), /unsafe pax key/);
  const r = extractTarGzSafe(tgz(entry('PaxHeader', pax('path=deep/long/name.txt'), { type: 'x' }), entry('short', 'x')), path.join(d, 'c'));
  assert.equal(r.files, 1);
  assert.equal(fs.readFileSync(path.join(d, 'c/deep/long/name.txt'), 'utf8'), 'x');
});

test('safe-tar: 重複メンバー・破損checksum・切り詰めは fail-closed、既存 dest は上書きしない', () => {
  const d = tmp();
  assert.throws(() => extractTarGzSafe(tgz(entry('dup', '1'), entry('dup', '2')), path.join(d, 'a')));
  assert.deepEqual(fs.readdirSync(d), []);
  const bad = entry('x', 'y'); bad[0] ^= 0xff;
  assert.throws(() => parseTar(Buffer.concat([bad, Buffer.alloc(1024)])), /checksum/);
  assert.throws(() => parseTar(Buffer.concat([header({ name: 'x', size: 4096 })])), /truncated/);
  fs.mkdirSync(path.join(d, 'exists'));
  assert.throws(() => extractTarGzSafe(tgz(entry('f', 'x')), path.join(d, 'exists')), /already exists/);
});
