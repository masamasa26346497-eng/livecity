import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEV = path.join(ROOT, 'public', 'osaka_3d_buildings.ward-ux-v1.html');
const PROTECTED = [
  path.join(ROOT, 'public', 'osaka_3d_buildings.html'),
  path.join(ROOT, 'public', 'osaka_3d_buildings.fullward-v3.html'),
];
const MARKER = '[Mission 36J LAZY] 24-ward facility lazy loading';

const protectedBefore = new Map(PROTECTED.map((p) => [p, fs.readFileSync(p, 'utf8')]));
let html = fs.readFileSync(DEV, 'utf8');

if (html.includes(MARKER)) {
  console.log('[36J LAZY] already applied');
  process.exit(0);
}

const storeStart = html.indexOf('const FacilityDataStore = (function () {');
if (storeStart < 0) throw new Error('FacilityDataStore start not found');
const storeEnd = html.indexOf('\n})();', storeStart);
if (storeEnd < 0) throw new Error('FacilityDataStore end not found');

const store = `const FacilityDataStore = (function () {
  // ${MARKER}
  // 大阪市40,585件を一括fetchせず、24区shardを選択区ごとに追加読込する。
  // 読み込んだ区はキャッシュし、施設スプライト自体はFacilityLayer側で上限描画する。
  let state = 'loading';
  let allRecords = [];
  let recordsById = new Map();
  let metadata = null;
  let manifest = null;
  let baseLoadPromise = null;
  const loadedWardIds = new Set();
  const wardLoadPromises = new Map();
  const readyCallbacks = [];

  function notifyReady() {
    if (state !== 'ready') return;
    while (readyCallbacks.length) {
      const cb = readyCallbacks.shift();
      try { cb(); } catch (e) { console.warn('[FacilityDataStore] onReady callback failed:', e); }
    }
  }

  async function ensureBaseLoaded() {
    if (manifest) return true;
    if (baseLoadPromise) return baseLoadPromise;
    const base = \`\${FACILITY_CONFIG.basePath}/\${FACILITY_CONFIG.areaId}/facilities\`;
    baseLoadPromise = Promise.all([
      fetch(\`\${base}/ward-manifest.json\`),
      fetch(\`\${base}/metadata.json\`).catch(() => null),
    ]).then(async ([manifestRes, metaRes]) => {
      if (!manifestRes || !manifestRes.ok) {
        state = 'no-data';
        console.warn('[FacilityDataStore] ward-manifest.json not available');
        return false;
      }
      manifest = await manifestRes.json();
      if (!manifest || !Array.isArray(manifest.wards) || !manifest.wards.length) {
        state = 'no-data';
        console.warn('[FacilityDataStore] ward manifest is empty');
        return false;
      }
      if (metaRes && metaRes.ok) {
        try { metadata = await metaRes.json(); } catch (e) { metadata = null; }
      }
      return true;
    }).catch((e) => {
      state = 'error';
      console.error('[FacilityDataStore] base load failed:', e);
      return false;
    });
    return baseLoadPromise;
  }

  function resolveWardId(wardId) {
    const raw = String(wardId || '').trim();
    if (!raw) return null;
    if (manifest && manifest.wards.some((w) => w.wardId === raw)) return raw;
    const def = (typeof WardModeManager !== 'undefined' && Array.isArray(WardModeManager.WARD_DEFS))
      ? WardModeManager.WARD_DEFS.find((w) => w.id === raw || w.code === raw || w.datasetId === raw)
      : null;
    if (def && manifest && manifest.wards.some((w) => w.wardId === def.id)) return def.id;
    return raw.replace(/^ward-/, '').replace(/^osaka-/, '');
  }

  function normalizeRecords(doc) {
    if (Array.isArray(doc)) return doc;
    if (doc && Array.isArray(doc.records)) return doc.records;
    if (doc && Array.isArray(doc.facilities)) return doc.facilities;
    return [];
  }

  function mergeRecords(records) {
    let added = 0;
    for (const record of records) {
      if (!record || !record.id) continue;
      const prior = recordsById.get(record.id);
      if (!prior) {
        allRecords.push(record);
        added++;
      } else {
        const i = allRecords.indexOf(prior);
        if (i >= 0) allRecords[i] = record;
      }
      recordsById.set(record.id, record);
    }
    return added;
  }

  async function loadWard(wardId) {
    const baseReady = await ensureBaseLoaded();
    if (!baseReady) return { ok: false, wardId: null, added: 0, totalLoaded: allRecords.length };
    const resolved = resolveWardId(wardId);
    const entry = manifest.wards.find((w) => w.wardId === resolved);
    if (!entry) {
      console.warn('[FacilityDataStore] unknown ward:', wardId);
      return { ok: false, wardId: resolved, added: 0, totalLoaded: allRecords.length };
    }
    if (loadedWardIds.has(resolved)) {
      return { ok: true, cached: true, wardId: resolved, added: 0, totalLoaded: allRecords.length };
    }
    if (wardLoadPromises.has(resolved)) return wardLoadPromises.get(resolved);

    const base = \`\${FACILITY_CONFIG.basePath}/\${FACILITY_CONFIG.areaId}/facilities\`;
    const p = fetch(\`\${base}/\${entry.url}\`).then(async (res) => {
      if (!res.ok) throw new Error(\`HTTP \${res.status} for \${entry.url}\`);
      const doc = await res.json();
      const records = normalizeRecords(doc);
      const added = mergeRecords(records);
      loadedWardIds.add(resolved);
      state = 'ready';
      notifyReady();
      console.log('[FacilityDataStore] ward loaded:', resolved, 'records=', records.length, 'added=', added, 'total=', allRecords.length);
      return { ok: true, cached: false, wardId: resolved, added, recordCount: records.length, totalLoaded: allRecords.length };
    }).catch((e) => {
      console.error('[FacilityDataStore] ward load failed:', resolved, e);
      if (!allRecords.length) state = 'error';
      throw e;
    }).finally(() => wardLoadPromises.delete(resolved));
    wardLoadPromises.set(resolved, p);
    return p;
  }

  async function load() {
    state = 'loading';
    const ok = await ensureBaseLoaded();
    if (!ok) return false;
    const current = (typeof WardModeManager !== 'undefined' && WardModeManager.currentWardId)
      ? WardModeManager.currentWardId : 'sumiyoshi';
    await loadWard(current);
    return state === 'ready';
  }

  async function reload() {
    state = 'loading';
    allRecords = [];
    recordsById = new Map();
    metadata = null;
    manifest = null;
    baseLoadPromise = null;
    loadedWardIds.clear();
    wardLoadPromises.clear();
    return load();
  }

  function nearbyRecords(x, z, subcategories, radiusM = Infinity) {
    const cats = Array.isArray(subcategories) ? subcategories : [];
    const maxR = Number.isFinite(Number(radiusM)) ? Number(radiusM) : Infinity;
    const out = [];
    for (const r of allRecords) {
      if (cats.length && !cats.includes(r.subcategory)) continue;
      const dx = Number(r.localX) - Number(x);
      const dz = Number(r.localZ) - Number(z);
      const d = Math.hypot(dx, dz);
      if (!Number.isFinite(d) || d > maxR) continue;
      out.push({ record: r, distanceM: d });
    }
    out.sort((a, b) => a.distanceM - b.distanceM);
    return out;
  }

  // 従来APIを維持する。既存UI/生活利便性/検索/CityLabel連携を壊さない。
  const api = {
    load,
    reload,
    loadWard,
    async loadWards(ids) { return Promise.all((ids || []).map((id) => loadWard(id))); },
    getState() { return state; },
    getMetadata() { return metadata; },
    getManifest() { return manifest; },
    getLoadedWardIds() { return Array.from(loadedWardIds); },
    getAllRecords() { return state === 'ready' ? allRecords : []; },
    getById(id) { return recordsById.get(id) || null; },
    onReady(cb) {
      if (typeof cb !== 'function') return;
      if (state === 'ready') cb(); else readyCallbacks.push(cb);
    },
    countNearbyBySubcategory(x, z, radiusM, subcategories) {
      if (state !== 'ready') return null;
      return nearbyRecords(x, z, subcategories, radiusM).length;
    },
    nearestBySubcategory(x, z, subcategories) {
      if (state !== 'ready') return null;
      const hit = nearbyRecords(x, z, subcategories, Infinity)[0];
      if (!hit) return null;
      return { ...hit.record, distanceM: hit.distanceM, distanceMode: 'straight-line' };
    },
  };

  // 現在区だけを最初に読み、以降はWardModeManager.switchWardに追従する。
  Promise.resolve().then(() => load()).catch((e) => console.error('[FacilityDataStore] initial lazy load failed:', e));
  return api;
})();`;

