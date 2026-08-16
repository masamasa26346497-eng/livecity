// tools/lib/validate.js
import { geoToLocal } from './projection.js';

const REQUIRED_FIELDS = {
  roads: ['highway', 'p'],
  parks: ['tag', 'p'],
  facilities: ['name', 'category', 'priority', 'p'],
  railways: null, // {lines, stations} という別構造のため個別チェック
  waterways: ['type', 'p'],
};

/**
 * 1レイヤーのデータを検証する。
 * @returns {{layer:string, pass:boolean, checks:object[]}}
 */
export function validateLayer(layerName, data, areaConfig, fileSizeBytes) {
  const checks = [];

  // 1. 空データチェック
  const isEmptyArray = Array.isArray(data) && data.length === 0;
  const isEmptyObject = !Array.isArray(data) && data && Object.keys(data).length === 0;
  checks.push({
    name: 'not-empty',
    pass: !isEmptyArray && !isEmptyObject && data != null,
    detail: isEmptyArray ? '配列が空' : isEmptyObject ? 'オブジェクトが空' : 'OK',
  });

  // 2. ファイルサイズチェック（0バイトでないか）
  checks.push({
    name: 'file-size',
    pass: fileSizeBytes > 0,
    detail: `${fileSizeBytes} bytes`,
  });

  // 3. 件数チェック
  let recordCount;
  if (Array.isArray(data)) recordCount = data.length;
  else if (data && data.lines && data.stations) recordCount = data.lines.length + data.stations.length;
  else recordCount = data ? 1 : 0;
  checks.push({ name: 'record-count', pass: recordCount > 0, detail: `${recordCount}件` });

  // 4. 必須属性チェック
  const requiredFields = REQUIRED_FIELDS[layerName];
  if (requiredFields && Array.isArray(data)) {
    const missingFieldSamples = [];
    for (const item of data.slice(0, 200)) {
      // 先頭200件のみ抽出チェック(全件チェックは大規模データで非効率なため)
      for (const field of requiredFields) {
        if (!(field in item)) {
          missingFieldSamples.push(field);
        }
      }
    }
    checks.push({
      name: 'required-fields',
      pass: missingFieldSamples.length === 0,
      detail: missingFieldSamples.length ? `欠落: ${[...new Set(missingFieldSamples)].join(', ')}` : 'OK',
    });
  }

  // 5. 座標範囲チェック（プロジェクションされた座標がbboxから大きく外れていないか）
  if (Array.isArray(data) && data.length && areaConfig.projection) {
    const sw = geoToLocal(areaConfig.bbox.south, areaConfig.bbox.west, areaConfig.projection);
    const ne = geoToLocal(areaConfig.bbox.north, areaConfig.bbox.east, areaConfig.projection);
    const margin = 200; // OSMのbboxクロス取得特性上、わずかに範囲外の点が混じることがあるため許容幅を設ける
    let outOfRangeCount = 0;
    for (const item of data) {
      const points = item.p ? [item.p] : [];
      for (const [x, z] of points) {
        if (x < sw.x - margin || x > ne.x + margin || z < sw.z - margin || z > ne.z + margin) {
          outOfRangeCount++;
        }
      }
    }
    checks.push({
      name: 'coordinate-range',
      pass: outOfRangeCount < data.length * 0.5, // 半数以上が範囲外なら明確な異常とみなす
      detail: `範囲外: ${outOfRangeCount}/${data.length}`,
    });
  }

  const pass = checks.every((c) => c.pass);
  return { layer: layerName, pass, checks, recordCount };
}
