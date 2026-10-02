// tools/lib/water-classify.js
// P1-6G: OSM の水域タグを描画クラスへ分類する。
//   実機で淀川・大和川・神崎川が「巨大な水色の板」に見えた。原因は「全水域を同一 material の
//   ベタ塗り」にしていたこと。河川（岸線主体）/ 池・湖（面フィル主体）/ 港湾・海（背景寄り）を
//   分け、河川は距離 LOD で遠景を岸線のみにする。
//
// public/osaka_3d_buildings.ward-ux-v1.html にも同じ分類を inline する（tile feature の
// f.waterClass を優先し、無ければタグから再分類）。

/**
 * @param {object} tags OSM タグ
 * @returns {'river'|'canal'|'stream'|'lake'|'pond'|'reservoir'|'harbour'|'water'}
 */
export function classifyWater(tags) {
  const t = tags || {};
  const w = (t.water || '').toLowerCase();
  const ww = (t.waterway || '').toLowerCase();
  const nat = (t.natural || '').toLowerCase();

  if (nat === 'coastline' || nat === 'bay' || nat === 'strait' || nat === 'cape'
    || t.harbour != null || t.seamark_type != null || w === 'harbour' || w === 'lagoon' || w === 'sea') return 'harbour';

  if (ww === 'river' || ww === 'riverbank' || w === 'river' || w === 'tidal_channel') return 'river';
  if (ww === 'canal' || ww === 'drain' || ww === 'ditch' || w === 'canal' || w === 'ditch' || w === 'drain' || w === 'moat') return 'canal';
  if (ww === 'stream' || w === 'stream') return 'stream';
  if (w === 'lake' || w === 'oxbow') return 'lake';
  if (w === 'pond' || w === 'fishpond') return 'pond';
  if (w === 'reservoir' || w === 'basin' || w === 'wastewater' || w === 'reflecting_pool') return 'reservoir';

  return 'water'; // natural=water で subtype 不明
}

/**
 * 描画ファミリ。linear=岸線主体（距離LODで遠景fill消去） / basin=面フィル主体 / harbour=背景寄り。
 * @param {string} waterClass
 * @param {number} [bboxDiag] outer bbox 対角(m)。natural=water(subtype不明)の大小判定に使う。
 * @returns {'linear'|'basin'|'harbour'}
 */
export function waterRenderFamily(waterClass, bboxDiag) {
  if (waterClass === 'harbour') return 'harbour';
  if (waterClass === 'lake' || waterClass === 'pond' || waterClass === 'reservoir') return 'basin';
  if (waterClass === 'river' || waterClass === 'canal' || waterClass === 'stream') return 'linear';
  // natural=water（subtype 不明）: 小さければ池扱い(basin)、大きければ河川扱い(linear)。
  if (waterClass === 'water') return (Number.isFinite(bboxDiag) && bboxDiag > 600) ? 'linear' : 'basin';
  return 'linear';
}
