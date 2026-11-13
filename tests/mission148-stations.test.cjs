'use strict';
// Mission 148: station operator source (ward layers) / label opacity / no-store fetch. Static + builder unit tests (browser E2E: tools/experiments/mission148_station_operator_e2e.mjs).
const test = require('node:test'), assert = require('node:assert'), fs = require('fs'), os = require('os'), path = require('path');
const { execFileSync } = require('child_process');
const html = fs.readFileSync('public/mission37g-osaka-24ward-mvp.html', 'utf8');
const stLayer = html.slice(html.indexOf('const stationLayer = {'), html.indexOf('LayerRegistry.register(stationLayer)'));

test('station labels: no distance fade, opaque white name, separate operator label', () => {
  assert.ok(!/translucencyByDistance:/.test(stLayer), 'station labels must not fade with distance');
  assert.match(stLayer, /fillColor: Cesium\.Color\.WHITE/);
  assert.match(stLayer, /text: opText/);
});
test('station json is fetched with no-store and the operator-connected file wins', () => {
  assert.match(stLayer, /cache: 'no-store'/);
  assert.match(stLayer, /operatorData && c\.operatorData\.connected/);
});
test('unresolved reasons are distinguished (not connected vs no evidence)', () => {
  assert.match(html, /路線データ未接続/);
  assert.match(html, /運営会社の記載なし/);
});
test('builder resolves operators from per-ward layers/railways.json (read-only)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lc148t-'));
  const all = JSON.parse(fs.readFileSync('public/mission145-data/stations-24.json', 'utf8')).stations;
  const s = all.find((x) => x.name === '住吉大社');
  fs.mkdirSync(path.join(tmp, 'sumiyoshi', 'layers'), { recursive: true });
  const f = path.join(tmp, 'sumiyoshi', 'layers', 'railways.json');
  fs.writeFileSync(f, JSON.stringify({ features: [{ id: 'a', railway: 'rail', name: '南海電気鉄道南海本線', p: [[s.x - 50, s.z], [s.x + 50, s.z]] }] }));
  const before = fs.readFileSync(f, 'utf8'), out = path.join(tmp, 'o.json');
  execFileSync(process.execPath, ['tools/mission145-build-stations.cjs', '--layers-root', tmp, '--out', out]);
  const j = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.ok(j.operatorData.connected && j.operatorData.wardLayers);
  assert.deepStrictEqual(j.stations.find((x) => x.name === '住吉大社').operators.map((o) => o.id), ['nankai']);
  assert.ok(j.stations.filter((x) => !x.operators.length).length > 200, 'others stay unknown (nothing guessed)');
  assert.strictEqual(fs.readFileSync(f, 'utf8'), before);
  fs.rmSync(tmp, { recursive: true, force: true });
});
test('launcher falls back to the ward layers root and rebuilds a stale local.json', () => {
  const m = fs.readFileSync('tools/mission141-local-24.mjs', 'utf8');
  assert.match(m, /discoverLayersRoot\(\)/);
  assert.match(m, /--layers-root/);
  assert.match(m, /stale/);
});
