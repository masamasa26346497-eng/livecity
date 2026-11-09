// Mission 36I dev-only UI coordinator.
// Loaded only by tools/preview.js when serving osaka_3d_buildings.ward-ux-v1.html.
// Keeps facility/building detail cards mutually exclusive and makes the large QA tuning panel collapsible.
(() => {
  'use strict';

  const FACILITY_CARD_ID = 'facility-card';
  const BUILDING_CARD_ID = 'prop-card';
  const TUNING_PANEL_ID = 'canonical-runtime-status';
  const STORAGE_KEY = 'livecity.dev.tuning-collapsed.v1';
  const TOGGLE_ID = 'livecity-dev-tuning-toggle';

  let arbitrationQueued = false;
  let cardsObserverInstalled = false;
  let tuningToggleInstalled = false;

  function isVisible(el) {
    if (!el || el.hidden) return false;
    const style = getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
  }

  function cardHasPhoto(card) {
    if (!card) return false;
    return [...card.querySelectorAll('img')].some((img) => {
      const src = String(img.currentSrc || img.getAttribute('src') || '').trim();
      if (!src || src.startsWith('data:image/svg')) return false;
      if (img.naturalWidth > 1 || img.naturalHeight > 1) return true;
      const rect = img.getBoundingClientRect();
      return rect.width > 16 && rect.height > 16;
    });
  }

  function hideCard(card) {
    if (!card || !isVisible(card)) return;
    card.style.display = 'none';
  }

  function arbitrateCards() {
    arbitrationQueued = false;
    const facility = document.getElementById(FACILITY_CARD_ID);
    const building = document.getElementById(BUILDING_CARD_ID);
    if (!facility || !building || !isVisible(facility) || !isVisible(building)) return;

    const facilityHasPhoto = cardHasPhoto(facility);
    const buildingHasPhoto = cardHasPhoto(building);
    if (buildingHasPhoto && !facilityHasPhoto) hideCard(facility);
    else hideCard(building);
  }

  function queueCardArbitration() {
    if (arbitrationQueued) return;
    arbitrationQueued = true;
    requestAnimationFrame(arbitrateCards);
  }

  function observeCards() {
    if (cardsObserverInstalled) return true;
    const facility = document.getElementById(FACILITY_CARD_ID);
    const building = document.getElementById(BUILDING_CARD_ID);
    if (!facility || !building) return false;

    const observer = new MutationObserver(queueCardArbitration);
    const options = { attributes: true, childList: true, subtree: true, attributeFilter: ['style', 'class', 'src'] };
    observer.observe(facility, options);
    observer.observe(building, options);

    document.addEventListener('load', (event) => {
      const target = event.target;
      if (target instanceof HTMLImageElement && (facility.contains(target) || building.contains(target))) {
        queueCardArbitration();
      }
    }, true);

    cardsObserverInstalled = true;
    queueCardArbitration();
    return true;
  }

  function readCollapsedState() {
    try { return localStorage.getItem(STORAGE_KEY) === '1'; }
    catch { return false; }
  }

  function writeCollapsedState(collapsed) {
    try { localStorage.setItem(STORAGE_KEY, collapsed ? '1' : '0'); }
    catch { /* localStorage may be unavailable; UI still works for this session. */ }
  }

  function installTuningPanelToggle() {
    if (tuningToggleInstalled) return true;
    const panel = document.getElementById(TUNING_PANEL_ID);
    if (!panel) return false;
    if (document.getElementById(TOGGLE_ID)) {
      tuningToggleInstalled = true;
      return true;
    }

    const button = document.createElement('button');
    button.id = TOGGLE_ID;
    button.type = 'button';
    button.setAttribute('aria-controls', TUNING_PANEL_ID);
    button.style.cssText = [
      'position:fixed', 'right:12px', 'top:50%', 'transform:translateY(-50%)', 'z-index:99999',
      'padding:7px 10px', 'border-radius:8px', 'border:1px solid rgba(90,170,255,.42)',
      'background:rgba(8,14,26,.92)', 'color:#d9e8ff', 'font:11px ui-monospace,Menlo,Consolas,monospace',
      'cursor:pointer', 'box-shadow:0 4px 16px rgba(0,0,0,.28)'
    ].join(';');

    let collapsed = readCollapsedState();
    const render = () => {
      panel.style.display = collapsed ? 'none' : '';
      button.textContent = collapsed ? '調整を表示' : '調整を隠す';
      button.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      button.title = collapsed ? '開発用の調整パネルを表示' : '開発用の調整パネルを隠す';
    };

    button.addEventListener('click', () => {
      collapsed = !collapsed;
      writeCollapsedState(collapsed);
      render();
    });

    document.body.appendChild(button);
    tuningToggleInstalled = true;
    render();
    return true;
  }

  function bootstrap() {
    let tries = 0;
    const timer = setInterval(() => {
      tries++;
      const cardsReady = observeCards();
      const tuningReady = installTuningPanelToggle();
      if ((cardsReady && tuningReady) || tries >= 120) clearInterval(timer);
    }, 250);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bootstrap, { once: true });
  else bootstrap();
})();

