// public/supplement-layer/supplement-layer.js  [Issue #65 / 第6段階]
// 補完建物レイヤー（独立モジュール。本体HTML/PR#68 には未接続）。
//  * 既定OFF。enable() の明示呼出しで初めて manifest を fetch。
//  * 近距離（update(x,z,radius) の円と交わるタイル）のみ遅延取得。重複リクエストは inflight で合流。
//  * disable()/dispose()/範囲外化で AbortController により取得を中止し、メッシュを dispose。
//  * 失敗（manifest不在・タイル404・不正JSON）は例外を外へ出さず state/統計に記録。既存の地図には触れない。
//  * publishable !== true の manifest は allowUnpublishable:true を渡さない限り読まない。
// 依存（fetch / メッシュ生成 / Group）は注入するため、Node のテストで検証できる。THREE は createThreeMeshBuilder(THREE) でのみ使う。
export const SCHEMA = 'livecity-supplement-layer-v1';
export const DEFAULT_PLACEHOLDER_HEIGHT_M = 6; // h=null（根拠なし）の表示用仮高さ。実測/推定ではない。
export const COLORS = { measured: 0x7fb8e8, estimated: 0xe8c27f, unverified: 0xd9a0d9, unknown: 0xb0b0b0 };

const fin = (v) => typeof v === 'number' && Number.isFinite(v);
const validRing = (r) => Array.isArray(r) && r.length >= 3 && r.every((p) => Array.isArray(p) && fin(p[0]) && fin(p[1]));

/** 高さの区分。estimated:false かつ heightSource 明示のみ measured。null は unverified。h 無しは unknown。 */
export function heightClass(rec) {
  if (!fin(rec.h) || rec.h <= 0) return 'unknown';
  if (rec.heightEstimated === false && rec.heightSource && !String(rec.heightSource).includes('unverified')) return 'measured';
  if (rec.heightEstimated === true) return 'estimated';
  return 'unverified';
}

/** タイルJSON → 表示用レコード。不正な建物は skipped に数えて除外（例外にしない）。 */
export function prepareTile(tile) {
  if (!tile || tile.layer !== 'supplement' || !Array.isArray(tile.buildings)) return { ok: false, buildings: [], skipped: 0, reason: 'tile-shape' };
  const buildings = []; let skipped = 0;
  for (const b of tile.buildings) {
    const polys = b && Array.isArray(b.polys) ? b.polys : b && validRing(b.fp) ? [[b.fp]] : null;
    if (!b || b.diagnostic || b.geometry === null || !polys || !polys.length || !polys.every((p) => Array.isArray(p) && p.length && p.every(validRing))) { skipped++; continue; }
    const cls = heightClass(b);
    buildings.push({ id: String(b.id), sourceId: b.sourceId ?? null, polys, z0: fin(b.z0) ? b.z0 : 0,
      height: cls === 'unknown' ? DEFAULT_PLACEHOLDER_HEIGHT_M : b.h, heightClass: cls, heightSource: b.heightSource ?? null,
      heightEstimated: b.heightEstimated ?? null, heightAccuracy: b.heightAccuracy ?? null, status: b.status ?? null, matchedExistingIds: b.matchedExistingIds ?? [] });
  }
  return { ok: true, buildings, skipped };
}

/**
 * THREE 用メッシュ生成。world {x,z}(m, z北=負) をそのまま使う: Shape(x,-z) を押出し→rotateX(-90°) で (x, y=高さ, z) になる。
 * 既存PLATEAU描画との座標一致は PR#68 の実ビューアで未確認（接続時に要確認）。内周は穴として保持。
 * 戻り値は { object, dispose, pickMap } 。補完は別 Group・別ピック対象（既存の建物ピックに混ぜない）。
 */
export function createThreeMeshBuilder(THREE, { opacity = 0.9 } = {}) {
  return (prepared, { tx, tz }) => {
    const group = new THREE.Group(); group.name = `supplement_${tx}_${tz}`;
    const geoms = [], mats = new Map(), pickMap = new Map();
    for (const b of prepared.buildings) {
      for (const poly of b.polys) {
        const sh = new THREE.Shape(poly[0].map(([x, z]) => new THREE.Vector2(x, -z)));
        for (const hole of poly.slice(1)) sh.holes.push(new THREE.Path(hole.map(([x, z]) => new THREE.Vector2(x, -z))));
        const g = new THREE.ExtrudeGeometry(sh, { depth: b.height, bevelEnabled: false });
        g.rotateX(-Math.PI / 2); g.translate(0, b.z0, 0);
        if (!mats.has(b.heightClass)) mats.set(b.heightClass, new THREE.MeshLambertMaterial({ color: COLORS[b.heightClass], transparent: true, opacity }));
        const m = new THREE.Mesh(g, mats.get(b.heightClass)); m.userData.supplement = b; group.add(m); geoms.push(g); pickMap.set(m, b);
      }
    }
    return { object: group, pickMap, dispose() { geoms.forEach((g) => g.dispose()); mats.forEach((m) => m.dispose()); } };
  };
}

