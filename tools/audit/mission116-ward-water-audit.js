// Mission 116: 24区の建物/河川データ在庫監査（ネットワーク不要・読み取り専用）
// 実行: node tools/audit/mission116-ward-water-audit.js
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const mapRoot = path.join(root, 'public/map-data/osaka-city');
const m = JSON.parse(fs.readFileSync(path.join(mapRoot, 'buildings/manifest.json'), 'utf8'));
const count = (d) => {
  const p = path.join(root, d);
  return fs.existsSync(p) ? fs.readdirSync(p).filter((f) => f.endsWith('.json')).length : 0;
};
const layers = ['waterways', 'rivers-v2', 'water-surface', 'roads', 'parks', 'railways'];
const layerFilesInRepo = Object.fromEntries(layers.map((l) => [l, count('public/map-data/osaka-city/' + l)]));
const wards = m.datasets.map((d) => {
  const dir = `public/map-data/osaka-city/buildings/${d.id}`;
  return {
    id: d.id,
    ward: d.ward,
    manifestBuildings: d.buildings,
    manifestTiles: d.tiles,
    tilesInRepo: count(dir),
    wardManifestInRepo: fs.existsSync(path.join(root, dir, 'manifest.json')),
  };
});
const out = {
  generatedAt: new Date().toISOString(),
  wardCount: wards.length,
  layerFilesInRepo,
  wards,
  note: 'リポジトリ(Actions)側に存在するファイルのみ監査。Windowsローカル出力は読めない。',
};
fs.mkdirSync(path.join(root, 'data/reports/mission116'), { recursive: true });
fs.writeFileSync(path.join(root, 'data/reports/mission116/ward-water-audit.json'), JSON.stringify(out, null, 2));
console.log('layerFilesInRepo', layerFilesInRepo);
console.table(wards.map((r) => ({ ward: r.ward, manifestTiles: r.manifestTiles, tilesInRepo: r.tilesInRepo })));