// Mission 36K/36L dev-only facility runtime performance coordinator.
// Keeps all 40,585 source records, but only indexes newly loaded records and only rebuilds
// the visible facility layer from a bounded/cached nearby set.
(() => {
  'use strict';

  const MARKER = '[Mission 36L PERF] incremental facility coordinator';
  const CELL_METERS = 500;
  const MAX_RENDER_RADIUS_METERS = 3200;
  const MIN_RENDER_RADIUS_METERS = 1400;
  const DEFAULT_RENDER_CAP = 450;
  const CENTER_BUCKET_METERS = 250;

  const grid = new Map();
  const indexedIds = new Set();
  const recordsById = new Map();
  const stats = {
    indexPasses: 0,
    indexedRecords: 0,
    incrementalRecordsScanned: 0,
    fullRescanFallbacks: 0,
    spatialQueries: 0,
    candidateIds: 0,
    acceptedRecords: 0,
    countOnlyQueries: 0,
    layerRebuildsBounded: 0,
    renderQueryCacheHits: 0,
    renderQueryCacheMisses: 0,
  };

  let storePatched = false;
  let layerPatched = false;
  let indexedRecordCount = 0;
  let indexVersion = 0;
  let lastRenderKey = '';
  let lastRenderRecords = [];

  function cellCoord(value) {
    return Math.floor(Number(value) / CELL_METERS);
  }

  function cellKey(cx, cz) {
    return `${cx}:${cz}`;
  }

  function indexRecords(records) {
    stats.indexPasses++;
    let added = 0;
    for (const record of records || []) {
      if (!record || !record.id) continue;
      if (indexedIds.has(record.id)) {
        recordsById.set(record.id, record);
        continue;
      }
      const x = Number(record.localX);
      const z = Number(record.localZ);
      if (!Number.isFinite(x) || !Number.isFinite(z)) continue;
      const key = cellKey(cellCoord(x), cellCoord(z));
      let ids = grid.get(key);
      if (!ids) {
        ids = new Set();
        grid.set(key, ids);
      }
      ids.add(record.id);
      indexedIds.add(record.id);
      recordsById.set(record.id, record);
      stats.indexedRecords++;
      added++;
    }
    if (added) indexVersion++;
    return added;
  }

  function indexNewRecords(store) {
    const all = store.getAllRecords();
    if (!Array.isArray(all)) return;

    if (all.length < indexedRecordCount) {
      indexedRecordCount = 0;
      stats.fullRescanFallbacks++;
    }

    const delta = all.slice(indexedRecordCount);
    if (delta.length) {
      stats.incrementalRecordsScanned += delta.length;
      indexRecords(delta);
    }
    indexedRecordCount = all.length;
  }

  function queryNearby(store, x, z, radiusM, options = {}) {
    stats.spatialQueries++;
    const qx = Number(x);
    const qz = Number(z);
    const radius = Number(radiusM);
    const subcategories = Array.isArray(options.subcategories) ? options.subcategories : [];
    const subcategorySet = subcategories.length ? new Set(subcategories) : null;
    const limit = Number.isFinite(Number(options.limit)) ? Math.max(0, Number(options.limit)) : Infinity;
    const prioritizeMajor = !!options.prioritizeMajor;
    const countOnly = !!options.countOnly;
    const shouldSort = options.sort !== false;

    if (!Number.isFinite(qx) || !Number.isFinite(qz) || !Number.isFinite(radius) || radius < 0) return null;

    const radiusSq = radius * radius;
    const minCx = cellCoord(qx - radius);
    const maxCx = cellCoord(qx + radius);
    const minCz = cellCoord(qz - radius);
    const maxCz = cellCoord(qz + radius);
    const seen = new Set();
    const hits = [];
    let accepted = 0;

    for (let cx = minCx; cx <= maxCx; cx++) {
      for (let cz = minCz; cz <= maxCz; cz++) {
        const ids = grid.get(cellKey(cx, cz));
        if (!ids) continue;
        stats.candidateIds += ids.size;
        for (const id of ids) {
          if (seen.has(id)) continue;
          seen.add(id);
          const record = recordsById.get(id);
          if (!record) continue;
          if (subcategorySet && !subcategorySet.has(record.subcategory)) continue;
          const dx = Number(record.localX) - qx;
          const dz = Number(record.localZ) - qz;
          const d2 = dx * dx + dz * dz;
          if (!Number.isFinite(d2) || d2 > radiusSq) continue;
          accepted++;
          if (!countOnly) hits.push({ record, d2 });
        }
      }
    }

    stats.acceptedRecords += accepted;
    if (countOnly) {
      stats.countOnlyQueries++;
      return accepted;
    }

    if (shouldSort) {
      hits.sort((a, b) => (
        prioritizeMajor ? Number(!!b.record.majorFacility) - Number(!!a.record.majorFacility) : 0
      ) || a.d2 - b.d2);
    }

    const selected = Number.isFinite(limit) ? hits.slice(0, limit) : hits;
    return selected.map((hit) => ({
      record: hit.record,
      d2: hit.d2,
      distanceM: Math.sqrt(hit.d2),
    }));
  }

  function patchStore(store) {
    if (!store || storePatched || store.__mission36kSpatialPatched) return false;
    if (typeof store.getAllRecords !== 'function' || typeof store.loadWard !== 'function') return false;

    const initial = store.getAllRecords();
    if (Array.isArray(initial)) {
      stats.incrementalRecordsScanned += initial.length;
      indexRecords(initial);
      indexedRecordCount = initial.length;
    }

    const originalLoadWard = store.loadWard.bind(store);
    store.loadWard = async (...args) => {
      const result = await originalLoadWard(...args);
      indexNewRecords(store);
      return result;
    };

    if (typeof store.loadWards === 'function') {
      const originalLoadWards = store.loadWards.bind(store);
      store.loadWards = async (...args) => {
        const result = await originalLoadWards(...args);
        indexNewRecords(store);
        return result;
      };
    }

    const originalCountNearby = typeof store.countNearbyBySubcategory === 'function'
      ? store.countNearbyBySubcategory.bind(store) : null;
    store.countNearbyBySubcategory = (x, z, radiusM, subcategories) => {
      const count = queryNearby(store, x, z, radiusM, { subcategories, countOnly: true, sort: false });
      return Number.isFinite(count)
        ? count
        : (originalCountNearby ? originalCountNearby(x, z, radiusM, subcategories) : null);
    };

    store.queryNearbySpatial = (x, z, radiusM, options = {}) => {
      const result = queryNearby(store, x, z, radiusM, options);
      return Array.isArray(result) ? result : [];
    };

    store.getSpatialPerformanceDebug = () => ({
      marker: MARKER,
      cellMeters: CELL_METERS,
      maxRenderRadiusMeters: MAX_RENDER_RADIUS_METERS,
      defaultRenderCap: DEFAULT_RENDER_CAP,
      gridCells: grid.size,
      indexedIds: indexedIds.size,
      indexedRecordMap: recordsById.size,
      loadedRecords: store.getAllRecords().length,
      indexVersion,
      ...stats,
    });

    store.__mission36kSpatialPatched = true;
    storePatched = true;
    window.__MISSION36K_FACILITY_PERF__ = store.getSpatialPerformanceDebug;
    console.info(MARKER, 'FacilityDataStore incremental spatial index installed');
    return true;
  }

  function getFacilityLayerBinding() {
    try { return (typeof FacilityLayer !== 'undefined') ? FacilityLayer : null; }
    catch (_) { return null; }
  }

  function getRenderCenter() {
    try {
      if (typeof cs !== 'undefined' && Number.isFinite(cs.tx) && Number.isFinite(cs.tz)) {
        return { x: cs.tx, z: cs.tz };
      }
    } catch (_) { /* fall through */ }
    return { x: 0, z: 0 };
  }

  function getCameraRadius() {
    try {
      if (typeof cs !== 'undefined' && Number.isFinite(Number(cs.r))) return Number(cs.r);
    } catch (_) { /* fall through */ }
    return null;
  }

  function getRenderRadius(perf) {
    const configured = Number(perf && perf.renderRadiusMeters);
    const configuredRadius = Number.isFinite(configured) && configured > 0
      ? configured
      : MAX_RENDER_RADIUS_METERS;
    const cameraRadius = getCameraRadius();
    const dynamicRadius = Number.isFinite(cameraRadius)
      ? Math.min(MAX_RENDER_RADIUS_METERS, Math.max(MIN_RENDER_RADIUS_METERS, cameraRadius * 0.12))
      : MAX_RENDER_RADIUS_METERS;
    return Math.min(configuredRadius, dynamicRadius, MAX_RENDER_RADIUS_METERS);
  }

  function getRenderCap(perf) {
    const configured = Number(perf && perf.maxRenderedFacilities);
    const requested = Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_RENDER_CAP;
    return Math.max(100, Math.min(DEFAULT_RENDER_CAP, requested));
  }

  function renderKey(center, radius, cap) {
    const bx = Math.round(center.x / CENTER_BUCKET_METERS);
    const bz = Math.round(center.z / CENTER_BUCKET_METERS);
    return `${bx}:${bz}:${Math.round(radius / 100)}:${cap}:${indexVersion}`;
  }

  function nearbyRecordsForRender(store, center, radius, cap) {
    const key = renderKey(center, radius, cap);
    if (key === lastRenderKey) {
      stats.renderQueryCacheHits++;
      return lastRenderRecords;
    }

    stats.renderQueryCacheMisses++;
    const nearby = queryNearby(store, center.x, center.z, radius, {
      limit: cap,
      prioritizeMajor: true,
      sort: true,
    });
    if (!Array.isArray(nearby)) return null;
    lastRenderKey = key;
    lastRenderRecords = nearby.map((hit) => hit.record);
    return lastRenderRecords;
  }

  function patchFacilityLayer(store) {
    if (!store || layerPatched) return false;
    const layer = getFacilityLayerBinding();
    if (!layer || typeof layer.rebuildIfReady !== 'function') return false;
    if (layer.__mission36kSpatialPatched) {
      layerPatched = true;
      return true;
    }

    const originalRebuild = layer.rebuildIfReady.bind(layer);
    layer.rebuildIfReady = (force = false) => {
      const perf = (typeof window.__FACILITY_LAYER_PERF__ === 'function')
        ? window.__FACILITY_LAYER_PERF__() : null;
      const radius = getRenderRadius(perf);
      const cap = getRenderCap(perf);
      const center = getRenderCenter();
      const nearbyRecords = nearbyRecordsForRender(store, center, radius, cap);
      if (!nearbyRecords) return originalRebuild(force);

      const originalGetAllRecords = store.getAllRecords;
      store.getAllRecords = () => nearbyRecords;
      try {
        stats.layerRebuildsBounded++;
        return originalRebuild(force);
      } finally {
        store.getAllRecords = originalGetAllRecords;
      }
    };

    layer.__mission36kSpatialPatched = true;
    layerPatched = true;
    console.info(MARKER, 'FacilityLayer cached bounded rebuild installed');
    return true;
  }

  function install() {
    let tries = 0;
    const timer = setInterval(() => {
      tries++;
      const store = window.__LIVE_CITY_FACILITY_DATA_STORE__;
      if (store) patchStore(store);
      if (storePatched) patchFacilityLayer(store);
      if ((storePatched && layerPatched) || tries >= 240) clearInterval(timer);
    }, 250);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, { once: true });
  else install();
})();
