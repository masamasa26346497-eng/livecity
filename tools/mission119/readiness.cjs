#!/usr/bin/env node
'use strict';
// Mission 119: read-only 24-ward readiness matrix for the combined viewer (2025 buildings + 45I layers, Mission116/118 server).
//   node tools/mission119/readiness.cjs --buildings-root <dir> --layers-root <dir> [--supplemental-layers-root <dir> [--layers-prefer primary|supplemental]] [--http] [--out file.json]
// For each of the 24 N03 wards it reports, from files (and with --http, from real loopback HTTP responses of the Mission116 server):
//   buildings : <ward>25/tileset.json present, tile count (tiles/*.glb), ids sidecar count
//   layers    : which root serves it (primary/supplemental), clipVersion, features per layer; features are split into LINE vs AREA (water polygons)
//   outside   : layer vertices outside the ward bbox (reported only; no coordinate is ever shifted or changed)
//   http      : status of tileset.json + every layer file via /ext-3dtiles/ (200 + parseable JSON), only with --http
// Verdict: both-servable | buildings-only | layers-only(not served) | neither. browserAccepted is ALWAYS false: WebGL needs a look on the owner PC.
// Writes only the optional --out JSON (new file). Never copies, deletes or uploads. No network except 127.0.0.1.
const fs = require('fs');
const path = require('path');
const http = require('http');
const S = require('../mission116/combined-server.cjs');
const ROOT = path.resolve(__dirname, '..', '..');
const LAYERS = ['roads', 'waterways', 'parks', 'railways'];
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; } };
const count = (d, re) => { try { return fs.readdirSync(d).filter((n) => re.test(n)).length; } catch (e) { return 0; } };

function layerStats(dir, bbox) {
  const out = {};
  for (const l of LAYERS) {
    const j = readJson(path.join(dir, l + '.json'));
    if (!j) { out[l] = null; continue; }
    const feats = j.features || [];
    let lines = 0, areas = 0, verts = 0, outside = 0;
    for (const f of feats) {
      if (f.kind === 'area') areas++; else lines++;
      for (const q of f.p || []) {
        verts++;
        if (bbox && (q[0] < bbox.minX - 1 || q[0] > bbox.maxX + 1 || q[1] < bbox.minZ - 1 || q[1] > bbox.maxZ + 1)) outside++;
      }
    }
    out[l] = { features: feats.length, lines, areas, vertices: verts, outsideBBox: outside };
  }
  return out;
}
function get(port, p) {
  return new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port, path: p, headers: { Host: '127.0.0.1:' + port } }, (r) => {
      const b = [];
      r.on('data', (c) => b.push(c));
      r.on('end', () => {
        const buf = Buffer.concat(b);
        let parsable = null;
        if (/\.json$/.test(p)) { try { JSON.parse(buf.toString('utf8')); parsable = true; } catch (e) { parsable = false; } }
        resolve({ status: r.statusCode, bytes: buf.length, parsable });
      });
    }).on('error', () => resolve({ status: 0, bytes: 0, parsable: null }));
  });
}
async function readiness(o) {
  const p = S.plan(o);
  const wards = readJson(path.join(ROOT, 'public/mission37g-data/osaka-24-wards.json')).wards;
  const srv = o.http ? await S.listen(p, 0) : null;
  const rows = [];
  for (const w of wards) {
    const id = w.wardId, bDir = path.join(p.buildingsRoot, id + p.suffix);
    const hasB = p.buildingWards.includes(id), src = p.layerSrc[id] || null;
    const row = {
      ward: id, wardCode: w.wardCode,
      buildings: hasB ? { tileset: true, tiles: count(path.join(bDir, 'tiles'), /\.glb$/), ids: count(path.join(bDir, 'ids'), /\.json$/) } : null,
      layers: src ? { source: src.role, clipVersion: src.clipVersion, stats: layerStats(src.dir, w.bbox) } : null
    };
    row.verdict = hasB && src ? 'both-servable' : hasB ? 'buildings-only' : src ? 'layers-only(not served)' : 'neither';
    row.layerVerticesOutsideBBox = row.layers ? Object.values(row.layers.stats).reduce((a, s) => a + (s ? s.outsideBBox : 0), 0) : 0;
    if (row.layers && src.clipVersion >= 2 && row.layerVerticesOutsideBBox > 0) row.verdict += ' + CLIP-V2-VIOLATION';
    if (srv && row.verdict.startsWith('both')) {
      const base = '/ext-3dtiles/' + id + p.suffix + '/', h = { 'tileset.json': await get(srv.port, base + 'tileset.json') };
      for (const l of LAYERS) if (row.layers.stats[l]) h['layers/' + l + '.json'] = await get(srv.port, base + 'layers/' + l + '.json');
      row.http = h;
      if (Object.values(h).some((x) => x.status !== 200 || x.parsable === false)) row.verdict += ' + HTTP-FAIL';
    }
    row.browserAccepted = false;
    rows.push(row);
  }
  if (srv) await new Promise((r) => srv.server.close(r));
  const n = (re) => rows.filter((r) => re.test(r.verdict)).length;
  return {
    schema: 'livecity.mission119.readiness/1', wards: rows.length, bothServable: n(/^both-servable$/), buildingsOnly: n(/^buildings-only/),
    layersOnlyNotServed: n(/^layers-only/), neither: n(/^neither/),
    problems: rows.filter((r) => /VIOLATION|FAIL/.test(r.verdict)).map((r) => r.ward + ': ' + r.verdict),
    overridden: p.overridden, browserAcceptedWards: 0, rows
  };
}
function main() {
  const a = process.argv.slice(2), opt = (k) => { const i = a.indexOf('--' + k); return i >= 0 ? a[i + 1] : undefined; };
  readiness({ buildingsRoot: opt('buildings-root'), layersRoot: opt('layers-root'), supplementalLayersRoot: opt('supplemental-layers-root'), layersPrefer: opt('layers-prefer'), suffix: opt('suffix'), http: a.includes('--http') })
    .then((r) => {
      console.log(r.rows.map((x) => x.ward + ' ' + x.verdict + (x.buildings ? ' tiles=' + x.buildings.tiles : '') +
        (x.layers ? ' layers=' + x.layers.source + ':v' + x.layers.clipVersion + ' waterLines=' + ((x.layers.stats.waterways || {}).lines || 0) + ' waterAreas=' + ((x.layers.stats.waterways || {}).areas || 0) : '')).join('\n'));
      console.log(JSON.stringify({ wards: r.wards, bothServable: r.bothServable, buildingsOnly: r.buildingsOnly, layersOnlyNotServed: r.layersOnlyNotServed, neither: r.neither, problems: r.problems, browserAcceptedWards: 0 }));
      if (opt('out')) fs.writeFileSync(opt('out'), JSON.stringify(r, null, 1), { flag: 'wx' });
      process.exit(r.problems.length ? 1 : 0);
    }, (e) => { console.error('ERROR: ' + e.message); process.exit(Number.isInteger(e.code) ? e.code : 1); });
}
module.exports = { readiness, layerStats };
if (require.main === module) main();
