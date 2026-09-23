// tools/lib/water-render-lod.js
// P1-6G: 水域の距離 LOD パラメータと岸線ジオメトリ生成（純粋・THREE 非依存）。
//   canonical。public/osaka_3d_buildings.ward-ux-v1.html にも同じロジックを inline する。
//
// 方針:
//   - 河川(linear): 遠景は岸線のみ。中景で薄いフィル、近景で通常フィル。
//   - 池・湖(basin): 距離によらず面フィル中心（コンパクトで板に見えない）。近景で岸線も。
//   - 港湾・海(harbour): 背景寄り。ごく薄いフィルのみ、岸線なし、極遠景で消す。
//   - 巨大河川(bboxDiag>GIANT_DIAG など): 中景でもフィルを出さず、近景のみ薄く。

export const GIANT_DIAG_M = 2500;      // outer bbox 対角がこれ超で「巨大河川」扱い
export const GIANT_AREA_KM2 = 0.35;

export const BAND_FAR_M = 6000;
export const BAND_MID_M = 3000;

export function waterBand(distance) {
  const d = Number.isFinite(distance) ? distance : 0;
  if (d > BAND_FAR_M) return 'far';
  if (d > BAND_MID_M) return 'mid';
  return 'near';
}

export function isGiantWater({ bboxDiag = 0, areaKm2 = 0 } = {}) {
  return bboxDiag > GIANT_DIAG_M || areaKm2 > GIANT_AREA_KM2;
}

function lerpClamp(x, x0, x1, y0, y1) {
  if (x1 === x0) return y0;
  const t = Math.max(0, Math.min(1, (x - x0) / (x1 - x0)));
  return y0 + (y1 - y0) * t;
}

/**
 * [P1-6H] 距離で滑らかに減衰する低 opacity（帯・板を作らない）。
 * public/osaka_3d_buildings.ward-ux-v1.html の CityTileLayer waterLod() と同一。
 * @param {object} p
 * @param {number} p.distance      camera 距離(m)
 * @param {'legacy'|'shoreline'|'lod'} [p.mode='lod']
 * @param {'linear'|'basin'|'harbour'} [p.family='linear']
 * @param {number} [p.bboxDiag]
 * @param {number} [p.areaKm2]
 * @returns {{band:string, fillVisible:boolean, fillOpacity:number, shorelineVisible:boolean, shorelineOpacity:number, giant:boolean}}
 */
export function waterLodParams(p = {}) {
  const mode = p.mode || 'lod';
  const family = p.family || 'linear';
  const band = waterBand(p.distance);
  const giant = isGiantWater(p);
  const d = Number.isFinite(p.distance) ? p.distance : 4000;

  if (mode === 'legacy') {
    return { band, fillVisible: family !== 'harbour', fillOpacity: 0.5, shorelineVisible: false, shorelineOpacity: 0, giant };
  }
  if (mode === 'shoreline') {
    return { band, fillVisible: false, fillOpacity: 0, shorelineVisible: family !== 'harbour', shorelineOpacity: lerpClamp(d, 1000, 8000, 0.5, 0.75), giant };
  }

  // ── mode 'lod'（canonical・滑らかな距離減衰） ──
  let fillOpacity, shorelineOpacity;
  const shorelineVisible = family !== 'harbour';
  if (family === 'harbour') {
    fillOpacity = d > 9000 ? 0 : lerpClamp(d, 2000, 9000, 0.10, 0.04);
    shorelineOpacity = 0;
  } else if (family === 'basin') {
    fillOpacity = lerpClamp(d, 1500, 9000, 0.34, 0.14);        // 池湖は距離があっても残す
    shorelineOpacity = lerpClamp(d, 2500, 7000, 0.20, 0.45);
  } else if (giant) {
    fillOpacity = lerpClamp(d, 1800, 5200, 0.20, 0.0);         // 巨大河川は早く薄く消える
    shorelineOpacity = lerpClamp(d, 2500, 7000, 0.24, 0.5);
  } else {
    fillOpacity = lerpClamp(d, 2200, 6200, 0.30, 0.0);
    shorelineOpacity = lerpClamp(d, 2500, 7000, 0.22, 0.48);
  }
  // [P1-7B] City Mode（大阪市全域）は camera 距離が 9000m を大きく超える。河川の岸線が
  // そこでも強いままだと目立ちすぎるため、9000m 以遠はさらに弱める（basin/harbour は対象外）。
  if (family !== 'harbour' && family !== 'basin' && d > 9000) shorelineOpacity = lerpClamp(d, 9000, 20000, shorelineOpacity, 0.12);
  return { band, fillVisible: fillOpacity > 0.005, fillOpacity, shorelineVisible, shorelineOpacity, giant };
}

/**
 * リング群（各リングは [[x,z],...]）を閉じた LineSegments 用の flat 配列 [x,y,z, x,y,z, ...] へ。
 * @param {number[][][]} rings
 * @param {number} y
 * @returns {number[]}
 */
export function shorelineSegments3D(rings, y) {
  const pos = [];
  for (const ring of (rings || [])) {
    if (!Array.isArray(ring) || ring.length < 2) continue;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length]; // 閉じる
      if (!a || !b || !Number.isFinite(a[0]) || !Number.isFinite(b[0])) continue;
      pos.push(a[0], y, a[1], b[0], y, b[1]);
    }
  }
  return pos;
}

export function bboxDiagOf(ring) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const p of (ring || [])) {
    if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0];
    if (p[1] < minZ) minZ = p[1]; if (p[1] > maxZ) maxZ = p[1];
  }
  return Number.isFinite(minX) ? Math.hypot(maxX - minX, maxZ - minZ) : 0;
}
