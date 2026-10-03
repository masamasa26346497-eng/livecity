// Mission 36L dev-only GPU/render budget guard.
// Keeps CSS layout unchanged while avoiding excessive WebGL back-buffer resolution on HiDPI displays.
(() => {
  'use strict';

  const MARKER = '[Mission 36L PERF] render budget';
  const MAX_PIXEL_RATIO = 1.25;
  const stats = {
    installed: false,
    applied: false,
    beforePixelRatio: null,
    afterPixelRatio: null,
  };

  function getRendererBinding() {
    try { return (typeof renderer !== 'undefined') ? renderer : null; }
    catch (_) { return null; }
  }

  function applyBudget() {
    const r = getRendererBinding();
    if (!r || typeof r.getPixelRatio !== 'function' || typeof r.setPixelRatio !== 'function') return false;

    const before = Number(r.getPixelRatio()) || 1;
    const target = Math.min(Number(window.devicePixelRatio) || 1, MAX_PIXEL_RATIO);
    stats.installed = true;
    stats.beforePixelRatio = before;

    if (before > target + 0.01) {
      const canvas = r.domElement;
      const rect = canvas?.getBoundingClientRect?.();
      r.setPixelRatio(target);
      if (rect && rect.width > 0 && rect.height > 0 && typeof r.setSize === 'function') {
        r.setSize(Math.round(rect.width), Math.round(rect.height), false);
      }
      stats.applied = true;
    }

    stats.afterPixelRatio = Number(r.getPixelRatio()) || target;
    console.info(MARKER, { ...stats, maxPixelRatio: MAX_PIXEL_RATIO });
    return true;
  }

  function install() {
    let tries = 0;
    const timer = setInterval(() => {
      tries++;
      if (applyBudget() || tries >= 120) clearInterval(timer);
    }, 250);
  }

  window.__MISSION36L_RENDER_PERF__ = () => ({
    marker: MARKER,
    maxPixelRatio: MAX_PIXEL_RATIO,
    ...stats,
  });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, { once: true });
  else install();
})();
