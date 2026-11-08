#!/usr/bin/env node
// Mission 135: 既存ローカルの Mission115 都市レイヤー出力 → 24区の区別レイヤー（Cesium ビューア入力）へ変換する。
//   node tools/mission135/build-ward-layers.js --map-root <dir with roads/ waterways/ water-surface/> --out <dir> [--wards a,b] [--buffer 150]
// ネットワークなし・読み取り専用（--out にだけ書く）。入力が無い区は「未取得」と表示するだけで何も捏造しない。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildWardLayers, loadWards } from '../lib/ward-layer-adapter.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DEFAULT_POLYGONS = path.join(ROOT, 'public', 'map-data', 'osaka-city', 'boundaries', 'ward-classification-polygons.json');

export function run(argv) {
  const opt = (k) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : undefined; };
  const mapRoot = opt('map-root'), out = opt('out');
  if (!mapRoot || !out) { console.error('usage: --map-root <dir> --out <dir> [--wards a,b] [--buffer 150] [--polygons file] [--road-surface]'); return 2; }
  const only = opt('wards') ? opt('wards').split(',') : null;
  const wards = loadWards(opt('polygons') || DEFAULT_POLYGONS).filter((w) => !only || only.includes(w.wardId));
  let generated = 0;
  for (const w of wards) {
    const r = buildWardLayers({ mapRoot: path.resolve(mapRoot), outRoot: path.resolve(out), ward: w, bufferM: Number(opt('buffer') || 150), roadSurface: argv.includes('--road-surface') });
    const s = (k) => `${k}=${r.layers[k].state}${r.layers[k].count ? `(${r.layers[k].count})` : ''}`;
    if (['roads', 'waterways', 'waterSurface'].some((k) => r.layers[k].state === 'generated')) generated++;
    console.log(`${w.wardId}: ${s('roads')} ${s('waterways')} ${s('waterSurface')} ${s('riversV2')}`);
  }
  console.log(`wards with any generated layer: ${generated}/${wards.length}`);
  return 0;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(run(process.argv.slice(2)));
