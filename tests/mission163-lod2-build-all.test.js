// Mission 163: 全LOD2一括ビルダー(合成fixture。実データの結果は data/reports/mission163 を参照)。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const poly = (id, pts) => `<gml:Polygon gml:id="${id}"><gml:exterior><gml:LinearRing><gml:posList>${pts.map((p) => p.join(' ')).join(' ')}</gml:posList></gml:LinearRing></gml:exterior></gml:Polygon>`;
const surf = (kind, id, pts) => `<bldg:boundedBy><bldg:${kind}Surface><bldg:lod2MultiSurface><gml:MultiSurface><gml:surfaceMember>${poly(id, pts)}</gml:surfaceMember></gml:MultiSurface></bldg:lod2MultiSurface></bldg:${kind}Surface></bldg:boundedBy>`;
const sq = (lat, lon, h, d = 0.0001) => [[lat, lon, h], [lat + d, lon, h], [lat + d, lon + d, h], [lat, lon + d, h], [lat, lon, h]];
const lod1 = '<bldg:lod1Solid><gml:Solid/></bldg:lod1Solid>';
const lod2b = (id, lat, lon) => `<bldg:Building gml:id="${id}">${lod1}${surf('Ground', id + 'g', sq(lat, lon, 5))}${surf('Wall', id + 'w', [[lat, lon, 5], [lat + 0.0001, lon, 5], [lat + 0.0001, lon, 13], [lat, lon, 13], [lat, lon, 5]])}${surf('Roof', id + 'r', sq(lat, lon, 13))}</bldg:Building>`;
const lod1only = (id) => `<bldg:Building gml:id="${id}">${lod1}</bldg:Building>`;
const wrap = (b) => `<?xml version="1.0"?><core:CityModel>${b.map((x) => `<core:cityObjectMember>${x}</core:cityObjectMember>`).join('')}</core:CityModel>`;

function run(xml, extra = []) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lc163-'));
  fs.mkdirSync(path.join(d, 'gml'));
  fs.writeFileSync(path.join(d, 'gml', '99999999_bldg_6697_op.gml'), xml);
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tools/lod2/lod2-build-all.mjs'), '--gml-dir', path.join(d, 'gml'), '--meshes', '99999999', '--out', path.join(d, 'out'), '--report-dir', path.join(d, 'rep'), ...extra], { cwd: os.tmpdir(), encoding: 'utf8' });
  return { d, r, rep: fs.existsSync(path.join(d, 'out/report.json')) ? JSON.parse(fs.readFileSync(path.join(d, 'out/report.json'), 'utf8')) : null };
}

test('全LOD2をタイル分割変換し、期待IDと出力IDがsetで完全一致(LOD1のみの建物はLOD2に数えない)', () => {
  const xml = wrap([lod2b('b1', 34.65, 135.4), lod2b('b2', 34.651, 135.4), lod2b('b3', 34.652, 135.4), lod1only('l1'), lod1only('l2')]);
  const { d, r, rep } = run(xml, ['--max-bldg', '2']);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(rep.expected, 3); assert.equal(rep.converted, 3); assert.equal(rep.unconverted, 0);
  assert.equal(rep.missing, 0); assert.equal(rep.extra, 0); assert.equal(rep.dupAcrossMeshes, 0); assert.equal(rep.fullMatch, true);
  assert.equal(rep.lod1Fallback, 2, 'LOD1のみの2棟はLOD1のまま');
  assert.ok(rep.tiles >= 2, '--max-bldg 2 で分割される');
  const ts = JSON.parse(fs.readFileSync(path.join(d, 'out/tileset.json'), 'utf8'));
  const leaves = ts.root.children.flatMap((m) => { assert.ok(!m.content && m.geometricError > 0, 'mesh node has no content (far view loads nothing)'); return m.children; });
  assert.equal(leaves.length, rep.tiles);
  for (const c of leaves) { assert.equal(c.transform.length, 16); assert.ok(fs.existsSync(path.join(d, 'out', c.content.uri))); assert.equal(fs.readFileSync(path.join(d, 'out', c.content.uri)).subarray(0, 4).toString(), 'glTF'); }
  assert.equal(rep.transformTranslationMatchesOrigin, true);
  const man = JSON.parse(fs.readFileSync(path.join(d, 'out/manifest.json'), 'utf8'));
  assert.equal(man.assets.flatMap((x) => x.ids).length, 3);
  assert.ok(man.assets.every((x) => /^[0-9a-f]{64}$/.test(x.glb.sha256)));
});

test('変換不能な建物は隠さず failed に記録し、fullMatch=false・終了コード2(LOD1のまま)', () => {
  const bad = `<bldg:Building gml:id="bad">${lod1}${surf('Roof', 'badr', [[34.65, 135.4, 10], [34.65, 135.4, 10], [34.65, 135.4, 10]])}</bldg:Building>`;
  const { r, rep } = run(wrap([lod2b('ok1', 34.65, 135.4), bad]));
  assert.equal(r.status, 2);
  assert.equal(rep.fullMatch, false);
  // 不正建物は selector が弾く(notPlanned→missing)か変換で failed になる。いずれにせよ未変換として数えられ隠れない。
  assert.equal(rep.missing, 1);
  assert.ok(rep.failed.includes('bad') || rep.notPlannedByIndex === 1);
  assert.equal(rep.converted, 1); assert.equal(rep.unconverted, 1);
});

test('public/ への出力は拒否', () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tools/lod2/lod2-build-all.mjs'), '--out', 'public/x', '--meshes', '99999999'], { cwd: ROOT, encoding: 'utf8' });
  assert.notEqual(r.status, 0);
});
