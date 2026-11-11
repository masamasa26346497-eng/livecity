'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run } = require('../tools/mission40j-stage-public.cjs');
const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public/mission37g-osaka-24ward-mvp.html'), 'utf8');

function fixture(opts = {}) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'm40j-'));
  const src = path.join(d, 'src', 'fukushima');
  for (const sub of ['attrs', 'ids', 'tiles', 'layers']) fs.mkdirSync(path.join(src, sub), { recursive: true });
  fs.writeFileSync(path.join(src, 'tileset.json'), '{}');
  fs.writeFileSync(path.join(src, 'source.json'), JSON.stringify({ wardCode: '27103', source: 'PLATEAU 3D都市モデル 大阪市 2024', idPolicy: 'x' }));
  fs.writeFileSync(path.join(src, 'build-report.json'), JSON.stringify({ totals: { buildings: opts.reported || 3, skipped: 0 } }));
  fs.writeFileSync(path.join(src, 'ids', 't_0_0.json'), JSON.stringify(['bldg_a', 'bldg_b', 'bldg_c']));
  fs.writeFileSync(path.join(src, 'ids', 'g_0_0.json'), JSON.stringify(['bldg_a', 'bldg_b', 'bldg_c']));   // LOD group: must not be double counted
  fs.writeFileSync(path.join(src, 'attrs', 't_0_0.json'), '{}');
  fs.writeFileSync(path.join(src, 'tiles', 't_0_0.glb'), Buffer.alloc(1024));
  if (!opts.noLayers) for (const f of ['roads.json', 'waterways.json', 'parks.json', 'railways.json', 'layers-report.json']) fs.writeFileSync(path.join(src, 'layers', f), '{}');
  return { d, src, out: path.join(d, 'out') };
}
const base = (f, extra = []) => ['--src', f.src, '--ward', 'fukushima', '--out', f.out, ...extra];

test('dry run writes nothing and reports size/counts', () => {
  const f = fixture();
  const r = run(base(f));
  assert.strictEqual(r.mode, 'dry-run');
  assert.deepStrictEqual(r.problems, []);
  assert.strictEqual(r.summary.buildings, 3);
  assert.ok(/MB$/.test(r.size));
  assert.ok(!fs.existsSync(f.out));
});

test('execute refuses without license check / owner approval / approver', () => {
  const f = fixture();
  const r = run(base(f, ['--execute']));
  assert.ok(r.problems.length >= 3);
  assert.ok(!fs.existsSync(f.out));
  const r2 = run(base(f, ['--execute', '--license-checked']));
  assert.ok(r2.problems.some((p) => /owner-approved-release/.test(p)));
  assert.ok(!fs.existsSync(f.out));
});

test('execute copies files, keeps source intact, registers published.json', () => {
  const f = fixture();
  const before = fs.readFileSync(path.join(f.src, 'source.json'), 'utf8');
  const r = run(base(f, ['--execute', '--license-checked', '--owner-approved-release', '--approved-by', 'tester']));
  assert.deepStrictEqual(r.problems, []);
  assert.ok(fs.existsSync(path.join(f.out, 'fukushima', 'tiles', 't_0_0.glb')));
  assert.strictEqual(fs.readFileSync(path.join(f.src, 'source.json'), 'utf8'), before);
  const pj = JSON.parse(fs.readFileSync(path.join(f.out, 'published.json'), 'utf8'));
  assert.strictEqual(pj.wards[0].ward, 'fukushima');
  assert.strictEqual(pj.wards[0].approved, true);
  // second run must not overwrite
  const r2 = run(base(f, ['--execute', '--license-checked', '--owner-approved-release', '--approved-by', 'tester']));
  assert.ok(r2.problems.some((p) => /not empty/.test(p)));
});

test('detects count mismatch, missing layer file, unexpected file type, oversize', () => {
  const f = fixture({ reported: 5 });
  assert.ok(run(base(f)).problems.some((p) => /ids\/ count/.test(p)));
  const g = fixture();
  fs.unlinkSync(path.join(g.src, 'layers', 'roads.json'));
  fs.writeFileSync(path.join(g.src, 'tiles', 'x.exe'), 'x');
  const pr = run(base(g)).problems.join('|');
  assert.ok(/layers\/roads\.json missing/.test(pr) && /unexpected file type/.test(pr));
  const h = fixture();
  assert.ok(run(base(h, ['--max-mb', '0.0001'])).problems.some((p) => /exceeds/.test(p)));
});

test('shipped published.json is empty and ignored dir is gitignored', () => {
  const pj = JSON.parse(fs.readFileSync(path.join(root, 'public/mission40j-3dtiles/published.json'), 'utf8'));
  assert.deepStrictEqual(pj.wards, []);
  assert.ok(/public\/mission40j-3dtiles\/\*\//.test(fs.readFileSync(path.join(root, '.gitignore'), 'utf8')));
});

test('viewer only registers approved published wards, same-origin, no Google refs', () => {
  assert.ok(/mission40j-3dtiles\/published\.json/.test(html));
  assert.ok(/w\.approved === true/.test(html));
  assert.ok(/\^\[a-z0-9-\]\+\$/.test(html));
  assert.ok(/await loadPublishedDefs\(\)/.test(html));
  assert.ok(/ODbL/.test(html) && /PLATEAU/.test(html));
  assert.ok(!/maps\.googleapis|places\.googleapis/.test(html));
});

test('stage script has no git/network/delete calls', () => {
  const s = fs.readFileSync(path.join(root, 'tools/mission40j-stage-public.cjs'), 'utf8');
  assert.ok(!/child_process|https?\.request|fetch\(|unlinkSync|rmSync|rmdirSync/.test(s));
});

test('attribution links and unresolved license items are documented', () => {
  assert.ok(html.includes('https://www.mlit.go.jp/plateau/faq/'));
  assert.ok(html.includes('https://www.openstreetmap.org/copyright'));
  const doc = fs.readFileSync(path.join(root, 'MISSION40J_FUKUSHIMA_PUBLISH_PREP.md'), 'utf8');
  for (const u of ['mlit.go.jp/plateau/faq', 'Attribution_Guidelines', 'Produced_Work_-_Guideline']) assert.ok(doc.includes(u), u);
  assert.ok(doc.includes('未確認事項') && doc.includes('share-alike'));
});