html = html.slice(0, storeStart) + store + html.slice(storeEnd + '\n})();'.length);

// 区切替の内部経路（auto switchを含む）にも追従する。setTimeoutで後方宣言のStore/LayerのTDZを回避。
const switchNeedle = `  function switchWard(wardId) {\n    const def = WARD_DEFS.find((w) => w.id === wardId);\n    if (!def) return false;`;
if (!html.includes(switchNeedle)) throw new Error('WardModeManager switchWard anchor not found');
const switchReplacement = `  function switchWard(wardId) {\n    const def = WARD_DEFS.find((w) => w.id === wardId);\n    if (!def) return false;\n    // ${MARKER}: 建物区切替と同じ区の施設shardを非同期で追加読込する。\n    if (typeof window !== 'undefined') setTimeout(() => {\n      const store = window.__LIVE_CITY_FACILITY_DATA_STORE__;\n      if (!store || typeof store.loadWard !== 'function') return;\n      store.loadWard(def.id).then((result) => {\n        if (result && result.added > 0 && typeof FacilityLayer !== 'undefined' && FacilityLayer.rebuildIfReady) {\n          FacilityLayer.rebuildIfReady(true);\n        }\n        if (typeof updateFacilityPanelStatus === 'function') updateFacilityPanelStatus();\n      }).catch((e) => console.warn('[FacilityDataStore] switchWard lazy load failed:', def.id, e));\n    }, 0);`;
html = html.replace(switchNeedle, switchReplacement);

