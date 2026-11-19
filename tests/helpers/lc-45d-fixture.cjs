'use strict';
// Mission 171: 45D 出力ルート / 45I MapLayers の「忠実な合成 fixture」(実データではない)。
// 形は tools/mission43f-pc-convert.cjs・mission40b-legacy-tiles-batch.cjs・mission45i-build-layers-24.cjs のコードに合わせている:
//   <root>/.livecity-45d-root.json, <root>/pc23/<ward>-aN/{tileset.json,source.json,build-report.json{totals.buildings,selectedTiles},tiles/*.glb,ids/,attrs/,verify-report.json}
//   <root>/sumiyoshi-aN/sumiyoshi/..., <root>/state.json
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const REG = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'config/wards/registry.json'), 'utf8')).wards;

// 最小の有効な GLB(JSON チャンクのみ。Cesium の本物の描画検証には使わない=HTTP/配信経路の検証用)
function glbBytes() {
  const json = Buffer.from(JSON.stringify({ asset: { version: '2.0' } }));
  const pad = (4 - (json.length % 4)) % 4;
  const body = Buffer.concat([json, Buffer.alloc(pad, 0x20)]);
  const h = Buffer.alloc(12); h.write('glTF', 0); h.writeUInt32LE(2, 4); h.writeUInt32LE(12 + 8 + body.length, 8);
  const c = Buffer.alloc(8); c.writeUInt32LE(body.length, 0); c.writeUInt32LE(0x4E4F534A, 4);
  return Buffer.concat([h, c, body]);
}
function writeWardOut(d, w, o = {}) {
  const n = o.tiles == null ? 2 : o.tiles;
  fs.mkdirSync(path.join(d, 'tiles'), { recursive: true }); fs.mkdirSync(path.join(d, 'ids'), { recursive: true }); fs.mkdirSync(path.join(d, 'attrs'), { recursive: true });
  const children = [];
  for (let i = 0; i < n; i++) {
    const name = 't_' + i + '_0.glb';
    children.push({ boundingVolume: { region: [2.36, 0.6, 2.37, 0.61, 0, 60] }, geometricError: 0, refine: 'ADD', content: { uri: (o.uriPrefix || 'tiles/') + name } });
    if (!(o.missingGlb && i === 0)) fs.writeFileSync(path.join(d, 'tiles', name), glbBytes());
  }
  fs.writeFileSync(path.join(d, 'tileset.json'), JSON.stringify({ asset: { version: '1.1' }, geometricError: 500, root: { boundingVolume: { region: [2.36, 0.6, 2.37, 0.61, 0, 60] }, geometricError: 100, refine: 'ADD', children } }));
  if (!o.noSource) fs.writeFileSync(path.join(d, 'source.json'), JSON.stringify({ mission: '40B', wardId: w.id, wardCode: o.wardCode || w.code, counts: { tiles: n, buildings: o.buildings || 100 } }));
  if (!o.noReport) fs.writeFileSync(path.join(d, 'build-report.json'), JSON.stringify({ selectedTiles: o.zeroTiles ? 0 : n, totals: { buildings: o.buildings || 100, skipped: 0, glbBytes: 100 } }));
  fs.writeFileSync(path.join(d, 'ids', 't_0_0.json'), '[]'); fs.writeFileSync(path.join(d, 'attrs', 't_0_0.json'), '{}');
  fs.writeFileSync(path.join(d, 'secret.txt'), 'x');
}
// opts.wards: 区 id 一覧。opts.special: { <ward>: { ...writeWardOut opts, failedNewerAttempt:true } }
function mk45d(wardIds, special = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lc171-3dt-'));
  fs.writeFileSync(path.join(root, '.livecity-45d-root.json'), JSON.stringify({ schema: 'livecity.mission45d.convert-all/1' }));
  fs.mkdirSync(path.join(root, 'pc23'), { recursive: true });
  for (const id of wardIds) {
    const w = REG.find((x) => x.id === id); const sp = special[id] || {};
    if (id === 'sumiyoshi') {
      const d = path.join(root, 'sumiyoshi-a1', 'sumiyoshi'); writeWardOut(d, w, sp);
      fs.writeFileSync(path.join(root, 'state.json'), JSON.stringify({ sumiyoshi: { state: 'ok', attempt: 1, buildings: 100 } }));
      continue;
    }
    writeWardOut(path.join(root, 'pc23', id + '-a1'), w, sp.attempt1 || sp);
    if (sp.failedNewerAttempt) {   // 後から失敗した attempt が残っている実運用(43F: 失敗しても -aN は残る)
      const d2 = path.join(root, 'pc23', id + '-a2'); writeWardOut(d2, w, { buildings: 999 });
      fs.writeFileSync(path.join(d2, 'verify-report.json'), JSON.stringify({ ok: false, verify: { problems: ['x'] } }));
    }
  }
  return root;
}
function mkLayers(wardIds) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lc171-lay-'));
  fs.writeFileSync(path.join(root, '.livecity-45i-layers.json'), JSON.stringify({ schema: 'livecity.mission45i.layers/1' }));
  for (const w of wardIds) {
    const d = path.join(root, w, 'layers'); fs.mkdirSync(d, { recursive: true });
    for (const f of ['roads', 'waterways', 'parks', 'railways', 'labels']) fs.writeFileSync(path.join(d, f + '.json'), JSON.stringify({ type: 'FeatureCollection', features: [] }));
    fs.writeFileSync(path.join(d, 'layers-report.json'), '{}');
    fs.writeFileSync(path.join(d, 'secret.json'), '{}');
  }
  return root;
}
// LOCALAPPDATA を模した親(Windows の既定位置を再現)
function mkLocalAppData({ wards, special, layerWards }) {
  const la = fs.mkdtempSync(path.join(os.tmpdir(), 'lc171-lad-'));
  fs.renameSync(mk45d(wards, special), path.join(la, 'LiveCity-3DTiles-Out-24'));
  if (layerWards) fs.renameSync(mkLayers(layerWards), path.join(la, 'LiveCity-MapLayers-Out-24'));
  return la;
}
module.exports = { mk45d, mkLayers, mkLocalAppData, glbBytes, writeWardOut, REG };
