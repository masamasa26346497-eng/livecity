// Mission 36L dev-only building photo bridge.
// Loaded by tools/preview.js only for osaka_3d_buildings.ward-ux-v1.html.
//
// Primary route: prebuilt building-google-place-index.json (exact OSM source-id chain).
// Fallback route: conservative unique exact-name bridge built in memory from the public runtime
// building-facility index + VERIFIED Google Places mapping. The fallback never persists data.
// Google photo media URLs/resource names are resolved on demand and kept in memory only.
(() => {
  'use strict';

  const EXACT_INDEX_URL = 'map-data/osaka-city/derived/building-google-place-index.json';
  const BUILDING_RUNTIME_URL = 'map-data/osaka-city/derived/building-facility-index.json';
  const PLACES_MAPPING_URL = 'map-data/osaka-city/derived/google-places-pilot-mapping.json';
  const HOST_ID = 'pc-google-photo-section-36l';
  const MARKER = '[Mission 36L BUILDING PHOTO]';
  const MAX_PHOTOS = 3;
  // Paid Places requests must not be triggered by a building click.
  // There is currently no authenticated one-time owner approval and shared budget
  // enforcement in the browser. Keep this hard-disabled even when an API key exists.
  const PAID_GOOGLE_PHOTOS_ENABLED = false;
  const FIELD_MASK = 'id,displayName,googleMapsUri,photos';

  const placeCache = new Map();
  const mediaCache = new Map();
  let bridgePromise = null;
  let patched = false;
  let renderToken = 0;
  const stats = {
    bridgeMode: 'uninitialized',
    linkedBuildings: 0,
    cardCalls: 0,
    noLink: 0,
    noKey: 0,
    placeRequests: 0,
    mediaRequests: 0,
    photosRendered: 0,
    errors: 0,
  };

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));

  const norm = (s) => String(s || '')
    .normalize('NFKC')
    .replace(/[\s　・･]/g, '')
    .toLowerCase();

  function apiKey() {
    return String(window.LIVECITY_CONFIG?.googlePlacesApiKey || '').trim();
  }

  async function fetchJson(url, options) {
    const response = await fetch(url, options);
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return response.json();
  }

  async function tryExactIndex() {
    try {
      const response = await fetch(EXACT_INDEX_URL, { cache: 'no-store' });
      if (!response.ok) return null;
      const doc = await response.json();
      const map = new Map();
      for (const [buildingId, rec] of Object.entries(doc?.byBuildingId || {})) {
        if (!rec?.googlePlaceId || rec?.placeMatchConfidence !== 'VERIFIED') continue;
        map.set(buildingId, rec);
      }
      if (!map.size) return null;
      stats.bridgeMode = 'exact-osm-source-id-chain';
      stats.linkedBuildings = map.size;
      return map;
    } catch (_) {
      return null;
    }
  }

  function conservativeNameCandidate(building) {
    if (!building?.buildingId) return null;
    if (building.buildingName && building.confidence === 'high') return building.buildingName;
    if (building.primaryFacilityName && Number(building.n) === 1) return building.primaryFacilityName;
    return null;
  }

  async function buildFallbackBridge() {
    const [buildingDoc, placesDoc] = await Promise.all([
      fetchJson(BUILDING_RUNTIME_URL, { cache: 'no-store' }),
      fetchJson(PLACES_MAPPING_URL, { cache: 'no-store' }),
    ]);

    const buildings = Array.isArray(buildingDoc?.buildings) ? buildingDoc.buildings : [];
    const verified = (Array.isArray(placesDoc?.entries) ? placesDoc.entries : [])
      .filter((e) => e?.matchConfidence === 'VERIFIED' && e?.facilityId && e?.googlePlaceId && e?.name);

    const placeByName = new Map();
    const duplicatedPlaceNames = new Set();
    for (const entry of verified) {
      const key = norm(entry.name);
      if (!key) continue;
      if (placeByName.has(key)) duplicatedPlaceNames.add(key);
      else placeByName.set(key, entry);
    }
    for (const key of duplicatedPlaceNames) placeByName.delete(key);

    const buildingNameCounts = new Map();
    const candidateNameByBuilding = new Map();
    for (const building of buildings) {
      const name = conservativeNameCandidate(building);
      const key = norm(name);
      if (!key) continue;
      candidateNameByBuilding.set(building.buildingId, { key, name });
      buildingNameCounts.set(key, (buildingNameCounts.get(key) || 0) + 1);
    }

    const map = new Map();
    for (const building of buildings) {
      const candidate = candidateNameByBuilding.get(building.buildingId);
      if (!candidate || buildingNameCounts.get(candidate.key) !== 1) continue;
      const place = placeByName.get(candidate.key);
      if (!place) continue;
      map.set(building.buildingId, {
        buildingId: building.buildingId,
        buildingName: candidate.name,
        facilityId: place.facilityId,
        googlePlaceId: place.googlePlaceId,
        placeMatchConfidence: 'VERIFIED',
        linkMethod: 'unique-exact-name-runtime-fallback',
      });
    }

    stats.bridgeMode = 'unique-exact-name-runtime-fallback';
    stats.linkedBuildings = map.size;
    return map;
  }

  function loadBridge() {
    if (bridgePromise) return bridgePromise;
    bridgePromise = (async () => (await tryExactIndex()) || new Map())()
      .catch((err) => {
        stats.errors++;
        stats.bridgeMode = 'failed';
        console.warn(MARKER, 'bridge load failed', err);
        return new Map();
      });
    return bridgePromise;
  }

  function canonicalIdFromDetail(detail) {
    if (!detail) return null;
    for (const key of ['canonicalId', 'buildingId', 'id']) {
      if (typeof detail[key] === 'string' && detail[key]) return detail[key];
    }
    if (detail.d && typeof detail.d === 'object') return canonicalIdFromDetail(detail.d);
    return null;
  }

  function ensureHost() {
    const card = document.getElementById('prop-card');
    if (!card) return null;
    let host = document.getElementById(HOST_ID);
    if (host) return host;
    host = document.createElement('section');
    host.id = HOST_ID;
    host.style.cssText = 'display:none;margin-top:10px;padding-top:10px;border-top:1px solid rgba(130,170,220,.24)';
    const wikimedia = document.getElementById('pc-photo-section');
    if (wikimedia?.parentNode === card) wikimedia.insertAdjacentElement('afterend', host);
    else card.appendChild(host);
    return host;
  }

  function hideHost() {
    const host = document.getElementById(HOST_ID);
    if (!host) return;
    host.style.display = 'none';
    host.innerHTML = '';
  }

  async function getPlace(placeId, key) {
    if (placeCache.has(placeId)) return placeCache.get(placeId);
    stats.placeRequests++;
    const promise = fetchJson(`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`, {
      headers: { 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': FIELD_MASK },
    });
    placeCache.set(placeId, promise);
    try { return await promise; }
    catch (err) { placeCache.delete(placeId); throw err; }
  }

  async function getMediaUrl(photoName, key) {
    if (!photoName) return null;
    if (mediaCache.has(photoName)) return mediaCache.get(photoName);
    stats.mediaRequests++;
    const promise = fetchJson(
      `https://places.googleapis.com/v1/${photoName}/media?maxWidthPx=720&maxHeightPx=480&skipHttpRedirect=true`,
      { headers: { 'X-Goog-Api-Key': key } },
    ).then((j) => j?.photoUri || null);
    mediaCache.set(photoName, promise);
    try { return await promise; }
    catch (err) { mediaCache.delete(photoName); throw err; }
  }

  function authorHtml(photo) {
    const attrs = Array.isArray(photo?.authorAttributions) ? photo.authorAttributions : [];
    if (!attrs.length) return '<span>Google Places</span>';
    return attrs.slice(0, 2).map((a) => {
      const name = esc(a?.displayName || '投稿者');
      const uri = String(a?.uri || '');
      return uri ? `<a href="${esc(uri)}" target="_blank" rel="noopener noreferrer">${name}</a>` : name;
    }).join(' / ');
  }

  async function renderForBuilding(buildingId) {
    const token = ++renderToken;
    hideHost();
    if (!buildingId) return;

    const bridge = await loadBridge();
    if (token !== renderToken) return;
    const link = bridge.get(buildingId);
    if (!link) {
      stats.noLink++;
      window.dispatchEvent(new CustomEvent('livecity:verified-google-place', { detail: {} }));
      return;
    }
    window.dispatchEvent(new CustomEvent('livecity:verified-google-place', {
      detail: { googlePlaceId: link.googlePlaceId, buildingId }
    }));

    // The 14k+ exact links are metadata, not permission to incur per-click charges.
    // No browser-side approval token can safely authorize or budget these calls.
    if (!PAID_GOOGLE_PHOTOS_ENABLED) return;
    const key = apiKey();
    if (!key) { stats.noKey++; return; }

    const host = ensureHost();
    if (!host) return;
    host.style.display = '';
    host.innerHTML = '<div style="font-size:12px;font-weight:700;margin-bottom:7px">Google Places 写真</div><div style="font-size:11px;opacity:.72">読み込み中…</div>';

    try {
      const place = await getPlace(link.googlePlaceId, key);
      if (token !== renderToken) return;
      const photos = Array.isArray(place?.photos) ? place.photos.slice(0, MAX_PHOTOS) : [];
      if (!photos.length) { hideHost(); return; }

      const resolved = [];
      for (const photo of photos) {
        const url = await getMediaUrl(photo?.name, key);
        if (token !== renderToken) return;
        if (url) resolved.push({ photo, url });
      }
      if (!resolved.length) { hideHost(); return; }

      const mapUrl = String(place?.googleMapsUri || '');
      const title = esc(place?.displayName?.text || link.buildingName || 'Google Places');
      host.innerHTML = `
        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:7px">
          <div style="font-size:12px;font-weight:700">Google Places 写真</div>
          <span style="font-size:10px;padding:2px 6px;border:1px solid rgba(100,160,255,.38);border-radius:999px">Google</span>
        </div>
        <div style="font-size:11px;margin-bottom:7px;opacity:.86">${title}</div>
        <div style="display:grid;grid-template-columns:${resolved.length > 1 ? 'repeat(2,minmax(0,1fr))' : '1fr'};gap:6px">
          ${resolved.map(({ photo, url }) => `
            <figure style="margin:0;min-width:0">
              <img src="${esc(url)}" alt="${title}" loading="lazy" referrerpolicy="no-referrer" style="display:block;width:100%;height:112px;object-fit:cover;border-radius:7px;background:#111827">
              <figcaption style="font-size:9px;line-height:1.3;margin-top:3px;opacity:.72">${authorHtml(photo)}</figcaption>
            </figure>`).join('')}
        </div>
        ${mapUrl ? `<div style="margin-top:6px;font-size:10px"><a href="${esc(mapUrl)}" target="_blank" rel="noopener noreferrer">Google マップで確認</a></div>` : ''}
      `;
      stats.photosRendered += resolved.length;
    } catch (err) {
      stats.errors++;
      hideHost();
      console.warn(MARKER, 'photo render failed', buildingId, err);
    }
  }

  function buildingPhotoBinding() {
    try { return (typeof BuildingPhoto !== 'undefined') ? BuildingPhoto : null; }
    catch (_) { return null; }
  }

  function patchBuildingPhoto() {
    if (patched) return true;
    const layer = buildingPhotoBinding();
    if (!layer || typeof layer.fillCard !== 'function') return false;
    if (layer.__mission36lBuildingPhotoPatched) { patched = true; return true; }

    const original = layer.fillCard.bind(layer);
    layer.fillCard = (detail, ...rest) => {
      stats.cardCalls++;
      const result = original(detail, ...rest);
      Promise.resolve().then(() => renderForBuilding(canonicalIdFromDetail(detail)));
      return result;
    };
    layer.__mission36lBuildingPhotoPatched = true;
    patched = true;
    console.info(MARKER, 'BuildingPhoto.fillCard patched');
    return true;
  }

  function install() {
    let tries = 0;
    const timer = setInterval(() => {
      tries++;
      if (patchBuildingPhoto() || tries >= 240) clearInterval(timer);
    }, 250);
    window.__MISSION36L_BUILDING_PHOTO__ = () => ({
      ...stats,
      placeCache: placeCache.size,
      mediaCache: mediaCache.size,
      paidPhotosEnabled: PAID_GOOGLE_PHOTOS_ENABLED,
      patched,
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, { once: true });
  else install();
})();
