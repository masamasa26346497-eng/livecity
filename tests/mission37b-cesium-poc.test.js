'use strict';
// Mission 37B: Cesium POC ページの静的ガード（ブラウザ・ネットワーク不要）。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const pub = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(pub, 'mission37b-livecity-cesium-tiles.html'), 'utf8');

test('POC は Google API キー / ion トークンに依存しない', () => {
  assert.ok(!/maps\.googleapis|tile\.googleapis|GOOGLE_MAP|photorealistic/i.test(html.replace(/<!--[\s\S]*?-->/g, '')));
  assert.ok(!/defaultAccessToken\s*=\s*['"][A-Za-z0-9._-]{20,}/.test(html));
});

test('既存タイルを fetch し canonicalId を GeometryInstance.id に保持する', () => {
  assert.match(html, /map-data\/osaka-city\/buildings\//);
  assert.match(html, /id:\s*b\.id/);
  assert.match(html, /znorth-neg-v1/);
});

test('geoToThree と同一の投影定数を使う', () => {
  assert.match(html, /SEARCH_CLAT = 34\.604208/);
  assert.match(html, /SEARCH_CLON = 135\.525020/);
  assert.match(html, /SEARCH_MPD = 111320/);
});

test('既定ブロックのタイルが既存 manifest に存在する', () => {
  const m = JSON.parse(fs.readFileSync(path.join(pub, 'map-data/osaka-city/buildings/osaka-sumiyoshi/manifest.json'), 'utf8'));
  const n = m.tiles.filter(t => t.tx >= -6 && t.tx <= -4 && t.tz >= -3 && t.tz <= -1);
  assert.strictEqual(n.length, 9);
});