export function createSupplementLayer({ baseUrl, fetchImpl, buildMesh, group, allowUnpublishable = false, maxConcurrent = 2, maxTiles = 64, retryAfterMs = 30000, margin = 100, now = () => Date.now(), onStatus = () => {} }) {
  if (typeof buildMesh !== 'function') throw new TypeError('buildMesh required');
  const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
  const base = String(baseUrl || '').replace(/\/?$/, '/');
  const st = { state: 'off', epoch: 0, manifest: null, error: null, ctrl: null, loaded: new Map(), inflight: new Map(), failed: new Map(), stats: { requests: 0, aborted: 0, failed: 0, skippedBuildings: 0, built: 0 } };
  const setState = (s, err) => { st.state = s; st.error = err ?? null; try { onStatus({ state: s, error: st.error }); } catch { /* ignore */ } };

  async function getJson(url, signal) {
    st.stats.requests++;
    const res = await doFetch(url, { signal });
    if (!res || !res.ok) throw new Error(`http ${res ? res.status : 'none'}`);
    return res.json();
  }
  function unload(key) { const t = st.loaded.get(key); if (!t) return; try { group && group.remove && group.remove(t.object); } catch { /* ignore */ } try { t.dispose && t.dispose(); } catch { /* ignore */ } st.loaded.delete(key); }
  function clearAll() { for (const k of [...st.loaded.keys()]) unload(k); st.inflight.clear(); st.failed.clear(); }

  async function enable() {
    if (st.state === 'ready' || st.state === 'loading-manifest') return st.state;
    if (!doFetch) { setState('error', 'no-fetch'); return st.state; }
    const epoch = ++st.epoch; st.ctrl = new AbortController(); setState('loading-manifest');
    try {
      const m = await getJson(base + 'manifest.json', st.ctrl.signal);
      if (epoch !== st.epoch) return st.state; // disable 後の古い応答
      if (!m || m.schema !== SCHEMA || !Array.isArray(m.tiles) || !fin(m.tileSize) || m.tileSize <= 0) throw new Error('manifest-schema');
      if (m.publishable !== true && !allowUnpublishable) { setState('blocked-unpublishable', 'manifest.publishable !== true'); return st.state; }
      st.manifest = { ...m, tileMap: new Map(m.tiles.filter((t) => fin(t.tx) && fin(t.tz) && typeof t.file === 'string' && !/[\\/]|\.\./.test(t.file)).map((t) => [`${t.tx},${t.tz}`, t])) };
      setState('ready');
    } catch (e) { if (epoch !== st.epoch) return st.state; if (e && e.name === 'AbortError') st.stats.aborted++; setState('error', String(e && e.message || e)); }
    return st.state;
  }

  function disable() { st.epoch++; if (st.ctrl) { st.stats.aborted += st.inflight.size; st.ctrl.abort(); st.ctrl = null; } clearAll(); st.manifest = null; st.view = null; setState('off'); }

  function wantedKeys(x, z, radius, extra) {
    const s = st.manifest.tileSize, r = radius + extra, out = [];
    for (const [key, t] of st.manifest.tileMap) {
      const nx = Math.max(t.tx * s, Math.min(x, (t.tx + 1) * s)), nz = Math.max(t.tz * s, Math.min(z, (t.tz + 1) * s));
      const d = Math.hypot(x - nx, z - nz);
      if (d <= r) out.push({ key, t, d });
    }
    return out.sort((a, b) => a.d - b.d);
  }

  function load(key, t) {
    if (st.loaded.has(key) || st.inflight.has(key)) return;
    const f = st.failed.get(key); if (f && now() < f) return;
    const epoch = st.epoch, signal = st.ctrl.signal;
    const p = getJson(base + t.file, signal).then((json) => {
      if (epoch !== st.epoch) return;
      const prepared = prepareTile(json);
      if (!prepared.ok) throw new Error(prepared.reason);
      st.stats.skippedBuildings += prepared.skipped;
      const built = buildMesh(prepared, { tx: t.tx, tz: t.tz });
      if (group && group.add) group.add(built.object);
      st.loaded.set(key, built); st.stats.built += prepared.buildings.length;
    }).catch((e) => {
      if (epoch !== st.epoch) return;
      if (e && e.name === 'AbortError') { st.stats.aborted++; return; }
      st.stats.failed++; st.failed.set(key, now() + retryAfterMs);
    }).finally(() => {
      if (st.inflight.get(key) === p) st.inflight.delete(key);
      if (epoch === st.epoch && st.view && st.state === 'ready') update(...st.view); // 並列上限で待たせた近傍タイルを続けて取得
    });
    st.inflight.set(key, p);
  }

  /** 毎フレームでなく、カメラ移動が閾値を超えたときに呼ぶ想定。同期で要求を発行するだけ。 */
  function update(x, z, radius) {
    if (st.state !== 'ready' || !fin(x) || !fin(z) || !fin(radius)) return;
    st.view = [x, z, radius];
    const want = wantedKeys(x, z, radius, 0).slice(0, maxTiles);
    const keep = new Set(wantedKeys(x, z, radius, margin).map((w) => w.key));
    for (const k of [...st.loaded.keys()]) if (!keep.has(k)) unload(k); // ヒステリシス付き破棄
    for (const w of want) { if (st.inflight.size >= maxConcurrent) break; load(w.key, w.t); }
  }

  async function idle() { while (st.inflight.size) await Promise.allSettled([...st.inflight.values()]); }
  return { enable, disable, update, idle, dispose: disable,
    get state() { return st.state; }, get error() { return st.error; }, get stats() { return { ...st.stats, loadedTiles: st.loaded.size, inflight: st.inflight.size }; },
    get manifestInfo() { const m = st.manifest; return m ? { publishable: m.publishable, license: m.license, source: m.source, counts: m.counts, tileCount: m.tiles.length } : null; },
    pick(mesh) { for (const t of st.loaded.values()) { const b = t.pickMap && t.pickMap.get(mesh); if (b) return b; } return null; },
    loadedKeys() { return [...st.loaded.keys()]; } };
}
