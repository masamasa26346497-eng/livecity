'use strict';
// Mission 130: pure helpers for the PRIVATE 21-ward Cesium acceptance runner (accept21.mjs). No network, no writes except the optional report.
// Nothing here proves acceptance by itself: a ward is accepted only from a row produced by a real browser run (verdict()).
const fs = require('fs');
const path = require('path');
const http = require('http');
const ROOT = path.resolve(__dirname, '..', '..');
const P = require('../mission43g-local-preview.cjs');
const W = require('../mission129/wards21.cjs');
const NAME = /^[a-z0-9-]+$/;
const lst = (p) => { try { return fs.lstatSync(p); } catch (e) { return null; } };

/** Finds the directory holding tileset.json for a ward, without assuming the layout. Real dirs only (no links), depth <= 3. */
const LAYOUT = require('../mission131/layout.cjs');
// Mission131: the shared discovery (exact segment match, any depth <= 4) replaces the old depth-limited search below.
const discoverWard = (root, ward) => LAYOUT.discoverWard(root, ward);
// eslint-disable-next-line no-unused-vars
function discoverWardLegacy(root, ward) {
  const tryDir = (d) => { const s = lst(path.join(d, 'tileset.json')); return s && s.isFile() && !s.isSymbolicLink(); };
  for (const n of [ward + '25', ward, 'plateau2025-' + ward, '_x_' + ward]) {
    const d = path.join(root, n);
    if (tryDir(d)) return { dir: d, rel: n, layout: n === ward + '25' ? 'expected(<ward>25)' : 'alt(' + n.replace(ward, '<ward>') + ')' };
  }
  const hits = [];
  (function walk(d, depth) {
    if (depth > 3) return;
    let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const e of es) {
      if (!e.isDirectory() || e.isSymbolicLink()) continue;
      const c = path.join(d, e.name);
      if (tryDir(c) && c.toLowerCase().split(path.sep).some((s) => [ward, ward + '25', 'plateau2025-' + ward, '_x_' + ward].includes(s))) hits.push(c);
      else walk(c, depth + 1);
    }
  })(root, 1);
  if (hits.length === 1) return { dir: hits[0], rel: path.relative(root, hits[0]), layout: 'nested' };
  if (hits.length > 1) return { dir: null, rel: null, layout: 'ambiguous', candidates: hits.length };
  return null;
}
/** Describes (does not dump) a root: top-level directory names only, so the layout can be diagnosed from CI logs. */
function describeRoot(root) {
  let es = []; try { es = fs.readdirSync(root, { withFileTypes: true }); } catch (e) { return { exists: false }; }
  const dirs = es.filter((e) => e.isDirectory()).map((e) => e.name).sort();
  return { exists: true, topLevelDirs: dirs.length, sample: dirs.slice(0, 8), files: es.filter((e) => e.isFile()).length };
}
function readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; } }
/** ids from ids/*.json and building attrs from attrs/*.json ([h, ?, x, z]) of one ward dir. */
function loadWardData(dir) {
  const ids = new Set(); let dup = 0;
  const li = (d) => { try { return fs.readdirSync(path.join(dir, d)).filter((n) => n.endsWith('.json')).sort(); } catch (e) { return []; } };
  for (const f of li('ids')) { if (/^g_/.test(f)) continue; /* Mission132: LOD-group sidecars repeat child ids */ const a = readJson(path.join(dir, 'ids', f)); if (Array.isArray(a)) for (const id of a) { if (ids.has(id)) dup++; else ids.add(id); } }
  const byId = {};
  for (const f of li('attrs')) { const j = readJson(path.join(dir, 'attrs', f)); if (j && j.byId) Object.assign(byId, j.byId); }
  return { ids, dup, byId, source: readJson(path.join(dir, 'source.json')) };
}
function pip(x, z, ring) {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i], [xj, zj] = ring[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c;
  }
  return c;
}
function insideWard(w, x, z) {
  const b = w.bbox;
  if (!(x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ)) return false;
  return (w.polygons || []).some((p) => pip(x, z, p.outer) && !(p.holes || []).some((h) => pip(x, z, h)));
}
/** Coverage vs the N03-ward reference count (osaka-24-wards.json sourceBuildings = legacy PLATEAU 2024 manifest; NOT authoritative for 2025). */
function coverage(idCount, ref) {
  if (!ref || !idCount) return { ratio: null, class: 'unknown', note: 'no reference or no ids' };
  const ratio = +(idCount / ref).toFixed(3);
  return { ratio, ref, class: ratio >= 0.95 && ratio <= 1.25 ? 'full-candidate' : 'partial', note: 'reference is the 2024 legacy manifest; "full-candidate" is not a proof of completeness' };
}
function verdict(r) {
  const why = [];
  if (!r.source || !r.source.found) why.push('no-source');
  else {
    if (!r.http || r.http.tileset200 < 1) why.push('no-tileset-200');
    if (!r.http || r.http.glb200 < 1) why.push('no-glb-200');
    if (r.http && r.http.notFound > 0) why.push('http-404');
    if (!(r.tilesets >= 1) || r.state !== 'ready') why.push('not-mounted');
    if (!r.pixels || !(r.pixels.pct >= 1.0)) why.push('no-pixel-diff');
    if (!r.click || r.click.selected !== r.click.target) why.push('click-id-mismatch' + (r.click && r.click.reason ? '(' + r.click.reason + ')' : ''));
    else if (!r.click.idInSidecar) why.push('click-id-not-in-sidecar');
    else if (!r.click.insideWardPolygon) why.push('click-outside-ward');
    if (r.dupIds) why.push('duplicate-ids');
  }
  return { accepted: why.length === 0, why };
}
function summarize(rows, extra) {
  const accepted = rows.filter((r) => r.verdict && r.verdict.accepted).map((r) => r.ward);
  return Object.assign({
    schema: 'livecity.mission130.acceptance/1', targetWards: rows.length, acceptedWards: accepted.length, accepted,
    notAccepted: rows.filter((r) => !(r.verdict && r.verdict.accepted)).map((r) => r.ward + ':' + ((r.verdict && r.verdict.why) || ['not-run']).join('+')),
    existingThreeWards: 'not-evaluated (nishi, fukushima, yodogawa are NOT inferred)',
    twentyFourOfTwentyFourProven: false, rows,
  }, extra || {});
}
/** Loopback-only read-only server: public/ statics + /ext-3dtiles/<ward>25/<allowed file> from the DISCOVERED dir. Logs tileset/glb responses. */
function makeServer(map, hits, getPort, uris) {
  return http.createServer((req, res) => {
    const deny = (c) => { res.writeHead(c, { 'Content-Type': 'text/plain' }); res.end('x'); };
    if (req.method !== 'GET' && req.method !== 'HEAD') return deny(405);
    if (!P.hostOk(req.headers.host, getPort()) || !P.originOk(req.headers.origin, getPort())) return deny(403);
    const u = (req.url || '/').split('?')[0], pre = '/ext-3dtiles/';
    let file = null;
    if (u.startsWith(pre)) {
      let dec; try { dec = decodeURIComponent(u.slice(pre.length)); } catch (e) { return deny(404); }
      const i = dec.indexOf('/'), name = dec.slice(0, i), rel = dec.slice(i + 1), ward = name.slice(0, -2);
      if (i > 0 && !dec.includes('..') && !dec.includes('\\') && NAME.test(name) && name.endsWith('25') && map[ward] && (P.ALLOWED.some((re) => re.test(rel)) || (uris && uris[ward] && uris[ward].has(rel)))) {
        const base = map[ward], f = path.join(base, ...rel.split('/')), st = lst(f);
        if (st && st.isFile() && !st.isSymbolicLink() && fs.realpathSync(f).startsWith(fs.realpathSync(base) + path.sep)) file = f;
      }
      if (i > 0 && NAME.test(name) && name.endsWith('25') && /(tileset\.json|\.glb)$/.test(rel)) hits.push({ ward, u: rel, s: file ? 200 : 404 });
    } else file = P.resolveStatic(u === '/' ? '/mission37g-osaka-24ward-mvp.html' : u);
    if (!file) return deny(404);
    const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.glb': 'model/gltf-binary', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.css': 'text/css' }[path.extname(file).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-store' });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
  });
}
module.exports = { LAYOUT, ROOT, discoverWard, describeRoot, loadWardData, insideWard, coverage, verdict, summarize, makeServer, target21: W.target21 };
