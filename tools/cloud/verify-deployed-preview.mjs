// Mission 196C: verify a DEPLOYED preview URL over plain HTTP (Node fetch only).
// Usage: node tools/cloud/verify-deployed-preview.mjs <baseUrl>
// Never bypasses deployment protection. 401/403/404/405/5xx or a login redirect => FAIL (not "Ready").
const base = (process.argv[2] || process.env.PREVIEW_URL || '').replace(/\/+$/, '');
if (!base) { console.error('usage: verify-deployed-preview.mjs <baseUrl>'); process.exit(2); }

const results = [];
let authRequired = false;
const rec = (name, ok, info) => { results.push({ name, ok, ...info }); console.log((ok ? 'PASS ' : 'FAIL ') + name + ' ' + JSON.stringify(info)); };

async function get(url, opts = {}) {
  const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(60000), ...opts });
  const loc = res.headers.get('location') || '';
  if (res.status === 401 || res.status === 403 || /vercel\.com\/(login|sso)|sso-api/.test(loc)) authRequired = true;
  return res;
}
async function chk(path, validate, opts) {
  const url = base + path;
  try {
    const res = await get(url, opts);
    const buf = Buffer.from(await res.arrayBuffer());
    const info = { status: res.status, type: res.headers.get('content-type'), bytes: buf.length, location: res.headers.get('location') || undefined };
    let ok = false, extra = {};
    try { const v = await validate(res, buf); ok = !!v.ok; extra = v.info || {}; } catch (e) { extra = { err: String(e.message || e) }; }
    rec(path, ok, { ...info, ...extra });
    return { res, buf, ok };
  } catch (e) { rec(path, false, { err: String(e.message || e) }); return { ok: false }; }
}
const json = (b) => JSON.parse(b.toString('utf8'));

await chk('/', (r) => ({ ok: [301, 302, 307, 308, 200].includes(r.status) && !/vercel\.com/.test(r.headers.get('location') || ''), info: {} }));
const cp = await chk('/cloud-preview.json', (r, b) => {
  const j = json(b);
  const s = JSON.stringify(j);
  return { ok: r.status === 200 && /2025/.test(s) && /kita/i.test(s), info: { keys: Object.keys(j).slice(0, 12), hasLod2: /lod2/i.test(s), servedWardCount: j.cloudCoverage && j.cloudCoverage.servedWardCount, wards: (j.wards || []).map((w) => ({ ward: w.ward, orig: w.lod1OriginalBuildings, supp: w.lod1Buildings, excluded: w.lod1ExcludedForLod2, audit: w.idAudit && { origIds: w.idAudit.origIds, suppIds: w.idAudit.suppIds, excludedIds: w.idAudit.excludedIds, doubleDrawn: w.idAudit.doubleDrawn } })) } };
});
const idx = await chk('/ext-3dtiles/index.json', (r, b) => ({ ok: r.status === 200 && !!json(b), info: {} }));

async function tilesetAndGlb(path, dir) {
  const t = await chk(path, (r, b) => { const j = json(b); return { ok: r.status === 200 && !!j.root, info: { version: j.asset && j.asset.version } }; });
  if (!t.ok) return;
  const uris = [];
  (function walk(n) { if (!n) return; const u = n.content && (n.content.uri || n.content.url); if (u) uris.push(u); (n.children || []).forEach(walk); })(json(t.buf).root);
  if (!uris.length) { rec(path + ' glb', false, { err: 'no content uri' }); return; }
  const uri = uris[0];
  const gp = uri.startsWith('/') ? uri : dir + uri;
  await chk(gp, (r, b) => ({ ok: r.status === 200 && b.slice(0, 4).toString() === 'glTF', info: { magic: b.slice(0, 4).toString(), glbCount: uris.length } }));
}
// 配信区は index.json(なければ cloud-preview.json)から取得。ハードコードしない。
const servedWards = ((idx.ok && json(idx.buf).wards) || (cp.ok && json(cp.buf).wards) || []).map((w) => w.ward);
if (!servedWards.length) rec('served wards', false, { err: 'index.json/cloud-preview.json に wards が無い' });
for (const w of servedWards) await tilesetAndGlb('/ext-3dtiles/' + w + '/tileset.json', '/ext-3dtiles/' + w + '/');
await tilesetAndGlb('/lod2-preview/tileset.json', '/lod2-preview/');

const allOk = results.every((r) => r.ok);
console.log(JSON.stringify({ base, allOk, authRequired, passed: results.filter((r) => r.ok).length, total: results.length }));
process.exit(allOk ? 0 : 1);
