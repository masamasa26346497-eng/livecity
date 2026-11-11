#!/usr/bin/env node
// Mission 40L: one-command LOCAL preview of a locally converted ward (3D Tiles + 40G layers) in the 37G Cesium viewer.
//   node tools/mission40l-preview-local.cjs --ext ..\livecity-3dtiles-out-fukushima [--ward fukushima] [--port 8137] [--no-open]
//   node tools/mission40l-preview-local.cjs --ext ... --check     (HTTP self-test only: starts server, fetches tileset/tiles/layers, exits)
// Read-only: nothing is copied, written or deleted; data stays private (127.0.0.1 only). Not a publish step.
'use strict';
const fs = require('fs'), path = require('path'), http = require('http'), cp = require('child_process');
const { makeServer } = require('./mission40f-serve-local.cjs');
const { inspect } = require('./mission40j-stage-public.cjs');
const LAYERS = ['roads.json', 'waterways.json', 'parks.json', 'railways.json', 'layers-report.json'];

function parseArgs(argv) {
  const a = { ext: null, ward: 'fukushima', port: 8137, open: true, check: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--ext') a.ext = argv[++i]; else if (k === '--ward') a.ward = argv[++i];
    else if (k === '--port') a.port = Number(argv[++i]); else if (k === '--no-open') a.open = false;
    else if (k === '--check') { a.check = true; a.open = false; } else throw new Error('unknown argument: ' + k);
  }
  if (!a.ext) throw new Error('--ext <dir containing <ward>/tileset.json> is required');
  if (!/^[a-z0-9-]+$/.test(a.ward)) throw new Error('bad --ward');
  if (!(a.port >= 0 && a.port < 65536)) throw new Error('bad --port');
  return a;
}
function contentUris(ts) {
  const out = [];
  (function w(t) { if (!t) return; if (t.content && (t.content.uri || t.content.url)) out.push(t.content.uri || t.content.url); (t.children || []).forEach(w); })(ts.root);
  return out;
}
function get(port, p) {
  return new Promise((res) => http.get({ host: '127.0.0.1', port, path: p }, (r) => { let n = 0; r.on('data', (d) => { n += d.length; }); r.on('end', () => res({ status: r.statusCode, bytes: n })); }).on('error', () => res({ status: 0, bytes: 0 })));
}
function listen(server, port) { return new Promise((res, rej) => { server.once('error', rej); server.listen(port, '127.0.0.1', () => res(server.address().port)); }); }

async function httpCheck(port, ward, wardDir) {
  const base = '/ext-3dtiles/' + ward + '/', rep = { page: null, tileset: null, tiles: { total: 0, ok: 0, bad: [] }, layers: {}, ok: false };
  rep.page = (await get(port, '/mission37g-osaka-24ward-mvp.html')).status;
  const ts = JSON.parse(fs.readFileSync(path.join(wardDir, 'tileset.json'), 'utf8'));
  rep.tileset = (await get(port, base + 'tileset.json')).status;
  const uris = contentUris(ts);
  rep.tiles.total = uris.length;
  for (const u of uris) { const r = await get(port, base + u.replace(/^\.\//, '')); if (r.status === 200 && r.bytes > 0) rep.tiles.ok++; else rep.tiles.bad.push(u); }
  for (const f of LAYERS) rep.layers[f] = (await get(port, base + 'layers/' + f)).status;
  rep.ok = rep.page === 200 && rep.tileset === 200 && rep.tiles.total > 0 && rep.tiles.ok === rep.tiles.total && Object.values(rep.layers).every((s) => s === 200);
  return rep;
}
function openBrowser(url) {
  try {
    if (process.platform === 'win32') cp.spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', detached: true }).unref();
    else if (process.platform === 'darwin') cp.spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
    else cp.spawn('xdg-open', [url], { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  } catch (e) { /* user opens the URL by hand */ }
}

async function main(argv) {
  const a = parseArgs(argv), ext = path.resolve(a.ext), wardDir = path.join(ext, a.ward);
  const r = inspect(wardDir, a.ward);
  const bytes = r.files.reduce((s, f) => s + f.bytes, 0);
  console.log('ward dir : ' + wardDir + '\nfiles    : ' + r.files.length + ' (' + (bytes / 1048576).toFixed(2) + ' MB)\nsummary  : ' + JSON.stringify(r.summary || null));
  (r.notes || []).forEach((n) => console.log('note     : ' + n));
  if (r.problems.length) { r.problems.forEach((p) => console.error('PROBLEM  : ' + p)); return 1; }
  if (!r.summary.hasLayers) console.log('warning  : no layers/ - roads/rivers will not be drawn (run tools/mission40g-build-ward-layers.cjs)');
  const server = makeServer({ publicDir: path.join(__dirname, '..', 'public'), extDir: ext });
  const port = await listen(server, a.check ? 0 : a.port);
  const url = 'http://127.0.0.1:' + port + '/mission37g-osaka-24ward-mvp.html?ext=' + a.ward + '&bw=' + r.summary.wardCode;
  if (a.check) {
    const rep = await httpCheck(port, a.ward, wardDir);
    console.log(JSON.stringify(rep, null, 2));
    server.close();
    return rep.ok ? 0 : 1;
  }
  console.log('\nLocal preview (read-only, this PC only): ' + url + '\nCtrl+C to stop.\nIn the page console: __mission37g.stats.wardVec / stats.extraSets');
  if (a.open) openBrowser(url);
  return new Promise(() => {});
}
module.exports = { parseArgs, contentUris, httpCheck, main };
if (require.main === module) main(process.argv.slice(2)).then((c) => process.exit(c), (e) => { console.error('ERROR: ' + e.message); process.exit(2); });
