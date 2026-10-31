'use strict';
// Mission 70 P0: cloud receiving-side contract (pure functions, no I/O, no network, default-disabled).
// Used only by synthetic-fixture tests. Not imported by any viewer page. Contains no storage URLs or secrets.
const crypto = require('crypto');

const SCHEMA = 'livecity.mission70.cloud-manifest/1';
const CONTENT_TYPES = { '.json': 'application/json', '.glb': 'model/gltf-binary' };
const PATH_RE = /^(tileset\.json|source\.json|build-report\.json|(tiles|lod)\/[A-Za-z0-9_.-]+\.glb|(ids|attrs)\/[A-Za-z0-9_.-]+\.json)$/;
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const canon = (m) => JSON.stringify({ schema: m.schema, version: m.version, published: m.published, wards: m.wards });
const sign = (m, key) => crypto.createHmac('sha256', key).update(canon(m)).digest('hex');

// Structural + integrity validation. Fail closed: any doubt -> {ok:false}.
function validateManifest(m, key) {
  const e = [];
  if (!m || m.schema !== SCHEMA) e.push('schema');
  if (!Number.isInteger(m && m.version) || m.version < 1) e.push('version');
  if (typeof (m && m.published) !== 'boolean') e.push('published-flag');
  if (!Array.isArray(m && m.wards)) e.push('wards'); else {
    const seen = new Set();
    for (const w of m.wards) {
      if (!/^[0-9]{5}$/.test(w.wardCode) || seen.has(w.wardCode)) e.push('wardCode'); seen.add(w.wardCode);
      if (!Number.isInteger(w.buildings) || w.buildings < 0) e.push('buildings');
      let b = 0;
      for (const f of w.files || []) {
        if (!PATH_RE.test(f.path) || f.path.includes('..')) e.push('path');
        if (!/^[0-9a-f]{64}$/.test(f.sha256) || !Number.isInteger(f.bytes) || f.bytes < 0) e.push('file-hash/bytes');
        b += f.bytes;
      }
      if (w.bytes !== b) e.push('ward-bytes');
      if (!(w.files || []).some((f) => f.path === 'tileset.json')) e.push('no-tileset');
    }
  }
  if (!key || !m || m.signature !== sign(m, key)) e.push('signature');
  return { ok: e.length === 0, errors: [...new Set(e)] };
}

// tileset content refs must be relative and listed in the manifest.
function checkTilesetRefs(tileset, files) {
  const set = new Set(files.map((f) => f.path)), bad = [];
  const st = [tileset.root];
  while (st.length) { const t = st.pop(); if (!t) continue; const u = t.content && (t.content.uri || t.content.url); if (u && (/^([a-z]+:)?\/\//i.test(u) || u.startsWith('/') || u.includes('..') || !set.has(u))) bad.push(u); for (const c of t.children || []) st.push(c); }
  return { ok: bad.length === 0, bad };
}

// Request handler model. authz is an injected function (NOT the same as Vercel SSO); no authz -> deny everything.
// store.get(path) -> Buffer|null. Returns {status, headers, body}.
function handle(req, ctx) {
  const deny = (s) => ({ status: s, headers: { 'cache-control': 'no-store' }, body: null });
  if (!ctx || !ctx.enabled || typeof ctx.authz !== 'function' || !ctx.manifest) return deny(404);       // default OFF
  if (req.method !== 'GET' && req.method !== 'HEAD') return deny(405);
  if (ctx.manifest.published !== true) return deny(404);
  if (!ctx.authz(req)) return deny(403);                                                              // fail closed
  if (req.origin && req.origin !== ctx.sameOrigin) return deny(403);                                  // same-origin only, no CORS grant
  const m = /^\/ext-3dtiles\/([0-9]{5})\/(.+)$/.exec(req.path || '');
  if (!m || !PATH_RE.test(m[2]) || m[2].includes('..')) return deny(404);
  const w = ctx.manifest.wards.find((x) => x.wardCode === m[1]);
  const f = w && w.files.find((x) => x.path === m[2]);
  if (!f) return deny(404);
  const body = ctx.store.get(m[1] + '/' + m[2]);
  if (!body || sha(body) !== f.sha256) return deny(502);                                              // integrity mismatch -> never serve
  const ct = CONTENT_TYPES[m[2].slice(m[2].lastIndexOf('.'))];
  const h = { 'content-type': ct, 'accept-ranges': 'bytes', 'cache-control': 'private, max-age=3600', etag: '"' + f.sha256.slice(0, 32) + '"', 'x-content-type-options': 'nosniff', vary: 'Origin' };
  if (req.method === 'HEAD') return { status: 200, headers: { ...h, 'content-length': String(body.length) }, body: null };
  if (req.range) {
    const r = /^bytes=(\d+)-(\d*)$/.exec(req.range);
    if (!r) return deny(416);
    const s = +r[1], e = r[2] === '' ? body.length - 1 : Math.min(+r[2], body.length - 1);
    if (s > e || s >= body.length) return deny(416);
    return { status: 206, headers: { ...h, 'content-range': 'bytes ' + s + '-' + e + '/' + body.length, 'content-length': String(e - s + 1) }, body: body.subarray(s, e + 1) };
  }
  return { status: 200, headers: { ...h, 'content-length': String(body.length) }, body };
}

module.exports = { SCHEMA, PATH_RE, CONTENT_TYPES, sha, sign, validateManifest, checkTilesetRefs, handle };
