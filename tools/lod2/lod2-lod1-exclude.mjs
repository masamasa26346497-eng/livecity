// Mission 166: ClippingPolygon(凸包)に頼らない、ID ベースの LOD1 除外リスト生成と LOD1 側の突合。
// 設計: LOD2 manifest の gml:id 集合 = 「LOD1 から消す ID」。LOD1 タイル(PR#51 の ids/*.json 形式 = 文字列配列 or {ids:[..]})
// と突き合わせ、(a) 除外される LOD1 棟数 (b) LOD1 に存在しない LOD2 ID (c) LOD2 変換失敗で LOD1 に残すべき ID を数える。
// LOD1 を持つのに LOD2 が無い棟は一切除外しない(欠落ゼロの保証をテストで固定)。他 PR のファイルは変更しない。
import fs from 'node:fs';
import path from 'node:path';

export function lod2IdsFromManifest(manifest) {
  const s = new Set();
  for (const a of manifest.assets || []) for (const id of a.ids || []) {
    if (s.has(id)) throw new Error('duplicate LOD2 id in manifest: ' + id);
    s.add(id);
  }
  return s;
}
export function readLod1IdSet(dirOrFiles) {
  const files = Array.isArray(dirOrFiles) ? dirOrFiles
    : fs.readdirSync(dirOrFiles).filter((f) => f.endsWith('.json')).map((f) => path.join(dirOrFiles, f));
  const s = new Set();
  for (const f of files) {
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    for (const id of Array.isArray(j) ? j : j.ids || Object.keys(j.byId || {})) s.add(id);
  }
  return s;
}
/** @returns 突合結果。lod1Kept = 除外後に描かれる LOD1 の ID 集合。 */
export function planLod1Exclusion(lod1Ids, lod2Ids) {
  const excluded = [], kept = new Set(lod1Ids), lod2WithoutLod1 = [];
  for (const id of lod2Ids) { if (kept.delete(id)) excluded.push(id); else lod2WithoutLod1.push(id); }
  const doubleDrawn = [...kept].filter((id) => lod2Ids.has(id)); // 常に空のはず
  return { lod1Total: lod1Ids.size, excluded: excluded.length, lod1Kept: kept, lod2WithoutLod1, doubleDrawn,
    noLossCheck: lod1Ids.size === kept.size + excluded.length && doubleDrawn.length === 0 };
}
/** Cesium3DTileStyle 用の show 式(LOD1 GLB の feature に gml:id プロパティがある場合のみ有効。未検証)。 */
export function styleShowExpression(excludeIds, prop = 'gml_id', maxIds = 2000) {
  const ids = [...excludeIds];
  if (ids.length > maxIds) return null; // 巨大な式は避け、タイル単位のサイドカー除外へ
  return ids.length ? ids.map((i) => '${' + prop + '} !== "' + i.replace(/["\\]/g, '') + '"').join(' && ') : 'true';
}
