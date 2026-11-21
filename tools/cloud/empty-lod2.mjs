// Mission 213: 対象区のメッシュに LOD2 収録が1つも無い「正常状態」用の空 LOD2 出力。
//   「LOD2 収録メッシュ 0」は data/reports/mission159/lod2-coverage-osaka2025.json(公式 2025 の LOD2 収録調査)に
//   該当メッシュが無いことを確認できた場合のみ許可する(呼び出し側で検証)。取得失敗・変換失敗を隠すためには使わない。
import fs from 'node:fs';
import path from 'node:path';

export function writeEmptyLod2(dir, { meshesChecked = [], reason = 'no-lod2-meshes-in-coverage' } = {}) {
  fs.mkdirSync(path.join(dir, 'tiles'), { recursive: true });
  const emptyTileset = { asset: { version: '1.1', tilesetVersion: 'mission213-empty-lod2' }, geometricError: 0, root: { boundingVolume: { box: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1] }, geometricError: 0, refine: 'ADD' } };
  const report = { mission: '213-empty-lod2', noLod2: true, reason, meshesChecked, converted: 0, expected: 0, fullMatch: true, tiles: 0, glbBytes: 0, meshes: [], color: 'n/a', vertical: 'n/a (no LOD2)', bbox: null, source: 'none' };
  fs.writeFileSync(path.join(dir, 'tileset.json'), JSON.stringify(emptyTileset));
  fs.writeFileSync(path.join(dir, 'footprints.json'), JSON.stringify({ ids: [], footprints: [] }));
  fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(report, null, 1));
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ schema: 'livecity-lod2-asset-manifest/1', noLod2: true, assets: [] }));
  return report;
}
