// Mission 36L dev-only runtime/render budget guard.
// The map keeps its full datasets and exact click semantics, while expensive continuous work is
// reduced to human-visible update rates. Actual clicks are never throttled.
(() => {
  'use strict';

  const MARKER = '[Mission 36L PERF] runtime budget';
  const MAX_PIXEL_RATIO = 1.0;
  const LAYER_UPDATE_INTERVAL_MS = 125;   // 8 Hz is enough for label/facility scaling while navigating.
  const HOVER_PICK_INTERVAL_MS = 100;     // building hover raycast <= 10 Hz; click raycast stays immediate.
  const MATERIAL_UPDATE_INTERVAL_MS = 250;
  const TILE_UPDATE_INTERVAL_MS = 150;
  const SHADOW_UPDATE_EVERY_FRAMES = 8;

  const stats = {
    installed: false,
    pixelRatioApplied: false,
    beforePixelRatio: null,
    afterPixelRatio: null,
    labelUpdateCalls: 0,
    labelUpdateSkipped: 0,
    facilityUpdateCalls: 0,
    facilityUpdateSkipped: 0,
    hoverPickCalls: 0,
    hoverPickSkipped: 0,
    hoverPickSkippedDragging: 0,
    materialUpdateCalls: 0,
    materialUpdateSkipped: 0,
    tileIntervalBefore: null,
    tileIntervalAfter: null,
    shadowEveryBefore: null,
    shadowEveryAfter: null,
    errors: 0,
  };

  function nowMs() {
    return (typeof performance !== 'undefined' ? performance.now() : Date.now());
  }

  function getRendererBinding() {
    try { return (typeof renderer !== 'undefined') ? renderer : null; }
    catch (_) { return null; }
  }

  function applyPixelBudget() {
    const r = getRendererBinding();
    if (!r || typeof r.getPixelRatio !== 'function' || typeof r.setPixelRatio !== 'function') return false;
    const before = Number(r.getPixelRatio()) || 1;
    const target = Math.min(Number(window.devicePixelRatio) || 1, MAX_PIXEL_RATIO);
    stats.beforePixelRatio ??= before;
    if (before > target + 0.01) {
      const rect = r.domElement?.getBoundingClientRect?.();
      r.setPixelRatio(target);
      if (rect && rect.width > 0 && rect.height > 0 && typeof r.setSize === 'function') {
        r.setSize(Math.round(rect.width), Math.round(rect.height), false);
      }
      stats.pixelRatioApplied = true;
    }
    stats.afterPixelRatio = Number(r.getPixelRatio()) || target;
    return true;
  }

  function throttleObjectMethod(obj, name, intervalMs, callKey, skipKey) {
    if (!obj || typeof obj[name] !== 'function') return false;
    const flag = `__mission36lPerf_${name}`;
    if (obj[flag]) return true;
    const original = obj[name].bind(obj);
    let lastAt = -1e12;
    obj[name] = (...args) => {
      const now = nowMs();
      if (now - lastAt < intervalMs) {
        stats[skipKey]++;
        return;
      }
      lastAt = now;
      stats[callKey]++;
      return original(...args);
    };
    obj[flag] = true;
    return true;
  }

  function patchLayerUpdates() {
    let ok = true;
    try {
      const label = (typeof LabelLayer !== 'undefined') ? LabelLayer : null;
      ok = throttleObjectMethod(label, 'update', LAYER_UPDATE_INTERVAL_MS,
        'labelUpdateCalls', 'labelUpdateSkipped') && ok;
    } catch (_) { ok = false; }
    try {
      const facility = (typeof FacilityLayer !== 'undefined') ? FacilityLayer : null;
      ok = throttleObjectMethod(facility, 'update', LAYER_UPDATE_INTERVAL_MS,
        'facilityUpdateCalls', 'facilityUpdateSkipped') && ok;
    } catch (_) { ok = false; }
    return ok;
  }

  function patchHoverPicking() {
    try {
      if (typeof pickHit !== 'function') return false;
      if (pickHit.__mission36lHoverThrottled) return true;
      const original = pickHit;
      let lastAt = -1e12;
      let lastX = NaN;
      let lastY = NaN;
      let lastResult = null;

      const wrapped = function mission36lPickHit(event) {
        // Selection clicks must always perform an exact fresh pick.
        if (!event || event.type !== 'mousemove') return original(event);

        stats.hoverPickCalls++;
        try {
          if (typeof cs !== 'undefined' && cs && cs.drag) {
            stats.hoverPickSkippedDragging++;
            return null;
          }
        } catch (_) { /* continue */ }

        const now = nowMs();
        const x = Number(event.clientX);
        const y = Number(event.clientY);
        const moved = Number.isFinite(lastX) && Number.isFinite(lastY)
          ? Math.hypot(x - lastX, y - lastY) : Infinity;
        if (now - lastAt < HOVER_PICK_INTERVAL_MS && moved < 80) {
          stats.hoverPickSkipped++;
          return lastResult;
        }

        lastAt = now;
        lastX = x;
        lastY = y;
        lastResult = original(event);
        return lastResult;
      };
      wrapped.__mission36lHoverThrottled = true;
      pickHit = wrapped;
      return true;
    } catch (err) {
      stats.errors++;
      console.warn(MARKER, 'hover picker patch failed', err);
      return false;
    }
  }

  function patchMaterialUpdates() {
    try {
      if (typeof updateWindowMaterials !== 'function') return false;
      if (updateWindowMaterials.__mission36lPerfThrottled) return true;
      const original = updateWindowMaterials;
      let lastAt = -1e12;
      const wrapped = function mission36lWindowMaterialUpdate(...args) {
        const now = nowMs();
        if (now - lastAt < MATERIAL_UPDATE_INTERVAL_MS) {
          stats.materialUpdateSkipped++;
          return;
        }
        lastAt = now;
        stats.materialUpdateCalls++;
        return original(...args);
      };
      wrapped.__mission36lPerfThrottled = true;
      updateWindowMaterials = wrapped;
      return true;
    } catch (err) {
      stats.errors++;
      return false;
    }
  }

  function tuneBuildingRuntime() {
    let touched = false;
    try {
      if (typeof BUILDING_TILE_CONFIG !== 'undefined' && BUILDING_TILE_CONFIG) {
        if (stats.tileIntervalBefore == null) stats.tileIntervalBefore = Number(BUILDING_TILE_CONFIG.updateIntervalMs);
        BUILDING_TILE_CONFIG.updateIntervalMs = Math.max(
          Number(BUILDING_TILE_CONFIG.updateIntervalMs) || 0,
          TILE_UPDATE_INTERVAL_MS,
        );
        // Keep production-style visibility optimizations on even in dev preview.
        BUILDING_TILE_CONFIG.enableTileCulling = true;
        BUILDING_TILE_CONFIG.enableFrustumCulling = true;
        BUILDING_TILE_CONFIG.devLoadAllTiles = false;
        stats.tileIntervalAfter = Number(BUILDING_TILE_CONFIG.updateIntervalMs);
        touched = true;
      }
    } catch (err) { stats.errors++; }

    try {
      if (typeof SHADOW_THROTTLE !== 'undefined' && SHADOW_THROTTLE) {
        if (stats.shadowEveryBefore == null) stats.shadowEveryBefore = Number(SHADOW_THROTTLE.every);
        SHADOW_THROTTLE.every = Math.max(Number(SHADOW_THROTTLE.every) || 1, SHADOW_UPDATE_EVERY_FRAMES);
        stats.shadowEveryAfter = Number(SHADOW_THROTTLE.every);
        touched = true;
      }
    } catch (err) { stats.errors++; }
    return touched;
  }

  function install() {
    let tries = 0;
    const timer = setInterval(() => {
      tries++;
      const pixelReady = applyPixelBudget();
      const layersReady = patchLayerUpdates();
      const hoverReady = patchHoverPicking();
      const materialReady = patchMaterialUpdates();
      const runtimeReady = tuneBuildingRuntime();
      if ((pixelReady && layersReady && hoverReady && materialReady && runtimeReady) || tries >= 120) {
        clearInterval(timer);
        stats.installed = true;
        console.info(MARKER, window.__MISSION36L_RENDER_PERF__());
      }
    }, 250);
  }

  window.__MISSION36L_RENDER_PERF__ = () => ({
    marker: MARKER,
    maxPixelRatio: MAX_PIXEL_RATIO,
    layerUpdateIntervalMs: LAYER_UPDATE_INTERVAL_MS,
    hoverPickIntervalMs: HOVER_PICK_INTERVAL_MS,
    materialUpdateIntervalMs: MATERIAL_UPDATE_INTERVAL_MS,
    tileUpdateIntervalMs: TILE_UPDATE_INTERVAL_MS,
    shadowUpdateEveryFrames: SHADOW_UPDATE_EVERY_FRAMES,
    ...stats,
  });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, { once: true });
  else install();
})();
