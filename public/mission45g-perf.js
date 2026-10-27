/* Mission 45G: 全域3Dの高速化ロジック（DOM / Cesium 非依存。Node でテスト可能）。
 * 座標は Live City 局所座標（x=東, z=南が正, m）。ここは判断だけを担い、描画 API は呼ばない。 */
(function (root) {
  'use strict';
  const DEFAULTS = {
    // 解像度の自動調整（動作中だけ下げ、止まれば戻す）。minScale 未満には下げない。
    minScale: 0.8, maxScale: 1.0, step: 0.1,   // 45H: 文字の読みやすさ優先で下限 0.8（?res=speed のみ 0.6）
    restoreMs: 700,      // 45H: 最後の移動からこの壁時計時間が経てば maxScale へ戻す（フレーム数に依存しない）
    downMs: 40,          // 直近 downWindow フレームの平均がこれを超えたら下げる
    upMs: 22,            // 直近 upWindow フレームの平均がこれ未満なら戻す
    downWindow: 20, upWindow: 60,
    cooldownFrames: 45,  // 変更直後はこのフレーム数だけ再変更しない（ヒステリシス）
    // 3D Tiles のキャッシュ予算（全 tileset 合計）。Cesium 既定は tileset ごとに 512MB(+overflow 512MB)。
    cacheTotalMB: 768, cacheMinMB: 64, cacheOverflowMB: 64,
    // 画面外の粗 LOD 区を mount しない判定
    viewMarginDeg: 12, nearKeepM: 3500, tiltCullMaxPitchDeg: -65,
  };

  /* requestRenderMode: ext45 では既定 ON（?rr=0 で無効）、それ以外のページ状態では ?rr=1 のときだけ ON。 */
  function useRequestRender(ext45, rrParam) {
    if (rrParam === '0') return false;
    if (rrParam === '1') return true;
    return !!ext45;
  }

  /* 解像度コントローラ。frame(ms, moving) を毎フレーム渡す → 変更が必要なときだけ新しい scale を返す（なければ null）。
   * preset 'quality' / opt.fixed は常に maxScale 固定。moving=false が続けば maxScale へ戻す。 */
  function createResolutionController(opt) {
    const o = Object.assign({}, DEFAULTS, opt || {});
    let scale = o.maxScale, cool = 0, idle = 0, lastMoveMs = -Infinity;
    const buf = [];
    const r2 = (v) => Math.round(v * 100) / 100;
    return {
      get scale() { return scale; },
      /* 45H: 壁時計ベースの復元。requestRenderMode では静止後に描画フレームがほとんど来ないため、frame() の 20 フレーム待ちでは戻らない。
       * タイマー / camera.moveEnd から呼ぶ。戻すべきなら maxScale を返し、不要なら null。 */
      tick(nowMs, moving) {
        if (o.fixed) return null;
        if (moving) { lastMoveMs = nowMs; return null; }
        if (scale >= o.maxScale || nowMs - lastMoveMs < o.restoreMs) return null;
        scale = o.maxScale; cool = o.cooldownFrames; buf.length = 0; idle = 0;
        return scale;
      },
      frame(ms, moving, nowMs) {
        if (o.fixed) return null;
        if (moving && typeof nowMs === 'number') lastMoveMs = nowMs;
        if (cool > 0) cool--;
        buf.push(ms); if (buf.length > o.upWindow) buf.shift();
        const avg = (n) => { const a = buf.slice(-n); return a.reduce((s, v) => s + v, 0) / (a.length || 1); };
        let next = scale;
        if (moving) {
          idle = 0;
          if (!cool && buf.length >= o.downWindow && avg(o.downWindow) > o.downMs) next = Math.max(o.minScale, r2(scale - o.step));
        } else {
          idle++;
          // 止まって 20 フレーム経ったら品質を戻す（静止画は常に最高画質）
          if (idle >= 20 && scale < o.maxScale) next = o.maxScale;
        }
        if (next === scale) return null;
        scale = next; cool = o.cooldownFrames; buf.length = 0;
        return scale;
      },
    };
  }

  /* 画面外判定。cam: { x, z, headingRad, pitchRad, fovRad(縦), aspect }。bbox は局所座標。
   * 真下に近い視点（pitch < tiltCullMaxPitchDeg）では水平方向のカリングは意味を持たないので常に true。
   * 斜め視点では、bbox 4 隅の方位がすべて視錐台(水平 fov/2 + margin)の外で、かつカメラ直下から nearKeepM より遠い区だけを「画面外」とする。
   * heading は北=0 から時計回り。局所座標では北 = -z。 */
  function inView(cam, bbox, opt) {
    const o = Object.assign({}, DEFAULTS, opt || {});
    const pitchDeg = (cam.pitchRad || 0) * 180 / Math.PI;
    if (pitchDeg <= o.tiltCullMaxPitchDeg) return true;
    const dx = Math.max(bbox.minX - cam.x, 0, cam.x - bbox.maxX), dz = Math.max(bbox.minZ - cam.z, 0, cam.z - bbox.maxZ);
    if (Math.hypot(dx, dz) <= o.nearKeepM) return true;
    const fovX = 2 * Math.atan(Math.tan((cam.fovRad || 1) / 2) * (cam.aspect || 1.6));
    const half = fovX / 2 + o.viewMarginDeg * Math.PI / 180;
    const fx = Math.sin(cam.headingRad || 0), fz = -Math.cos(cam.headingRad || 0);   // 前方単位ベクトル（x=東, z=南が正）
    for (const [px, pz] of [[bbox.minX, bbox.minZ], [bbox.maxX, bbox.minZ], [bbox.maxX, bbox.maxZ], [bbox.minX, bbox.maxZ]]) {
      const vx = px - cam.x, vz = pz - cam.z, len = Math.hypot(vx, vz);
      if (len < 1) return true;
      const ang = Math.acos(Math.max(-1, Math.min(1, (vx * fx + vz * fz) / len)));
      if (ang <= half) return true;
    }
    // 4 隅がすべて外でも、bbox が視錐台の中を横切ることがある（区が大きく、カメラの正面にまたがる）。前方の線分で確認。
    for (let i = 0; i < 4; i++) {
      const c = [[bbox.minX, bbox.minZ], [bbox.maxX, bbox.minZ], [bbox.maxX, bbox.maxZ], [bbox.minX, bbox.maxZ]];
      const a = c[i], b = c[(i + 1) % 4];
      for (let t = 0.1; t < 1; t += 0.2) {
        const vx = a[0] + (b[0] - a[0]) * t - cam.x, vz = a[1] + (b[1] - a[1]) * t - cam.z, len = Math.hypot(vx, vz);
        if (len < 1) return true;
        if (Math.acos(Math.max(-1, Math.min(1, (vx * fx + vz * fz) / len))) <= half) return true;
      }
    }
    return false;
  }

  /* 45F の plan() の結果から、画面外の coarse 区を外す。detail は触らない（近景の正確な建物は消さない）。
   * mounted 済みの coarse が画面外になったときは drop へ追加する（画面に戻れば再 mount。粗 LOD は小さいので再取得コストは低い）。 */
  function cullPlan(p, cam, wards, mounted, opt) {
    mounted = mounted || {};
    const byCode = new Map(wards.map((w) => [w.wardCode, w]));
    const want = {}, culled = [];
    for (const [code, lvl] of Object.entries(p.want)) {
      const w = byCode.get(code);
      if (lvl === 'coarse' && w && !inView(cam, w.bbox, opt)) { culled.push(code); continue; }
      want[code] = lvl;
    }
    const drop = p.drop.concat(culled.filter((c) => mounted[c] && !p.drop.includes(c)));
    return { want, drop, culled };
  }

  /* tileset ごとのキャッシュ予算(bytes)。合計 cacheTotalMB を n 個で割り、下限 cacheMinMB。 */
  function cacheBudget(n, opt) {
    const o = Object.assign({}, DEFAULTS, opt || {});
    const per = Math.max(o.cacheMinMB, Math.floor(o.cacheTotalMB / Math.max(1, n)));
    return { cacheBytes: per * 1048576, maximumCacheOverflowBytes: o.cacheOverflowMB * 1048576, perMB: per };
  }

  /* フレーム時間(ms)配列 → { n, avgFps, avgMs, p95Ms, maxMs }。空なら null（数値を作らない）。 */
  function summarizeFrames(ms) {
    if (!ms || !ms.length) return null;
    const s = Array.from(ms).sort((a, b) => a - b);
    const avg = s.reduce((a, b) => a + b, 0) / s.length;
    return { n: s.length, avgMs: +avg.toFixed(2), avgFps: +(1000 / avg).toFixed(1), p95Ms: +s[Math.min(s.length - 1, Math.floor(s.length * 0.95))].toFixed(1), maxMs: +s[s.length - 1].toFixed(1) };
  }

  /* ネットワーク集計。entries: PerformanceResourceTiming 相当 [{ name, transferSize, encodedBodySize }]。
   * 返すのは件数とバイトのみ（URL・パス・ID は返さない）。種別は拡張子だけで分類する。 */
  function netSummary(entries) {
    const o = { requests: 0, bytes: 0, glb: 0, json: 0, other: 0 };
    for (const e of entries || []) {
      const n = String(e.name || '').split('?')[0].toLowerCase();
      if (!/\/ext-3dtiles\//.test(n)) continue;
      o.requests++; o.bytes += (e.transferSize || e.encodedBodySize || 0);
      if (n.endsWith('.glb')) o.glb++; else if (n.endsWith('.json')) o.json++; else o.other++;
    }
    return o;
  }

  const api = { DEFAULTS, useRequestRender, createResolutionController, inView, cullPlan, cacheBudget, summarizeFrames, netSummary };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.LC45G = api;
})(typeof window !== 'undefined' ? window : globalThis);
