'use strict';
// Mission 160: READ-ONLY audit of a locally built PLATEAU 2025 Nishi-ward tileset (output of tools/mission79-run.mjs).
// Static file checks only: it never launches a browser, never fetches, never writes inside <dir>.
// Result.scope is always 'static-files'; browser acceptance is a separate tool (tools/experiments/mission160_nishi2025_browser.mjs).
const fs = require('fs');
const path = require('path');
const { insideWard } = require('../mission130/accept-lib.cjs');

const WARD = { id: 'nishi', code: '27106' };
const EXPECT = { buildings: 12603, tiles: 30, vintage: 2025 }; // Mission 79 README (reported by the runner)

function collectUris(node, out) {
  if (!node || typeof node !== 'object') return out;
  if (node.content && node.content.uri) out.push(node.content.uri);
  for (const c of node.children || []) collectUris(c, out);
  return out;
}
function glbInfo(file) {
  const fd = fs.openSync(file, 'r');
  const b = Buffer.alloc(12);
  const n = fs.readSync(fd, b, 0, 12, 0);
  fs.closeSync(fd);
  if (n < 12 || b.toString('latin1', 0, 4) !== 'glTF') return { ok: false, reason: 'bad-magic' };
  const declared = b.readUInt32LE(8), actual = fs.statSync(file).size;
  return declared === actual ? { ok: true, bytes: actual } : { ok: false, reason: 'length-mismatch', declared, actual };
}
function readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; } }
const INFO = / \(informational\)$/;

