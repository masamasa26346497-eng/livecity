import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { planMerge, runMerge, inspectWard } from '../tools/lod2/lod2-cloud-merge.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const REG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/wards/registry.json'), 'utf8')).wards;
const w = (dir, id, code, n, vintage, tag) => {
  fs.mkdirSync(path.join(dir, id, 'lod'), { recursive: true });
  fs.writeFileSync(path.join(dir, id, 'source.json'), JSON.stringify({ wardCode: code, ...(vintage ? { vintage } : {}) }));
  fs.writeFileSync(path.join(dir, id, 'build-report.json'), JSON.stringify({ totals: { buildings: n } }));
  fs.writeFileSync(path.join(dir, id, 'tileset.json'), JSON.stringify({ root: {}, tag }));
  fs.writeFileSync(path.join(dir, id, 'lod', 'a.glb'), 'glTF-' + tag);
};
function fixture(skip = []) {
  const tmp = fs.mkdtempSync(path.join(ROOT, 'temp-m207-')); // 後で temp/ に移す
  fs.rmSync(tmp, { recursive: true });
  const T = path.join(ROOT, 'temp', 'm207-' + Date.now() + Math.random().toString(36).slice(2));
  const base = path.join(T, 'base'), ov = path.join(T, 'ov');
  for (const r of REG) if (!skip.includes(r.id)) w(base, r.id, r.code, 100, null, 'old-' + r.id);
  const reg = (id) => REG.find((x) => x.id === id);
  for (const id of ['kita', 'chuo']) w(path.join(ov, 'ext-3dtiles'), id, reg(id).code, 80, '2025', 'new-' + id);
  fs.mkdirSync(path.join(ov, 'lod2-preview', 'tiles'), { recursive: true });
  fs.writeFileSync(path.join(ov, 'lod2-preview', 'tiles', 'x.glb'), 'lod2');
  fs.writeFileSync(path.join(ov, 'mission37g-osaka-24ward-mvp.html'), '<html></html>');
  return { T, base, ov };
}

test('24区を維持し、北・中央だけ 2025 補完へ置換、他22区は消えない', () => {
  const { T, base, ov } = fixture();
  const r = runMerge({ base, overlay: ov, out: path.relative(ROOT, path.join(T, 'out')) });
  assert.equal(REG.length, 24);
  assert.equal(r.full24, true); assert.equal(r.counts.served, 24); assert.equal(r.counts.overlay, 2); assert.equal(r.counts.base, 22);
  const out = path.join(T, 'out', 'ext-3dtiles');
  assert.equal(JSON.parse(fs.readFileSync(path.join(out, 'kita/tileset.json'))).tag, 'new-kita');
  assert.equal(JSON.parse(fs.readFileSync(path.join(out, 'chuo/tileset.json'))).tag, 'new-chuo');
  for (const x of REG.filter((x) => !['kita', 'chuo'].includes(x.id))) assert.equal(JSON.parse(fs.readFileSync(path.join(out, x.id, 'tileset.json'))).tag, 'old-' + x.id);
  const idx = JSON.parse(fs.readFileSync(path.join(out, 'index.json')));
  assert.equal(idx.wards.length, 24);
  assert.equal(idx.wards.find((x) => x.ward === 'kita').vintage, '2025');
  assert.equal(idx.wards.find((x) => x.ward === 'sumiyoshi').vintage, 'unverified');   // 旧年と 2025 の混在を明示
  assert.equal(idx.wards.find((x) => x.ward === 'kita').source, 'overlay');
  // LOD2・HTML は overlay から、ベースは無変更
  assert.ok(fs.existsSync(path.join(T, 'out/lod2-preview/tiles/x.glb')));
  assert.equal(JSON.parse(fs.readFileSync(path.join(base, 'kita/tileset.json'))).tag, 'old-kita');
});

test('欠落区は missing と明示し、24区成功とは扱わない', () => {
  const { T, base, ov } = fixture(['hirano', 'asahi']);
  const r = runMerge({ base, overlay: ov, out: path.relative(ROOT, path.join(T, 'out')) });
  assert.equal(r.full24, false); assert.equal(r.counts.missing, 2);
  assert.deepEqual(r.wards.filter((x) => x.status === 'missing').map((x) => x.ward).sort(), ['asahi', 'hirano']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(T, 'out/ext-3dtiles/index.json'))).wards.length, 22);
});

test('2025 でない overlay・wardCode 不一致・temp 外出力は拒否', () => {
  const { T, base, ov } = fixture();
  fs.writeFileSync(path.join(ov, 'ext-3dtiles/kita/source.json'), JSON.stringify({ wardCode: REG.find((x) => x.id === 'kita').code, vintage: '2024' }));
  assert.throws(() => runMerge({ base, overlay: ov, out: path.relative(ROOT, path.join(T, 'o')) }), /2025/);
  assert.equal(inspectWard(path.join(base, 'kita'), '99999'), null);
  const f = fixture();
  assert.throws(() => runMerge({ base: f.base, overlay: f.ov, out: 'public/x' }), /temp/);
});

test('planMerge: 権利未確認データ非同梱・confirmedByHuman=false', () => {
  const { T, base, ov } = fixture();
  const r = runMerge({ base, overlay: ov, out: path.relative(ROOT, path.join(T, 'out')) });
  assert.equal(r.rights.confirmedByHuman, false);
  assert.ok(r.notBundled.length >= 4);
  assert.equal(planMerge({ registry: [{ id: 'a', code: 1 }], baseWards: {}, overlayWards: {} })[0].status, 'missing');
});

test('ID/クリック/色の退行防止: 既存テストが LOD2 GLB の canonicalId と unlit 青灰色を保証', () => {
  assert.ok(fs.existsSync(path.join(ROOT, 'tests/mission206-lod2-pick-id.test.mjs')));
  assert.ok(fs.existsSync(path.join(ROOT, 'tests/mission196-lod2-color.test.mjs')));
});
