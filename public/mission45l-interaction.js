/* Mission 45L: 操作（ドラッグ / ホイール / 慣性）の単一の判定源と、操作中の計測（DOM / Cesium 非依存。Node でテスト可能）。
 * 入力イベント（pointer / wheel）とカメラ移動（moveStart / changed）を統合し、「操作中」を一貫して返す。
 * 計測値は件数・ms のみ（位置・建物 ID・URL は含めない）。 */
(function (root) {
  'use strict';
  const DEFAULTS = { wheelMs: 220, cameraMs: 400, maxFrames: 600 };

  function pct(arr, p) { if (!arr.length) return null; const s = arr.slice().sort((a, b) => a - b); return Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))] * 10) / 10; }

  function create(opts) {
    const o = Object.assign({}, DEFAULTS, opts || {});
    const st = { pointers: 0, lastWheel: -1e9, lastCam: -1e9, gestures: 0, active: false, firstInputAt: 0 };
    const m = { gestureFrames: [], gestureRenders: 0, inputToRenderMs: [], resChangesInGesture: 0, longTasksInGesture: 0, longTaskMsInGesture: 0, deferred: 0, gestureSyncs: 0, resBudget: 1 };
    const isActive = (now) => st.pointers > 0 || now - st.lastWheel < o.wheelMs || now - st.lastCam < o.cameraMs;
    function touch(now) {
      if (!st.firstInputAt) st.firstInputAt = now;
      if (!st.active) { st.active = true; st.gestures++; m.resBudget = 1; }
    }
    return {
      pointerDown(now) { st.pointers++; touch(now); },
      pointerUp(now) { st.pointers = Math.max(0, st.pointers - 1); st.lastCam = Math.max(st.lastCam, now); },
      wheel(now) { st.lastWheel = now; touch(now); },
      cameraMoved(now) { st.lastCam = now; touch(now); },
      isActive,
      /** 描画フレームごとに呼ぶ。dt=前フレームからの ms。操作中のフレームだけ別に積む（静止時の RR 間隔と混ぜない）。 */
      frame(now, dt) {
        const a = isActive(now);
        if (a) {
          m.gestureRenders++;
          if (dt < 2000) { m.gestureFrames.push(dt); if (m.gestureFrames.length > o.maxFrames) m.gestureFrames.shift(); }
        } else st.active = false;
        if (st.firstInputAt) { m.inputToRenderMs.push(now - st.firstInputAt); if (m.inputToRenderMs.length > 50) m.inputToRenderMs.shift(); st.firstInputAt = 0; }
        return a;
      },
      /** 操作中の解像度変更は 1 ジェスチャーにつき 1 回まで。静止後の復帰（restoring）は無制限。許可なら true。 */
      allowResChange(now, restoring) {
        if (restoring || !isActive(now)) return true;
        if (m.resBudget > 0) { m.resBudget--; m.resChangesInGesture++; return true; }
        return false;
      },
      noteLongTask(ms, now) { if (isActive(now)) { m.longTasksInGesture++; m.longTaskMsInGesture += ms; } },
      noteDeferred() { m.deferred++; },
      noteSync(now) { if (isActive(now)) m.gestureSyncs++; },
      snapshot(now) {
        const f = m.gestureFrames;
        return {
          gestures: st.gestures, activeNow: isActive(now), gestureRenders: m.gestureRenders,
          fps: f.length ? Math.round(1000 / (f.reduce((a, b) => a + b, 0) / f.length) * 10) / 10 : null,
          p50Ms: pct(f, 0.5), p95Ms: pct(f, 0.95), maxMs: f.length ? Math.round(Math.max.apply(null, f)) : null,
          framesOver50ms: f.filter((x) => x > 50).length, inputToRenderMs: pct(m.inputToRenderMs, 0.5),
          longTasksInGesture: m.longTasksInGesture, longTaskMsInGesture: Math.round(m.longTaskMsInGesture),
          resChangesInGesture: m.resChangesInGesture, deferredWork: m.deferred, vecSyncsInGesture: m.gestureSyncs,
        };
      },
      reset() {
        m.gestureFrames = []; m.gestureRenders = 0; m.inputToRenderMs = []; m.resChangesInGesture = 0;
        m.longTasksInGesture = 0; m.longTaskMsInGesture = 0; m.deferred = 0; m.gestureSyncs = 0;
      },
    };
  }
  const api = { DEFAULTS, create };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.LC45L = api;
})(typeof window !== 'undefined' ? window : globalThis);
