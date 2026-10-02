// Mission 36K: dev-only building click / facility picking performance gate.
//
// Goals:
// - Keep the full 40,585-facility source and ward shards unchanged.
// - Preserve the existing FacilityLayer exact raycast semantics when the pointer is actually
//   close to a facility marker.
// - Skip the expensive visible-sprite array build + raycast for ordinary building clicks.
//
// This script is injected only by tools/preview.js after livecity-dev-ui-coordinator.js.
(() => {
  'use strict';

  const MARKER = '[Mission 36K CLICK] facility pick gate';
  const FACILITY_Y = 26;
  const PICK_RADIUS_PX = 42;
  const MIN_WORLD_QUERY_RADIUS_M = 600;
  const MAX_WORLD_QUERY_RADIUS_M = 2500;
  const CAMERA_RADIUS_FACTOR = 0.08;

  const stats = {
    installed: false,
    pickCalls: 0,
    fastMisses: 0,
    spatialCandidates: 0,
    screenCandidates: 0,
    exactRaycasts: 0,
    fallbacks: 0,
    lastCandidateCount: 0,
    lastScreenCandidateCount: 0,
  };

  let gateInstalled = false;
  let gateRaycaster = null;
  let gateMouse = null;
  let facilityPlane = null;
  let facilityPoint = null;
  let projectPoint = null;

  function getFacilityLayerBinding() {
    try {
      return (typeof FacilityLayer !== 'undefined') ? FacilityLayer : null;
    } catch (_) {
      return null;
    }
  }

  function getRendererSize() {
    try {
      if (typeof renderer !== 'undefined' && renderer && renderer.domElement) {
        const el = renderer.domElement;
        return {
          width: Math.max(1, Number(el.clientWidth || el.width) || window.innerWidth || 1),
          height: Math.max(1, Number(el.clientHeight || el.height) || window.innerHeight || 1),
        };
      }
    } catch (_) { /* fall through */ }
    return {
      width: Math.max(1, Number(window.innerWidth) || 1),
      height: Math.max(1, Number(window.innerHeight) || 1),
    };
  }

  function getWorldQueryRadius() {
    try {
      if (typeof cs !== 'undefined' && Number.isFinite(Number(cs.r))) {
        return Math.min(
          MAX_WORLD_QUERY_RADIUS_M,
          Math.max(MIN_WORLD_QUERY_RADIUS_M, Number(cs.r) * CAMERA_RADIUS_FACTOR),
        );
      }
    } catch (_) { /* fall through */ }
    return MIN_WORLD_QUERY_RADIUS_M;
  }

  function ensureMathObjects() {
    if (gateRaycaster) return true;
    try {
      if (typeof THREE === 'undefined') return false;
      gateRaycaster = new THREE.Raycaster();
      gateMouse = new THREE.Vector2();
      facilityPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -FACILITY_Y);
      facilityPoint = new THREE.Vector3();
      projectPoint = new THREE.Vector3();
      return true;
    } catch (_) {
      return false;
    }
  }

  function screenCandidateCount(records, mouseX, mouseY, camera) {
    if (!ensureMathObjects()) return null;
    const size = getRendererSize();
    const thresholdX = (PICK_RADIUS_PX * 2) / size.width;
    const thresholdY = (PICK_RADIUS_PX * 2) / size.height;
    let count = 0;

    for (const record of records) {
      const x = Number(record && record.localX);
      const z = Number(record && record.localZ);
      if (!Number.isFinite(x) || !Number.isFinite(z)) continue;
      projectPoint.set(x, FACILITY_Y, z).project(camera);
      if (!Number.isFinite(projectPoint.x) || !Number.isFinite(projectPoint.y) || !Number.isFinite(projectPoint.z)) continue;
      if (projectPoint.z < -1 || projectPoint.z > 1) continue;
      const nx = (projectPoint.x - mouseX) / thresholdX;
      const ny = (projectPoint.y - mouseY) / thresholdY;
      if ((nx * nx + ny * ny) <= 1) count++;
    }
    return count;
  }

  function shouldRunExactFacilityPick(store, mouseX, mouseY, camera) {
    if (!store || typeof store.queryNearbySpatial !== 'function' || !camera || !ensureMathObjects()) return null;

    gateMouse.set(mouseX, mouseY);
    gateRaycaster.setFromCamera(gateMouse, camera);
    const hit = gateRaycaster.ray.intersectPlane(facilityPlane, facilityPoint);
    if (!hit) return false;

    const nearby = store.queryNearbySpatial(
      facilityPoint.x,
      facilityPoint.z,
      getWorldQueryRadius(),
      { prioritizeMajor: true },
    );
    if (!Array.isArray(nearby)) return null;

    const records = nearby.map((entry) => entry && entry.record).filter(Boolean);
    stats.spatialCandidates += records.length;
    stats.lastCandidateCount = records.length;
    if (!records.length) {
      stats.lastScreenCandidateCount = 0;
      return false;
    }

    const count = screenCandidateCount(records, mouseX, mouseY, camera);
    if (count == null) return null;
    stats.screenCandidates += count;
    stats.lastScreenCandidateCount = count;
    return count > 0;
  }

  function installGate(store) {
    if (gateInstalled) return true;
    const layer = getFacilityLayerBinding();
    if (!store || !layer || typeof layer.pickHit !== 'function') return false;
    if (layer.__mission36kClickGatePatched) {
      gateInstalled = true;
      stats.installed = true;
      return true;
    }

    const originalPickHit = layer.pickHit.bind(layer);
    layer.pickHit = (mouseX, mouseY, camera) => {
      stats.pickCalls++;
      let exactNeeded = null;
      try {
        exactNeeded = shouldRunExactFacilityPick(store, mouseX, mouseY, camera);
      } catch (err) {
        console.warn(MARKER, 'gate failed; falling back to exact pick:', err);
        exactNeeded = null;
      }

      if (exactNeeded === false) {
        stats.fastMisses++;
        return null;
      }

      if (exactNeeded === null) stats.fallbacks++;
      stats.exactRaycasts++;
      return originalPickHit(mouseX, mouseY, camera);
    };

    layer.__mission36kClickGatePatched = true;
    gateInstalled = true;
    stats.installed = true;
    console.info(MARKER, 'installed');
    return true;
  }

  function debugSnapshot() {
    const total = stats.pickCalls || 0;
    return {
      marker: MARKER,
      facilityY: FACILITY_Y,
      pickRadiusPx: PICK_RADIUS_PX,
      fastMissRate: total ? stats.fastMisses / total : 0,
      ...stats,
    };
  }

  function install() {
    let tries = 0;
    const timer = setInterval(() => {
      tries++;
      const store = window.__LIVE_CITY_FACILITY_DATA_STORE__;
      if (store && typeof store.queryNearbySpatial === 'function' && installGate(store)) {
        clearInterval(timer);
        return;
      }
      if (tries >= 240) {
        clearInterval(timer);
        console.warn(MARKER, 'not installed within timeout');
      }
    }, 250);
  }

  window.__MISSION36K_BUILDING_CLICK_PERF__ = debugSnapshot;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, { once: true });
  else install();
})();
