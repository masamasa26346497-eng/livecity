// Mission 202: 合成(synthetic)静的 fixture 生成。実 PLATEAU 2025 ではない。manifest に synthetic:true を明記する。
//   node tools/cloud/make-fixture.mjs --out temp/cloud-fixture --wards kita,chuo [--shard 1/2]
// 目的: 区の分離・index served/not-served・整合性・HTTP/Chrome 配信テストの入力。「2025 実源達成」の根拠にはならない。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildIndex, shardWards } from './ward-plan.mjs';
import { writeWardManifest } from './ward-manifest.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function tinyGlb(seed) {
  const json = Buffer.from(JSON.stringify({ asset: { version: '2.0' }, extras: { seed } }));
  const j = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)]);
  const h = Buffer.alloc(12); h.write('glTF', 0); h.writeUInt32LE(2, 4); h.writeUInt32LE(12 + 8 + j.length, 8);
  const c = Buffer.alloc(8); c.writeUInt32LE(j.length, 0); c.write('JSON', 4);
  return Buffer.concat([h, c, j]);
}

export async function makeFixture({ out, wards, shard = null }) {
  const reg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/wards/registry.json'), 'utf8')).wards;
  const list = shardWards(wards, shard);
  const ext = path.join(out, 'ext-3dtiles');
  fs.rmSync(ext, { recursive: true, force: true });
  fs.mkdirSync(ext, { recursive: true });
  const served = [];
  for (const id of list) {
    const w = reg.find((x) => x.id === id);
    if (!w) throw new Error('unknown ward ' + id);
    const d = path.join(ext, id);
    fs.mkdirSync(path.join(d, 'tiles'), { recursive: true });
    fs.mkdirSync(path.join(d, 'ids'), { recursive: true });
    fs.writeFileSync(path.join(d, 'tiles/0.glb'), tinyGlb('fixture:' + id));
    // gml:id は区コード接頭辞つき(区ごとに異なる)。
    fs.writeFileSync(path.join(d, 'ids/0.json'), JSON.stringify(['bldg_' + w.code + '_0001', 'bldg_' + w.code + '_0002']));
    fs.writeFileSync(path.join(d, 'tileset.json'), JSON.stringify({ asset: { version: '1.1' }, geometricError: 100, root: { boundingVolume: { region: [2.36, 0.60, 2.37, 0.61, 0, 50] }, geometricError: 50, refine: 'ADD', content: { uri: 'tiles/0.glb' } } }));
    await writeWardManifest(d, { ward: id, name: w.name, code: w.code, synthetic: true, source: { vintage: 2025, attribution: '(synthetic fixture) 国土交通省 Project PLATEAU を加工して作成した体裁のダミー', license: 'fixture', sourceEtag: 'synthetic' } });
    served.push({ id, buildings: 2 });
  }
  fs.writeFileSync(path.join(ext, 'index.json'), JSON.stringify({ ...buildIndex(reg, served), synthetic: true, lod0Wards: [], layersWards: [] }));
  return { served: list, ext };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const a = process.argv.slice(2);
  const opt = (k, d = null) => { const i = a.indexOf('--' + k); return i >= 0 ? a[i + 1] : d; };
  const out = path.resolve(ROOT, opt('out', 'temp/cloud-fixture'));
  if (!/[\\/]temp[\\/]/.test(out + path.sep)) { console.error('--out は temp/ 配下のみ'); process.exit(1); }
  makeFixture({ out, wards: (opt('wards', 'kita,chuo')).split(',').filter(Boolean), shard: opt('shard') })
    .then((r) => console.log(JSON.stringify(r))).catch((e) => { console.error('FAILED', e.message); process.exit(1); });
}
