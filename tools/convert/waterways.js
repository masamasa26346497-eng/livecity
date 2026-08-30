// tools/convert/waterways.js
// 河川・水域レイヤー変換。
// - way（waterway=river/canal/stream）      → kind:'line'（中心線）
// - way（natural=water 等の閉じたポリゴン） → kind:'area'
// - relation（multipolygon: natural=water / waterway=riverbank）
//     → outer member way を端点一致で連結して閉リングを構成し kind:'area'。
//       inner ring（中州）は holes として保持。未連結フラグメントは黙って捨てず unclosed へ記録する。
//
// 個別 outer way をそのまま閉ポリゴン化すると、way終端とway始端を結ぶ「地物を横断する巨大な辺」が
// でき、川面を横切る不自然な三角形になる（tools/fetch-water.js と同じ既知不具合）。連結処理は
// tools/lib/osm-multipolygon.js に集約している。
import { convertCoordsArray } from '../lib/projection.js';
import { assembleMultipolygon } from '../lib/osm-multipolygon.js';

function trimClosing(p) {
  return (p.length > 1 && p[0][0] === p[p.length - 1][0] && p[0][1] === p[p.length - 1][1])
    ? p.slice(0, -1) : p;
}

/**
 * @param {object[]} rawElements Overpass要素（way + relation。out geom 形式）
 * @param {object} projection area設定のprojection
 * @returns {Array<{type:string,name:string,kind:'line'|'area',p:number[][],holes?:number[][][]}>}
 *   併せて非enumerableでは無い形で unclosed 情報を返したい場合は convertWaterwaysWithReport を使う。
 */
export function convertWaterways(rawElements, projection) {
  return convertWaterwaysWithReport(rawElements, projection).items;
}

export function convertWaterwaysWithReport(rawElements, projection) {
  const items = [];
  const unclosed = [];

  for (const el of rawElements) {
    const tags = el.tags || {};

    if (el.type === 'way' && Array.isArray(el.geometry)) {
      const coords = el.geometry.map((pt) => [pt.lon, pt.lat]);
      let type;
      if (tags.waterway === 'river') type = 'river';
      else if (tags.waterway === 'canal') type = 'canal';
      else if (tags.waterway === 'stream') type = 'stream';
      else if (tags.natural === 'water' || tags.water || tags.waterway === 'riverbank') type = 'water';
      else continue;

      const isLine = type === 'river' || type === 'canal' || type === 'stream';
      let p = convertCoordsArray(coords, projection);
      if (isLine) {
        if (p.length < 2) continue;
        items.push({ type, name: tags.name || '', kind: 'line', p });
      } else {
        p = trimClosing(p);
        if (p.length < 3) continue;
        items.push({ type, name: tags.name || '', kind: 'area', p });
      }
      continue;
    }

    if (el.type === 'relation' && Array.isArray(el.members)) {
      const isWater = tags.natural === 'water' || tags.waterway === 'riverbank' || tags.water;
      if (!isWater) continue;
      const type = tags.waterway === 'riverbank' ? 'river' : 'water';
      const asm = assembleMultipolygon(el.members);
      for (const poly of asm.polygons) {
        const outer = trimClosing(convertCoordsArray(poly.outer, projection));
        if (outer.length < 3) continue;
        const holes = poly.holes
          .map((h) => trimClosing(convertCoordsArray(h, projection)))
          .filter((h) => h.length >= 3);
        const rec = { type, name: tags.name || '', kind: 'area', p: outer };
        if (holes.length) rec.holes = holes;
        items.push(rec);
      }
      if (asm.unclosed.length) {
        unclosed.push({
          id: `relation/${el.id}`,
          name: tags.name || '',
          fragments: asm.unclosed.map((f) => ({ role: f.role, points: f.points })),
        });
      }
    }
  }

  return { items, unclosed };
}
