'use strict';
// Mission 72: same-origin auth proxy adapter for private object storage (offline, injected store, NO network/credentials).
// Viewer URL contract (unchanged): /ext-3dtiles/<wardId>/<file>, /ext-3dtiles/<wardId>/layers/<known>.json, /ext-3dtiles/index.json
// Fail-closed: disabled unless enabled flag + upload-gate approval (all gates true) + signed, published manifest + authz token list.
// Today no approval exists, so createProxy(...) always answers 404. Real storage/R2 is never touched here; store is injected.
const crypto = require('crypto');
const C = require('./mission70-cloud-contract.cjs');
const G = require('./mission70-upload-gate.cjs');

const PREFIX = '/ext-3dtiles/';
const FILE_RE = /^(tileset\.json|source\.json|build-report\.json|(tiles|lod)\/[A-Za-z0-9_.-]+\.glb|(ids|attrs)\/[A-Za-z0-9_.-]+\.json|layers\/(roads|waterways|parks|railways|labels|layers-report)\.json)$/;
const WARD_ID_RE = /^[a-z0-9-]{2,40}$/;
const CT = { '.json': 'application/json', '.glb': 'model/gltf-binary' };
const DEFAULTS = { maxObjectBytes: 64 * 1024 * 1024, timeoutMs: 8000 };

const sha = C.sha;
const hex = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const teq = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };

// Manifest check for the proxy (superset of Mission70 PATH_RE: adds layers/*). Signature reuses C.sign.
function validateManifest(m, key) {
  const e = [];
  if (!m || m.schema !== C.SCHEMA) e.push('schema');
  if (!Number.isInteger(m && m.version) || m.version < 1) e.push('version');
  if (typeof (m && m.published) !== 'boolean') e.push('published-flag');
  const seenC = new Set(), seenI = new Set();
  if (!Array.isArray(m && m.wards)) e.push('wards'); else for (const w of m.wards) {
    if (!/^[0-9]{5}$/.test(w.wardCode) || seenC.has(w.wardCode)) e.push('wardCode'); seenC.add(w.wardCode);
    if (!WARD_ID_RE.test(w.wardId || '') || seenI.has(w.wardId)) e.push('wardId'); seenI.add(w.wardId);
    let b = 0;
    for (const f of w.files || []) {
      if (!FILE_RE.test(f.path)) e.push('path');
      if (!/^[0-9a-f]{64}$/.test(f.sha256) || !Number.isInteger(f.bytes) || f.bytes < 0) e.push('file-hash/bytes'); else b += f.bytes;
    }
    if (w.bytes !== b) e.push('ward-bytes');
    if (!(w.files || []).some((f) => f.path === 'tileset.json')) e.push('no-tileset');
  }
  if (!key || !m || m.signature !== C.sign(m, key)) e.push('signature');
  return { ok: e.length === 0, errors: [...new Set(e)] };
}

// Token list entries: "<sha256hex of token>" (all wards) or "<sha256hex>:ward1+ward2" (scoped). Raw tokens are never stored.
function parseAllow(list) {
  const out = [];
  for (const raw of String(list || '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const [h, w] = raw.split(':');
    if (/^[0-9a-f]{64}$/.test(h)) out.push({ hash: h, wards: w ? w.split('+').filter(Boolean) : null });
  }
  return out;
}
function tokenOf(req) {
  const h = req.headers || {};
  const a = h.authorization || '';
  if (/^Bearer\s+\S+$/i.test(a)) return a.replace(/^Bearer\s+/i, '');
  const m = /(?:^|;\s*)lc_proxy=([A-Za-z0-9._~-]{16,200})/.exec(h.cookie || '');
  return m ? m[1] : null;
}
// -> {ok, wards|null}. Anonymous / unknown token -> ok:false.
function authorize(req, allow) {
  const t = tokenOf(req);
  if (!t) return { ok: false };
  const th = hex(t);
  for (const a of allow) if (teq(a.hash, th)) return { ok: true, wards: a.wards };
  return { ok: false };
}

function safePath(raw) {
  const p = String(raw || '').split('?')[0].split('#')[0];
  if (!p.startsWith(PREFIX) || /%|\\|\0|\/\/|(^|\/)\.{1,2}(\/|$)/.test(p)) return null;
  return p.slice(PREFIX.length);
}
function parseRange(h, size) {
  const r = /^bytes=(\d*)-(\d*)$/.exec(h);
  if (!r || (r[1] === '' && r[2] === '') || size === 0) return null;
  let s, e;
  if (r[1] === '') { const n = +r[2]; if (n === 0) return null; s = Math.max(0, size - n); e = size - 1; }
  else { s = +r[1]; e = r[2] === '' ? size - 1 : Math.min(+r[2], size - 1); }
  return s > e || s >= size ? null : [s, e];
}
const withTimeout = (p, ms) => new Promise((res, rej) => { const t = setTimeout(() => rej(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })), ms); Promise.resolve(p).then((v) => { clearTimeout(t); res(v); }, (x) => { clearTimeout(t); rej(x); }); });

