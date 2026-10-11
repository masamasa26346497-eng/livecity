// Mission 36L: dev-only building click reliability guard.
//
// Why this exists:
// - CanonicalRuntime caches only currently visible building meshes, but the old cache key can stay
//   unchanged while tile visibility changes after pan/zoom. A visible building can then be absent
//   from the cached pick candidates until some unrelated tile-count change invalidates the cache.
// - On a busy main thread, the original click-intent timing thresholds can reject a real click even
//   when the pointer barely moved.
//
// This file does not alter the building dataset or selection semantics. It only refreshes the
// canonical pick cache immediately before a canvas click and relaxes timing-only rejection while
// retaining movement/camera-motion guards.
(() => {
  'use strict';

  const MARKER = '[Mission 36L PICK RELIABILITY]';
  const MAX_CLICK_HOLD_MS = 1600;
  const WHEEL_BLOCK_MS = 120;
  const EXTEND_CLICK_WINDOW_MS = 180;

  const stats = {
    installed: false,
    clickIntentTuned: false,
    cacheInvalidations: 0,
    captureClicks: 0,
    clickWindowsExtended: 0,
    errors: 0,
    originalMaxMs: null,
    originalWheelBlockMs: null,
  };

  function canonicalRuntimeBinding() {
    try { return (typeof CanonicalRuntime !== 'undefined') ? CanonicalRuntime : null; }
    catch (_) { return null; }
  }

  function clickIntentBinding() {
    try { return (typeof CLICK_INTENT !== 'undefined') ? CLICK_INTENT : null; }
    catch (_) { return null; }
  }

  function rendererCanvas() {
    try {
      if (typeof renderer !== 'undefined' && renderer?.domElement) return renderer.domElement;
    } catch (_) { /* fall through */ }
    return document.querySelector('canvas');
  }

  function tuneClickIntent() {
    const intent = clickIntentBinding();
    if (!intent) return false;
    if (!stats.clickIntentTuned) {
      stats.originalMaxMs = Number(intent.MAX_MS);
      stats.originalWheelBlockMs = Number(intent.WHEEL_BLOCK_MS);
    }
    intent.MAX_MS = Math.max(Number(intent.MAX_MS) || 0, MAX_CLICK_HOLD_MS);
    intent.WHEEL_BLOCK_MS = Math.min(Number(intent.WHEEL_BLOCK_MS) || WHEEL_BLOCK_MS, WHEEL_BLOCK_MS);
    stats.clickIntentTuned = true;
    return true;
  }

  function invalidateCanonicalPickCache() {
    const runtime = canonicalRuntimeBinding();
    if (!runtime || typeof runtime.invalidatePickCache !== 'function') return false;
    try {
      runtime.invalidatePickCache();
      stats.cacheInvalidations++;
      return true;
    } catch (err) {
      stats.errors++;
      console.warn(MARKER, 'pick-cache invalidation failed', err);
      return false;
    }
  }

  function extendValidClickWindowIfNeeded() {
    const intent = clickIntentBinding();
    if (!intent?.lastGesture?.isClick) return;
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    if (!Number.isFinite(Number(intent.allowClickUntil)) || now > Number(intent.allowClickUntil)) {
      intent.allowClickUntil = now + EXTEND_CLICK_WINDOW_MS;
      stats.clickWindowsExtended++;
    }
  }

  function onClickCapture(event) {
    const canvas = rendererCanvas();
    if (!canvas || event.target !== canvas) return;
    stats.captureClicks++;

    // Capture phase runs before the original canvas click handler. Rebuild candidate meshes from
    // the current tile visibility state exactly when a building pick is about to happen.
    invalidateCanonicalPickCache();

    // If a real click was already accepted on mouseup but the main thread delayed delivery of the
    // subsequent click event beyond the old 600ms window, keep that accepted gesture alive briefly.
    extendValidClickWindowIfNeeded();
  }

  function install() {
    if (stats.installed) return;
    tuneClickIntent();
    document.addEventListener('click', onClickCapture, true);

    // Pan/zoom can swap visible tiles without changing tile counts. Refresh once interaction ends so
    // hover/pick state after navigation does not keep a stale visible-mesh cache.
    window.addEventListener('mouseup', invalidateCanonicalPickCache, true);
    window.addEventListener('touchend', invalidateCanonicalPickCache, true);
    window.addEventListener('wheel', () => {
      window.clearTimeout(install._wheelTimer);
      install._wheelTimer = window.setTimeout(invalidateCanonicalPickCache, WHEEL_BLOCK_MS);
    }, { passive: true, capture: true });

    stats.installed = true;
    console.info(MARKER, 'installed');
  }

  window.__MISSION36L_BUILDING_PICK_RELIABILITY__ = () => ({ ...stats });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, { once: true });
  else install();
})();
