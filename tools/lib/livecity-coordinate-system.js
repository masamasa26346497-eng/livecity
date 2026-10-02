// tools/lib/livecity-coordinate-system.js
// [Mission 32N §2/§4] Live City 共通座標系（world frame）の唯一の定義。
//
//   - 方式: local-equirectangular（config/areas/osaka-city.json の projection をそのまま使う）
//   - 原点: lat 34.604208 / lon 135.52502
//   - 軸:   +X = east / −Z = north / +Y = up（znorth-neg-v1）
//   - 単位: 1 world unit = 1 m（原点緯度の cos と metersPerDegree=111320 による近似）
//
//   平面直角座標系（第6系/第7系を含む）を中間 basis にしないこと（§3）。
//   Mission 32M で、建物だけが latLonToJPRect(zone 7) を経由していたために
//   地図に対して時計回り 0.93° 回転していたことが確定している。
//
//   道路（PLATEAU tran）・鉄道/水域/公園（OSM）・行政界（N03）の canonical は、
//   この関数で生 lat/lon を変換した値と頂点単位で一致することを 32M で実測済み。
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath } from './paths.js';

const AREA_CONFIG_PATH = resolveProjectPath(path.join('config', 'areas', 'osaka-city.json'));

let _proj = null;
export function liveCityProjection() {
  if (_proj) return _proj;
  const p = JSON.parse(fs.readFileSync(AREA_CONFIG_PATH, 'utf-8')).projection;
  if (!p || p.type !== 'local-equirectangular') throw new Error('osaka-city.json の projection が local-equirectangular ではない');
  _proj = Object.freeze({
    type: p.type,
    centerLat: p.centerLat,
    centerLon: p.centerLon,
    metersPerDegree: p.metersPerDegree,
    cosLat: Math.cos((p.centerLat * Math.PI) / 180),
    convention: 'znorth-neg-v1',
  });
  return _proj;
}

/** 緯度経度 → Live City world {x, z}（丸めなし）。 */
export function latLonToLiveCityWorld(lat, lon) {
  const p = liveCityProjection();
  return {
    x: (lon - p.centerLon) * p.cosLat * p.metersPerDegree,
    z: -((lat - p.centerLat) * p.metersPerDegree),
  };
}

/**
 * world → 緯度経度（表示・デバッグ用）。
 * ※ 位置検証の「正解」を作る用途に使ってはいけない（canonical から逆算した値を truth にすると
 *    変換の誤りが定義上 0 になる循環が起きる。FIX11 の失敗）。
 */
export function liveCityWorldToLatLon(x, z) {
  const p = liveCityProjection();
  return { lat: p.centerLat - z / p.metersPerDegree, lon: p.centerLon + x / (p.cosLat * p.metersPerDegree) };
}

export const LIVECITY_COORDINATE_SYSTEM_ID = 'livecity-equirect-znorth-neg-v1';