// 既存rebuildIfReadyを force 対応にし、追加区ロード後に古いsprite/materialを安全に破棄して再構築する。
const rebuildRe = /    rebuildIfReady\(\) \{\s*if \(!built && FacilityDataStore\.getState\(\) === 'ready'\) \{\s*if \(group\) scene\.remove\(group\);\s*build\(\);\s*if \(visible\) scene\.add\(group\);\s*\}\s*\}/m;
if (!rebuildRe.test(html)) throw new Error('FacilityLayer rebuildIfReady anchor not found');
html = html.replace(rebuildRe, `    rebuildIfReady(force = false) {\n      if (FacilityDataStore.getState() !== 'ready') return false;\n      if (built && !force) return false;\n      if (group) {\n        scene.remove(group);\n        for (const s of sprites) {\n          if (s.sprite && s.sprite.material) {\n            if (s.sprite.material.map) s.sprite.material.map.dispose();\n            s.sprite.material.dispose();\n          }\n        }\n      }\n      group = null; sprites = []; built = false;\n      build();\n      if (visible && group) scene.add(group);\n      update();\n      return true;\n    }`);

// Storeを安全なwindow参照へ公開（WardModeManagerはStoreより前に宣言されるため直接TDZ参照しない）。
const storeClose = html.indexOf('\n})();', storeStart) + '\n})();'.length;
html = html.slice(0, storeClose) + `\nif (typeof window !== 'undefined') {\n  window.__LIVE_CITY_FACILITY_DATA_STORE__ = FacilityDataStore;\n  window.__FACILITY_LAZY_DEBUG__ = () => {\n    const m = FacilityDataStore.getManifest();\n    return {\n      sourceRecordCount: m && m.sourceRecordCount || null,\n      manifestWardCount: m && m.wardCount || 0,\n      loadedWardIds: FacilityDataStore.getLoadedWardIds(),\n      loadedRecordCount: FacilityDataStore.getAllRecords().length,\n      layer: (typeof window.__FACILITY_LAYER_PERF__ === 'function') ? window.__FACILITY_LAYER_PERF__() : null,\n    };\n  };\n}` + html.slice(storeClose);

// 左パネルに「現在読込件数 / 大阪市全件数」を表示して、部分ロードを誤解しないようにする。
const statusNeedle = `  else if (state === 'ready') statusEl.textContent = \`\${FacilityDataStore.getAllRecords().length}件の施設を表示中\`;`;
if (html.includes(statusNeedle)) {
  html = html.replace(statusNeedle, `  else if (state === 'ready') {\n    const manifest = FacilityDataStore.getManifest ? FacilityDataStore.getManifest() : null;\n    const loaded = FacilityDataStore.getAllRecords().length;\n    const total = manifest && manifest.sourceRecordCount;\n    const wards = FacilityDataStore.getLoadedWardIds ? FacilityDataStore.getLoadedWardIds().length : 0;\n    statusEl.textContent = total ? \`\${loaded.toLocaleString()}件読込（\${wards}/24区） / 大阪市\${Number(total).toLocaleString()}件\` : \`\${loaded.toLocaleString()}件の施設を表示中\`;\n  }`);
}

// Safety assertions.
if (!html.includes(MARKER)) throw new Error('lazy marker missing');
if (!html.includes('ward-manifest.json')) throw new Error('ward manifest wiring missing');
if (!html.includes('loadWard,')) throw new Error('loadWard API missing');
if (!html.includes('__FACILITY_LAZY_DEBUG__')) throw new Error('lazy debug hook missing');
if (!html.includes('rebuildIfReady(force = false)')) throw new Error('force rebuild missing');
const newStoreEnd = html.indexOf('\n})();', storeStart);
const newStoreBlock = html.slice(storeStart, newStoreEnd);
if (newStoreBlock.includes('facilities-startup.json')) throw new Error('startup subset fetch still present in DataStore');
if (newStoreBlock.includes('/facilities.json')) throw new Error('citywide monolith fetch still present in DataStore');
if (!html.includes("areaId: 'osaka-city'")) throw new Error('osaka-city facility config lost');

fs.writeFileSync(DEV, html, 'utf8');
for (const [p, before] of protectedBefore) {
  if (fs.readFileSync(p, 'utf8') !== before) throw new Error('protected production HTML changed: ' + path.basename(p));
}
console.log('[36J LAZY] patched dev UI: 24-ward lazy facility loading enabled');
