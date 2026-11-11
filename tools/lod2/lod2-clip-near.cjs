// Mission 177: カメラ近傍だけを対象にした LOD1 排他(ClippingPolygon)の選定ロジック。
// 10,698 足跡を一括で ClippingPolygon に渡すと固まる(Mission172)ため、
// 「高度が閾値未満」かつ「カメラ直下から半径 radiusM 以内」の足跡だけを最大 maxPolys 件に絞る。
// 純関数(Cesium 非依存)。ブラウザでは window.LC152ClipNear、Node では module.exports。
(function (root) {
  'use strict';
  const DEFAULTS = { maxHeightM: 2500, radiusM: 1200, maxPolys: 20 };
  function distM(lon1, lat1, lon2, lat2) {
    const kx = 111320 * Math.cos(((lat1 + lat2) / 2) * Math.PI / 180), ky = 110540;
    return Math.hypot((lon2 - lon1) * kx, (lat2 - lat1) * ky);
  }
  // footprints: [{hull:[[lon,lat],...]}]; cam: {lon,lat,h}
  // 戻り値: 選ばれた添字(近い順)。遠景(高度超過)では空配列 = クリップなし。
  function selectNearby(footprints, cam, opt) {
    const o = Object.assign({}, DEFAULTS);
    for (const k of Object.keys(opt || {})) if (Number.isFinite(opt[k])) o[k] = opt[k];
    if (!cam || !(cam.h < o.maxHeightM)) return [];
    const c = [];
    for (let i = 0; i < footprints.length; i++) {
      const p = footprints[i].hull[0];
      const d = distM(cam.lon, cam.lat, p[0], p[1]);
      if (d <= o.radiusM) c.push([d, i]);
    }
    c.sort((a, b) => a[0] - b[0]);
    return c.slice(0, o.maxPolys).map((x) => x[1]);
  }
  // 前回選定との差分が小さければ再構築を避ける(ClippingPolygon の再構築は高コスト)
  function needsUpdate(prev, next) {
    if (prev.length === 0 || next.length === 0) return prev.length !== next.length;
    const s = new Set(prev); let diff = 0;
    for (const i of next) if (!s.has(i)) diff++;
    return diff > Math.max(5, next.length * 0.1);
  }
  const api = { DEFAULTS, selectNearby, needsUpdate, distM };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.LC152ClipNear = api;
})(typeof window !== 'undefined' ? window : globalThis);