// opts: { env:{LIVECITY_CLOUD_PROXY, LIVECITY_PROXY_ALLOW, LIVECITY_PROXY_MANIFEST_KEY}, approval, manifest, store:{get(key)->Promise<Buffer|null>}, sameOrigin, maxObjectBytes, timeoutMs }
function createProxy(opts) {
  const o = { ...DEFAULTS, ...opts }, env = o.env || {};
  const state = (() => {
    if (env.LIVECITY_CLOUD_PROXY !== '1') return { off: 'flag' };
    if (!G.evaluate(o.approval).allowed) return { off: 'approval' };
    if (!o.store || typeof o.store.get !== 'function' || !o.sameOrigin) return { off: 'store' };
    if (!validateManifest(o.manifest, env.LIVECITY_PROXY_MANIFEST_KEY).ok || o.manifest.published !== true) return { off: 'manifest' };
    const allow = parseAllow(env.LIVECITY_PROXY_ALLOW);
    return allow.length ? { allow } : { off: 'authz' };
  })();
  const R = (status, headers, body) => ({ status, headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers }, body: body || null });

  async function handle(req) {
    if (state.off) return R(404);                                                    // default OFF: indistinguishable from "no route"
    if (req.method !== 'GET' && req.method !== 'HEAD') return R(405, { allow: 'GET, HEAD' });
    const h = req.headers || {};
    if ((h.origin && h.origin !== o.sameOrigin) || h['sec-fetch-site'] === 'cross-site') return R(403);   // no CORS grant, ever
    const a = authorize(req, state.allow);
    if (!a.ok) return R(403);
    const rel = safePath(req.url);
    if (rel === null) return R(404);
    const ok = (extra) => R(200, { 'content-type': 'application/json', 'cross-origin-resource-policy': 'same-origin', vary: 'Authorization, Cookie, Origin', 'cache-control': 'private, max-age=300', ...extra });
    const visible = o.manifest.wards.filter((w) => !a.wards || a.wards.includes(w.wardId));
    if (rel === 'index.json') {
      const b = Buffer.from(JSON.stringify({ schema: 'livecity.mission72.index/1', verified: false, wards: visible.map((w) => ({ ward: w.wardId })) }));
      return req.method === 'HEAD' ? { ...ok({ 'content-length': String(b.length) }) } : { ...ok({ 'content-length': String(b.length) }), body: b };
    }
    const i = rel.indexOf('/');
    const wardId = i < 0 ? '' : rel.slice(0, i), file = i < 0 ? '' : rel.slice(i + 1);
    if (!FILE_RE.test(file)) return R(404);
    const w = o.manifest.wards.find((x) => x.wardId === wardId);
    if (!w) return R(404);
    if (a.wards && !a.wards.includes(wardId)) return R(403);                         // valid token, wrong ward
    const f = w.files.find((x) => x.path === file);
    if (!f) return R(404);
    if (f.bytes > o.maxObjectBytes) return R(413);
    let body;
    try { body = await withTimeout(o.store.get(w.wardCode + '/' + file), o.timeoutMs); }
    catch (e) { return e && e.code === 'TIMEOUT' ? R(504) : R(502); }
    if (!body) return R(502);                                                        // listed but missing in storage
    if (body.length !== f.bytes || sha(body) !== f.sha256) return R(502);            // corrupted -> never served
    const etag = '"' + f.sha256.slice(0, 32) + '"';
    const hd = { 'content-type': CT[file.slice(file.lastIndexOf('.'))], 'accept-ranges': 'bytes', etag };
    if (h['if-none-match'] === etag) return { ...ok(hd), status: 304 };
    if (req.method === 'GET' && h.range) {
      const r = parseRange(h.range, body.length);
      if (!r) return R(416, { 'content-range': 'bytes */' + body.length });
      return { ...ok({ ...hd, 'content-range': 'bytes ' + r[0] + '-' + r[1] + '/' + body.length, 'content-length': String(r[1] - r[0] + 1) }), status: 206, body: body.subarray(r[0], r[1] + 1) };
    }
    const full = ok({ ...hd, 'content-length': String(body.length) });
    return req.method === 'HEAD' ? full : { ...full, body };
  }
  return { handle, enabled: !state.off, disabledReason: state.off || null };
}

// Node http adapter (Vercel-function-compatible signature). Does not read request bodies.
function toNodeHandler(proxy) {
  return async (req, res) => {
    const r = await proxy.handle({ method: req.method, url: req.url, headers: req.headers });
    res.writeHead(r.status, r.headers);
    res.end(req.method === 'HEAD' ? undefined : r.body || undefined);
  };
}

module.exports = { PREFIX, FILE_RE, validateManifest, parseAllow, authorize, safePath, parseRange, createProxy, toNodeHandler, hex };
