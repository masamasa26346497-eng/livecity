/* Mission 38F facility fast-load module (standalone, no external services).
 * Sources: facilities-startup.json (1,120 sample), ward-manifest.json, wards/{wardId}.json (full 40,585 total).
 * Works in browser (window.Mission38FFacility) and Node (module.exports). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Mission38FFacility = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MISSING = '情報なし';
  var ATTRIBUTION = '© OpenStreetMap contributors (ODbL 1.0)';
  var CATEGORY_LABELS = {
    tourism: '観光', dining: '飲食', shopping: '買い物', public: '公共', park: '公園',
    medical: '医療', transport: '交通', education: '教育', lodging: '宿泊'
  };

  function normalizeText(s) {
    return String(s == null ? '' : s).normalize('NFKC').toLowerCase().replace(/\s+/g, '');
  }

  function dedupeBySourceId(records) {
    var seen = new Set();
    var out = [];
    for (var i = 0; i < records.length; i++) {
      var r = records[i];
      var key = r && (r.sourceId || r.id);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(r);
    }
    return out;
  }

  function field(v) {
    if (v == null) return MISSING;
    var s = String(v).trim();
    return s === '' || s === 'unknown' ? MISSING : s;
  }

  /** Display-ready detail; every value is a plain string (render via textContent). */
  function describe(r) {
    return {
      name: field(r.name),
      category: CATEGORY_LABELS[r.category] || field(r.category),
      subcategory: field(r.subcategory),
      ward: field(r.wardName),
      address: field(r.address),
      phone: field(r.phone),
      website: field(r.website),
      openingHours: field(r.openingHours),
      wheelchair: field(r.wheelchair),
      source: field(r.source),
      sourceId: field(r.sourceId),
      license: field(r.license),
      attribution: field(r.attribution) === MISSING ? '© OpenStreetMap contributors' : r.attribution
    };
  }

  var DEFAULT_MAX_CACHED_WARDS = 3;   // parsed records of 3 wards; all 24 wards would be ~44 MB of JSON
  var POI_CAP = 2500;                 // same per-layer simultaneous point cap as 37K

  /** Distance thinning (pure). Coordinates are local metres (record.localX/localZ, znorth-neg-v1).
   *  Mirrors the 37K rules: point range 12000 m (dining 3000 m), label range 1400 m, nearest-first cap.
   *  Returns {points:[{r,d}], labels:[{r,d}], dropped}; never more than `cap` points. */
  function cullByDistance(records, cx, cz, o) {
    o = o || {};
    var cap = o.cap > 0 ? o.cap : POI_CAP;
    var lbMax = o.lbMax || 1400;
    var cand = [];
    for (var i = 0; i < records.length; i++) {
      var r = records[i];
      if (!isFinite(r.localX) || !isFinite(r.localZ)) continue;
      var dx = r.localX - cx, dz = r.localZ - cz;
      var d = Math.sqrt(dx * dx + dz * dz);
      if (d <= (o.ptMax || (r.category === 'dining' ? 3000 : 12000))) cand.push({ r: r, d: d });
    }
    cand.sort(function (a, b) { return a.d - b.d; });
    var points = cand.slice(0, cap);
    var labels = points.filter(function (p) { return p.d <= lbMax; });
    return { points: points, labels: labels, dropped: cand.length - points.length };
  }

  function createLoader(opts) {
    opts = opts || {};
    var baseUrl = (opts.baseUrl || 'map-data/osaka-city/facilities/').replace(/\/?$/, '/');
    var fetchImpl = opts.fetchImpl || (typeof fetch === 'function' ? fetch.bind(null) : null);
    var now = opts.now || function () { return (typeof performance !== 'undefined' ? performance.now() : Date.now()); };
    if (!fetchImpl) throw new Error('fetch implementation required');

    var maxCached = opts.maxCachedWards > 0 ? Math.floor(opts.maxCachedWards) : DEFAULT_MAX_CACHED_WARDS;
    var cache = Object.create(null);     // wardId -> records[]
    var lru = [];                        // wardIds, least recently used first
    var inflight = Object.create(null);  // wardId -> Promise
    var stats = { requests: 0, failures: 0, evictions: 0, wardLoads: Object.create(null), startup: null };
    var manifest = null;
    var startup = null;
    var activeToken = 0;

    function getJson(path) {
      stats.requests++;
      var t0 = now();
      return Promise.resolve(fetchImpl(baseUrl + path)).then(function (res) {
        if (!res || !res.ok) throw new Error('HTTP ' + (res && res.status) + ' for ' + path);
        return res.text().then(function (text) {
          return { json: JSON.parse(text), bytes: text.length, ms: now() - t0 };
        });
      }).catch(function (e) { stats.failures++; throw e; });
    }

    function loadManifest() {
      if (manifest) return Promise.resolve(manifest);
      return getJson('ward-manifest.json').then(function (r) { manifest = r.json; return manifest; });
    }

    /** Lightweight sample only (NOT the full dataset). */
    function loadStartup() {
      if (startup) return Promise.resolve(startup);
      return getJson('facilities-startup.json').then(function (r) {
        var records = dedupeBySourceId(r.json.records || []);
        startup = { records: records, sampleCount: records.length, sourceRecordCount: r.json.sourceRecordCount };
        stats.startup = { ms: r.ms, chars: r.bytes, count: records.length };
        return startup;
      });
    }

    /** Full per-ward data; cached, concurrent calls share one request, failures are not cached. */
    function touch(wardId) {
      var i = lru.indexOf(wardId);
      if (i >= 0) lru.splice(i, 1);
      lru.push(wardId);
    }
    function evictOverCap() {
      while (lru.length > maxCached) { delete cache[lru.shift()]; stats.evictions++; }
    }
    function releaseWard(wardId) {
      if (!cache[wardId]) return false;
      delete cache[wardId];
      lru.splice(lru.indexOf(wardId), 1);
      stats.evictions++;
      return true;
    }
    function clearCache() { while (lru.length) releaseWard(lru[0]); }

    function loadWard(wardId) {
      if (cache[wardId]) { touch(wardId); return Promise.resolve(cache[wardId]); }
      if (inflight[wardId]) return inflight[wardId];
      var p = loadManifest().then(function (m) {
        var entry = (m.wards || []).filter(function (w) { return w.wardId === wardId; })[0];
        if (!entry) throw new Error('unknown ward: ' + wardId);
        return getJson(entry.url).then(function (r) {
          var records = dedupeBySourceId(r.json.records || []);
          cache[wardId] = records;
          touch(wardId);
          evictOverCap();
          stats.wardLoads[wardId] = { ms: r.ms, chars: r.bytes, count: records.length, expected: entry.recordCount };
          return records;
        });
      });
      inflight[wardId] = p;
      var clear = function () { delete inflight[wardId]; };
      p.then(clear, clear);
      return p;
    }

    /** Stale-safe select: resolves {stale:true} if a newer selectWard() was issued meanwhile. */
    function selectWard(wardId) {
      var token = ++activeToken;
      return loadWard(wardId).then(function (records) {
        return token === activeToken ? { stale: false, wardId: wardId, records: records } : { stale: true, wardId: wardId };
      }, function (err) {
        if (token !== activeToken) return { stale: true, wardId: wardId };
        throw err;
      });
    }

    /** Invalidate any pending selectWard()/selectSample(); their results resolve as {stale:true}. */
    function cancelSelection() { return ++activeToken; }

    /** Stale-safe sample select, sharing the same token as selectWard(). */
    function selectSample() {
      var token = ++activeToken;
      return loadStartup().then(function (s) {
        return token === activeToken ? { stale: false, records: s.records, sampleCount: s.sampleCount } : { stale: true };
      }, function (err) {
        if (token !== activeToken) return { stale: true };
        throw err;
      });
    }

    return {
      loadManifest: loadManifest, loadStartup: loadStartup, loadWard: loadWard, selectWard: selectWard,
      cancelSelection: cancelSelection, selectSample: selectSample,
      isCurrent: function (token) { return token === activeToken; },
      currentToken: function () { return activeToken; },
      isWardCached: function (id) { return !!cache[id]; },
      getCachedWards: function () { return lru.slice(); },
      releaseWard: releaseWard, clearCache: clearCache,
      getStats: function () { return stats; }
    };
  }

  /** Name/address/subcategory substring search with optional category filter. */
  function search(records, query, o) {
    o = o || {};
    var q = normalizeText(query);
    var limit = o.limit || 200;
    var out = [];
    var total = 0;
    for (var i = 0; i < records.length; i++) {
      var r = records[i];
      if (o.category && r.category !== o.category) continue;
      if (q) {
        var hay = normalizeText(r.normalizedName || r.name) + '|' + normalizeText(r.address) + '|' + normalizeText(r.subcategory);
        if (hay.indexOf(q) < 0) continue;
      }
      total++;
      if (out.length < limit) out.push(r);
    }
    return { total: total, results: out };
  }

  return {
    MISSING: MISSING, ATTRIBUTION: ATTRIBUTION, CATEGORY_LABELS: CATEGORY_LABELS,
    createLoader: createLoader, cullByDistance: cullByDistance, POI_CAP: POI_CAP,
    DEFAULT_MAX_CACHED_WARDS: DEFAULT_MAX_CACHED_WARDS, search: search, describe: describe,
    dedupeBySourceId: dedupeBySourceId, normalizeText: normalizeText
  };
});
