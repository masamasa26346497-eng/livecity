// tools/lib/gsi-road-edge-transform.js
// [Mission 31G-FIX15 §4/§6] GSI 道路縁座標を Live City world（FIX11 で正本化した
//   local-equirectangular・znorth-neg-v1）へ変換し、N03 行政界（24区）で大阪市域のみへ絞る。
//
//   ★ 第6系・第7系への強制変換はしない（FIX11 Coordinate Authority を維持・§4 明記）。
//   ★ 入力が緯度経度（JGD2000/JGD2011 地理座標）以外（平面直角座標系等）の場合は変換せず
//     crsUnsupported として記録する（誤った変換で数百m ズレるのを防ぐ・捏造しない）。
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath } from './paths.js';
import { geoToLocal } from './projection.js';
import { classifyPointToWard } from './point-in-polygon.js';

const AREA_CONFIG = JSON.parse(fs.readFileSync(resolveProjectPath(path.join('config', 'areas', 'osaka-city.json')), 'utf-8'));
export const OSAKA_PROJECTION = AREA_CONFIG.projection;   // FIX11 で確定した正本（centerLat/centerLon/metersPerDegree）

const WARDS_PATH = resolveProjectPath(path.join('data', 'processed', 'osaka-city', 'boundaries', 'ward-classification-polygons.json'));

let _wards = null;
export function loadWards() {
  if (_wards) return _wards;
  try {
    const wc = JSON.parse(fs.readFileSync(WARDS_PATH, 'utf-8'));
    _wards = wc.wards.map((w) => ({ wardId: w.wardId, bbox: w.bbox, polygons: w.polygons }));
  } catch { _wards = []; }
  return _wards;
}

// [FIX16] 実データ（GSI 基盤地図情報 2026年配布分）の srsName は "fguuid:jgd2024.bl"（JGD2024・地理座標）
//   だった。JGD2000/JGD2011/JGD2024/WGS84 は地心固定枠の定義世代が異なるが、日本国内での測地成果間の
//   差は数cm〜十数cm オーダー（地殻変動補正込みでも）であり、既存 pipeline が PLATEAU(JGD2011/EPSG:6697)
//   を含め全 source を同一 local-equirectangular で扱っている現状（FIX10/11 で world 自己整合 0m・
//   N03 一致 99.999% と実証済み）と同じ精度前提で扱う。datum 変換（測地成果間変換）は行わない
//   （§0: 捏造しない＝存在しない高精度変換を装わない、の裏返しとして「無視できる差」も正直に記録する）。
const GEOGRAPHIC_DATUM_RE = /jgd2024|jgd2011|jgd2000|wgs84|4326|6668|6669/;
/** srsName 文字列から「地理座標(lat/lon)かどうか」と軸順を判定する。第6系等の投影座標系は非対応。 */
export function classifyCrs(srsName) {
  if (!srsName) return { supported: false, reason: 'srsName 不明', axisOrder: null };
  const s = srsName.toLowerCase();
  if (GEOGRAPHIC_DATUM_RE.test(s)) {
    // 6669 系文字列は「平面直角」を指すことがあるため、bl（緯度経度）表記の場合のみ地理座標とみなす。
    if (/\.bl\b|bl$/.test(s) || /4326|6668/.test(s)) return { supported: true, reason: null, axisOrder: 'lat-lon' };
    return { supported: false, reason: '平面直角座標系（系番号）の可能性があり非対応（§4: 第6系等へ強制変換しない）', axisOrder: null };
  }
  if (/6674|6673|6672|6671|6670|6675|6676|6677|6678|6679|6680|6681|6682|6683|6684|6685|6686|6687/.test(s)) {
    return { supported: false, reason: '平面直角座標系（系番号）は非対応。地理座標(lat/lon)のみサポート（§4）', axisOrder: null };
  }
  return { supported: false, reason: '未知の CRS: ' + srsName, axisOrder: null };
}

/** [lat,lon] ペア列 → Live City world [[x,z],...]（znorth-neg-v1・FIX11 正本）。 */
export function latLonPairsToWorld(pairs) {
  return pairs.map(([lat, lon]) => { const { x, z } = geoToLocal(lat, lon, OSAKA_PROJECTION); return [x, -z]; });
  // ↑ geoToLocal は z=(lat-centerLat)*mpd（北が+Z）。znorth-neg-v1（北=-Z）に合わせて符号反転する
  //   （既存 CanonicalRuntime / geoToThree と同じ規約。tools/lib/projection.js のコメント通り
  //   このプロジェクトの他レイヤーは z を反転して使っている・変更禁止の式そのものは geoToLocal 内で不変）。
}

/** world 座標の line が大阪市域（24区どれか）に触れるか（1点でも区内なら true）。線全体は境界を跨ぎうる。 */
export function touchesOsakaCity(worldCoords, wards) {
  for (const [x, z] of worldCoords) {
    const r = classifyPointToWard(x, z, wards);
    if (r.wardId) return true;
  }
  return false;
}
