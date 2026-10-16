// public/livecity-cesium-building-lookup.js
// [Mission 37] Browser-side exact canonical building lookup for Cesium POC.
// Reuses Mission 36A's 500m / 3x3 point-in-polygon strategy.
// It intentionally expects the existing generated runtime footprint tiles and does not
// duplicate or commit the ~574k/618k building corpus into this branch.
(function () {
  'use strict';

  const BASE = '/map-data/osaka-city/derived-v4-final/near/buildings';
  const TILE = 500;
  const CLAT = 34.604208;
  const CLON = 135.52502;
  const MPD = 111320;
  const MAX_CACHE = 48;
  const cache = new Map();
  const stats = { tileRequests:0, tileHits:0, tileMisses:0, pointTests:0, ringTests:0 };

  function toLocal(lat, lon) {
    return {
      x: (lon - CLON) * Math.cos(CLAT * Math.PI / 180) * MPD,
      z: -((lat - CLAT) * MPD),
    };
  }

  function inRing(px, pz, ring) {
    stats.ringTests++;
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0], zi = ring[i][1];
      const xj = ring[j][0], zj = ring[j][1];
      if (((zi > pz) !== (zj > pz)) &&
          (px < (xj - xi) * (pz - zi) / (zj - zi) + xi)) inside = !inside;
    }
    return inside;
  }

  function pointInFeature(px, pz, f) {
    const b = f && f.bbox;
    if (b && (px < b.minX || px > b.maxX || pz < b.minZ || pz > b.maxZ)) return false;
    const polys = f.geometryType === 'MultiPolygon' ? f.coordinates : [f.coordinates];
    for (const poly of polys || []) {
      if (!poly || !poly.length || !poly[0] || poly[0].length < 3) continue;
      if (!inRing(px, pz, poly[0])) continue;
      let inHole = false;
      for (let k = 1; k < poly.length; k++) {
        if (poly[k] && poly[k].length >= 3 && inRing(px, pz, poly[k])) {
          inHole = true; break;
        }
      }
      if (!inHole) return true;
    }
    return false;
  }

  function areaM2(f) {
    const polys = f.geometryType === 'MultiPolygon' ? f.coordinates : [f.coordinates];
    let total = 0;
    for (const poly of polys || []) {
      if (!poly || !poly[0]) continue;
      for (let r = 0; r < poly.length; r++) {
        const ring = poly[r];
        if (!ring || ring.length < 3) continue;
        let a = 0;
        for (let i = 0; i < ring.length; i++) {
          const p = ring[i], q = ring[(i + 1) % ring.length];
          a += p[0] * q[1] - q[0] * p[1];
        }
        total += (r === 0 ? 1 : -1) * Math.abs(a) / 2;
      }
    }
    return total;
  }

  async function loadTile(tx, tz) {
    const key = tx + '_' + tz;
    if (cache.has(key)) {
      const v = cache.get(key);
      cache.delete(key); cache.set(key, v);
      stats.tileHits++;
      return v;
    }
    stats.tileRequests++;
    let features = null;
    try {
      const r = await fetch(BASE + '/tile_' + key + '.json', { cache:'force-cache' });
      if (r.ok) features = (await r.json()).features || [];
      else stats.tileMisses++;
    } catch (_) {
      stats.tileMisses++;
    }
    cache.set(key, features);
    if (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value);
    return features;
  }

  async function buildingsAtLatLon(lat, lon) {
    stats.pointTests++;
    const p = toLocal(lat, lon);
    const tx = Math.floor(p.x / TILE);
    const tz = Math.floor(p.z / TILE);
    const groups = [];
    for (let dx=-1; dx<=1; dx++) for (let dz=-1; dz<=1; dz++) {
      groups.push(await loadTile(tx + dx, tz + dz));
    }
    const seen = new Set();
    const hits = [];
    for (const feats of groups) {
      for (const f of feats || []) {
        if (!f || !f.canonicalId || seen.has(f.canonicalId)) continue;
        if (!pointInFeature(p.x, p.z, f)) continue;
        seen.add(f.canonicalId);
        hits.push(f);
      }
    }
    hits.sort((a,b) => areaM2(a) - areaM2(b));
    return { local:p, hits, best:hits[0] || null };
  }

  window.LiveCityCesiumBuildingLookup = {
    source: 'Mission36A-compatible-runtime-footprints',
    baseUrl: BASE,
    toLocal,
    buildingsAtLatLon,
    stats: () => ({...stats, cachedTiles:cache.size}),
  };
})();