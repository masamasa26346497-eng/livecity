// tools/lib/geojson-geometry.js
// GeoJSON geometryの構造検証、およびThree.js座標系のリング配列への変換を1箇所に集約する。
// tools/ingest/official-boundaries-from-geojson.js と tools/ingest/n03-administrative-boundaries.js
// の両方が使う共通処理（AUTODEV_RULES.md 9条: 既存ロジックの重複実装を避けるため抽出した）。
// 座標変換式自体はtools/lib/projection.jsのconvertCoordsArrayに委譲する（新たな変換式は作らない）。
import { convertCoordsArray } from './projection.js';

function validateRing(ring) {
  if (!Array.isArray(ring) || ring.length === 0) {
    throw new Error('リングが空、または配列ではありません。');
  }
  for (const pt of ring) {
    if (!Array.isArray(pt) || pt.length < 2 || typeof pt[0] !== 'number' || typeof pt[1] !== 'number') {
      throw new Error(`座標点が不正です: ${JSON.stringify(pt)}`);
    }
    if (!Number.isFinite(pt[0]) || !Number.isFinite(pt[1])) {
      throw new Error(`座標点が有限値ではありません: ${JSON.stringify(pt)}`);
    }
  }
  return ring;
}

/**
 * geometryの構造を検証する（座標変換はしない）。不正なら例外を投げる。
 * @param {object} geometry GeoJSON geometry
 * @param {{allowPoint?: boolean}} [options] allowPoint:true の場合のみPoint型を許可する
 *   （e-Stat属性データ取得方式では図形中心点のみのレコードが正当に存在するため）。
 */
export function validateGeometryStructure(geometry, { allowPoint = false } = {}) {
  if (!geometry || typeof geometry !== 'object') {
    throw new Error('geometryが存在しません。');
  }
  const { type, coordinates } = geometry;
  if (!coordinates || !Array.isArray(coordinates)) {
    throw new Error(`geometry.coordinatesが配列ではありません(type: ${type})。`);
  }
  if (type === 'Point') {
    if (!allowPoint) {
      throw new Error('geometry.type "Point" はこの用途では許可されていません(Polygon/MultiPolygonが必要です)。');
    }
    const pt = coordinates;
    if (!Array.isArray(pt) || pt.length < 2 || typeof pt[0] !== 'number' || typeof pt[1] !== 'number') {
      throw new Error(`Point座標が不正です: ${JSON.stringify(pt)}`);
    }
    if (!Number.isFinite(pt[0]) || !Number.isFinite(pt[1])) {
      throw new Error(`Point座標が有限値ではありません: ${JSON.stringify(pt)}`);
    }
    return;
  }
  if (type === 'Polygon') {
    coordinates.forEach(validateRing);
    return;
  }
  if (type === 'MultiPolygon') {
    for (const polygonCoords of coordinates) {
      if (!Array.isArray(polygonCoords)) {
        throw new Error('MultiPolygonの要素がPolygon座標配列(リングの配列)ではありません。');
      }
      polygonCoords.forEach(validateRing);
    }
    return;
  }
  throw new Error(`未対応のgeometry.type: "${type}" (${allowPoint ? 'Point/' : ''}Polygon/MultiPolygonのみ対応)`);
}

/**
 * GeoJSONのgeometryをThree.js座標系のリング配列(既存TOWN_POLYGONS形式と同一の
 * [[[x,z],...], ...] 構造)へ変換する。Point/Polygon/MultiPolygonに対応する。
 * 不正なgeometry(型不明、coordinates欠落、座標が数値でない等)は例外として呼び出し側に伝える。
 */
export function convertGeometryToRings(geometry, projection) {
  validateGeometryStructure(geometry, { allowPoint: true });
  const { type, coordinates } = geometry;

  if (type === 'Point') {
    // 図形中心点のみ(ポリゴン形状が未取得のレコード)。1点だけのリングとして表現する。
    return [convertCoordsArray([coordinates], projection)];
  }
  if (type === 'Polygon') {
    // Polygon.coordinates = [外周リング, 穴リング1, 穴リング2, ...]
    return coordinates.map((ring) => convertCoordsArray(ring, projection));
  }
  // MultiPolygon.coordinates = [Polygon1のリング群, Polygon2のリング群, ...]
  // 既存のTOWN_POLYGONS形式(リングの配列)と互換にするため、全Polygonの外周・穴リングを
  // フラットに1つの配列へまとめる(複数ポリゴンを持つ町丁目=飛び地として扱う既存設計を踏襲)。
  const rings = [];
  for (const polygonCoords of coordinates) {
    for (const ring of polygonCoords) {
      rings.push(convertCoordsArray(ring, projection));
    }
  }
  return rings;
}

/**
 * 同一行政区が複数Feature(複数Polygon/MultiPolygon)に分かれて出現する場合に、
 * 1つのMultiPolygon geometryへ統合する(N03行政区域データでは同一区が複数Featureに
 * 分割されて出現するのが正常なデータ形であり、飛び地の扱いと同様にフラットな
 * Polygon群として扱う)。
 * @param {object[]} geometries 検証済みのPolygon/MultiPolygon geometryの配列
 */
export function mergeGeometriesToMultiPolygon(geometries) {
  const polygons = [];
  for (const geometry of geometries) {
    if (geometry.type === 'Polygon') {
      polygons.push(geometry.coordinates);
    } else if (geometry.type === 'MultiPolygon') {
      for (const polygonCoords of geometry.coordinates) {
        polygons.push(polygonCoords);
      }
    } else {
      throw new Error(`mergeGeometriesToMultiPolygon: 未対応のgeometry.type "${geometry.type}"(Polygon/MultiPolygonのみ対応)`);
    }
  }
  return { type: 'MultiPolygon', coordinates: polygons };
}
