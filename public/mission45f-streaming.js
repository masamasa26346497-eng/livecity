/* Mission 45F: 全域3Dモードの区ストリーミング計画 + full/partial 判定 + 区全域 fit（DOM / Cesium 非依存。Node でテスト可能）。
 * 座標はすべて Live City 局所座標（x=東, z=南が正, m）。区データは osaka-24-wards.json の wards[]（bbox / sourceBuildings / sourceTiles）。 */
(function (root) {
  'use strict';
  const DEFAULTS = {
    detailMax: 2,        // 近景の詳細 3D を常駐させる区の上限
    coarseMax: 8,        // 中景の粗い LOD（高い SSE）で常駐させる区の上限
    detailDist: 3500,    // 視線中心から区 bbox までの水平距離がこの値以下 → 詳細候補
    coarseDist: 30000,   // 〃 この値以下 → 粗い候補
    detailHeight: 20000, // カメラ高度がこの値以下のときだけ詳細（区全域 fit の高度を含む。細部は SSE が間引く）
    coarseHeight: 90000, // 〃 粗い LOD はこの高度以下のときだけ
    hysteresis: 1.3,     // mount 済みは条件を 1.3 倍まで緩めて維持（ちらつき・再取得防止）
    coarseSse: 128,
  };
  function distToBBox(x, z, b) {
    const dx = Math.max(b.minX - x, 0, x - b.maxX), dz = Math.max(b.minZ - z, 0, z - b.maxZ);
    return Math.hypot(dx, dz);
  }
  /* cam: { x, z, height }  wards: [{ wardCode, bbox }]  mounted: { wardCode: 'detail'|'coarse' }
   * 戻り値: { want: { wardCode: 'detail'|'coarse' }, drop: [wardCode] }。detail は最大 detailMax、detail+coarse は最大 detailMax+coarseMax。 */
  function plan(cam, wards, mounted, opt) {
    const o = Object.assign({}, DEFAULTS, opt || {});
    mounted = mounted || {};
    const scored = wards.map((w) => ({ code: w.wardCode, d: distToBBox(cam.x, cam.z, w.bbox) })).sort((a, b) => a.d - b.d);
    const want = {};
    let nd = 0, nc = 0;
    for (const s of scored) {
      const m = mounted[s.code], k = m ? o.hysteresis : 1;
      if (nd < o.detailMax && cam.height <= o.detailHeight * k && s.d <= o.detailDist * k && (m !== 'coarse' || s.d <= o.detailDist)) { want[s.code] = 'detail'; nd++; continue; }
      if (nc < o.coarseMax && cam.height <= o.coarseHeight * k && s.d <= o.coarseDist * k) { want[s.code] = 'coarse'; nc++; }
    }
    return { want, drop: Object.keys(mounted).filter((c) => !want[c]) };
  }
  /* full/partial 判定。full は「45E が 45D の検証済み証明を再計算して配信した (verified)」かつ
   * build-report の棟数・タイル数が区の元データ以上、の場合だけ。合成・限定メッシュ・?ext= 単体は partial。 */
  function coverageState(meta, ward) {
    const n = (meta.report && meta.report.totals && meta.report.totals.buildings) | 0;
    const t = (meta.report && meta.report.selectedTiles) | 0;
    if (!n || !t) return 'none';
    if (meta.verified45 === true && ward && ward.sourceBuildings > 0 && n >= ward.sourceBuildings && t >= (ward.sourceTiles | 0)) return 'full';
    return 'partial';
  }
  /* 区全域 fit のカメラ距離。N03 bbox と tileset 境界球の両方を含む半径 r を、fov とキャンバスの見える部分から求める。
   * canvas: { w, h }  insets: { left, right }（サイドパネル / 右パネルで隠れる px）  戻り: range(m) */
  function fitRange(radius, fovY, canvas, insets, pitchRad) {
    const ins = insets || {};
    const vw = Math.max(240, canvas.w - (ins.left || 0) - (ins.right || 0)), vh = Math.max(240, canvas.h);
    const aspect = vw / vh;
    const fovX = 2 * Math.atan(Math.tan(fovY / 2) * aspect);
    const f = Math.min(fovY, fovX);
    const tilt = 1 / Math.max(0.55, Math.cos(Math.min(1.2, Math.abs(pitchRad || 0)) * 0.5));   // 斜め視点では地面の見える奥行きが縮む分、余裕を足す
    const k = (canvas.w * 1.0) / vw;   // パネルで隠れる分だけ遠ざける
    return (radius / Math.sin(f / 2)) * 1.12 * tilt * Math.min(1.6, k);
  }
  /* bbox（局所座標）と tileset 境界球の半径(m)・中心(局所座標)から、両方を含む円 { x, z, r } */
  function unionCircle(bbox, sphere) {
    const bx = (bbox.minX + bbox.maxX) / 2, bz = (bbox.minZ + bbox.maxZ) / 2, br = Math.hypot(bbox.maxX - bbox.minX, bbox.maxZ - bbox.minZ) / 2;
    if (!sphere) return { x: bx, z: bz, r: br };
    const d = Math.hypot(sphere.x - bx, sphere.z - bz);
    if (d + sphere.r <= br) return { x: bx, z: bz, r: br };
    if (d + br <= sphere.r) return { x: sphere.x, z: sphere.z, r: sphere.r };
    const r = (d + br + sphere.r) / 2, t = (r - br) / d;
    return { x: bx + (sphere.x - bx) * t, z: bz + (sphere.z - bz) * t, r };
  }
  const api = { DEFAULTS, distToBBox, plan, coverageState, fitRange, unionCircle };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.LC45F = api;
})(typeof window !== 'undefined' ? window : globalThis);