/** @param {string} dir  <root>/nishi-2025 (contains tileset.json) */
function audit(dir, opts = {}) {
  const checks = [];
  const add = (id, ok, detail) => checks.push({ id, ok: !!ok, detail });
  const root = path.resolve(dir);
  const res = { mission: '160', scope: 'static-files', dir: root, fixture: !!opts.fixture, ownerPcBrowserAccepted: false,
    note: 'File-level checks only. Not a browser acceptance; a fixture/CI run says nothing about the owner PC.', checks };
  const ts = readJson(path.join(root, 'tileset.json'));
  add('tileset.json present and parseable', !!ts, ts ? undefined : 'missing/invalid');
  if (!ts) return finish(res);

  const uris = collectUris(ts.root, []);
  const detail = uris.filter((u) => u.startsWith('tiles/')), coarse = uris.filter((u) => u.startsWith('lod/'));
  res.tiles = { detail: detail.length, coarse: coarse.length, referenced: uris.length };
  const bad = [];
  for (const u of uris) {
    const f = path.join(root, u);
    if (!fs.existsSync(f)) { bad.push({ uri: u, reason: 'missing' }); continue; }
    const g = glbInfo(f);
    if (!g.ok) bad.push({ uri: u, reason: g.reason });
  }
  add('every referenced GLB exists with valid glTF header + length', bad.length === 0 && uris.length > 0, bad.slice(0, 10));
  add('both detail tiles (tiles/) and coarse LOD (lod/) are referenced', detail.length > 0 && coarse.length > 0, res.tiles);

  const src = readJson(path.join(root, 'source.json')) || {};
  res.sourceVintage = { vintage: src.vintage ?? null, standard: src.standard ?? null, source: src.source ?? null, etag: src.sourceEtag ?? null,
    wardCode: src.wardCode ?? null, license: src.license ?? null, attribution: src.attribution ?? null, sourceMeshes: (src.sourceMeshes || []).length, counts: src.counts ?? null };
  add('source.json says PLATEAU vintage 2025', src.vintage === EXPECT.vintage, src.vintage);
  add('source.json wardCode is ' + WARD.code + ' (not 27999 Expo)', String(src.wardCode) === WARD.code, src.wardCode);
  add('license and attribution recorded', !!src.license && !!src.attribution, undefined);

  // attrs / ids
  const byId = new Map();
  const attrsDir = path.join(root, 'attrs'), idsDir = path.join(root, 'ids');
  const attrFiles = fs.existsSync(attrsDir) ? fs.readdirSync(attrsDir).filter((f) => f.endsWith('.json')) : [];
  let idsListed = 0, dup = 0;
  for (const f of attrFiles) {
    const j = readJson(path.join(attrsDir, f));
    for (const [id, a] of Object.entries((j && j.byId) || {})) { if (byId.has(id)) dup++; byId.set(id, a); }
  }
  if (fs.existsSync(idsDir)) {
    for (const f of fs.readdirSync(idsDir).filter((x) => x.endsWith('.json'))) { const j = readJson(path.join(idsDir, f)); idsListed += Array.isArray(j) ? j.length : 0; }
  }
  res.buildings = { attrs: byId.size, idsListed, duplicateIds: dup, expectedReported: EXPECT.buildings };
  add('attrs building count > 0 and IDs unique', byId.size > 0 && dup === 0, res.buildings);
  add('ids sidecar count equals attrs count', idsListed === byId.size, { idsListed, attrs: byId.size });
  add('canonical IDs are bldg_* (gml:id verbatim)', [...byId.keys()].every((k) => /^bldg_/.test(k)), undefined);
  add('building count equals Mission 79 reported ' + EXPECT.buildings + ' (informational)', byId.size === EXPECT.buildings, byId.size);

  // ward boundary / coordinates: attrs fields = [h, usage, repX, repZ, z0] (znorth-neg-v1 metres)
  const polys = readJson(path.join(__dirname, '../../data/processed/osaka-city/boundaries/ward-classification-polygons.json'));
  const ward = polys && polys.wards.find((w) => w.wardId === WARD.id);
  add('N03 Nishi polygon available in repo', !!ward && String(ward.wardCode) === WARD.code, undefined);
  if (ward && byId.size) {
    let inside = 0, finite = 0, sentinel = 0, minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, hmax = 0;
    for (const a of byId.values()) {
      const h = a[0], x = a[2], z = a[3];
      if (Number.isFinite(x) && Number.isFinite(z)) {
        finite++;
        if (insideWard(ward, x, z)) inside++;
        minX = Math.min(minX, x); maxX = Math.max(maxX, x); minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
      }
      if (Number.isFinite(h)) hmax = Math.max(hmax, h);
      if (h >= 29997) sentinel++;
    }
    const b = ward.bbox, pct = +(inside / byId.size * 100).toFixed(2);
    res.coverage = { repPointsFinite: finite, repPointsInsideN03Pct: pct, buildingsBBox: { minX, maxX, minZ, maxZ }, wardBBox: b,
      buildingsBBoxInsideWardBBox: minX >= b.minX && maxX <= b.maxX && minZ >= b.minZ && maxZ <= b.maxZ,
      maxHeightM: hmax, heightSentinels: sentinel, convention: src.coordinateConvention || null };
    add('all representative points are finite', finite === byId.size, finite);
    add('>= 99% of representative points fall inside the N03 Nishi polygon', pct >= 99, pct);
    add('no height sentinel (>=29997 m)', sentinel === 0, sentinel);
  }
  const al = readJson(path.join(root, 'alignment.json'));
  if (al) add('Mission 79 orientation scan found no flip/rotation', al.orientationOk === true || al.bestTransform === 'identity', al.bestTransform);
  return finish(res);
}
function finish(res) {
  res.pass = res.checks.every((c) => c.ok || INFO.test(c.id));
  res.failed = res.checks.filter((c) => !c.ok && !INFO.test(c.id)).map((c) => c.id);
  return res;
}

module.exports = { audit, collectUris, glbInfo, WARD, EXPECT };

if (require.main === module) {
  const a = process.argv.slice(2), get = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : null; };
  const dir = get('--dir');
  if (!dir) { console.error('usage: --dir <root>/nishi-2025 [--out <report.json>]'); process.exit(2); }
  const r = audit(dir);
  const out = get('--out') || path.join('data', 'reports', 'mission160-nishi2025', 'static-audit-local.json');
  if (path.resolve(out).startsWith(path.resolve(dir) + path.sep)) { console.error('refusing to write the report inside the tileset dir'); process.exit(2); }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(r, null, 1));
  for (const c of r.checks) console.log((c.ok ? 'OK   ' : 'FAIL ') + c.id);
  console.log('static audit: ' + (r.pass ? 'PASS' : 'FAIL') + ' (file-level only; owner-PC browser acceptance NOT done) -> ' + out);
  process.exit(r.pass ? 0 : 1);
}
