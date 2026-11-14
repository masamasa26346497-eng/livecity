'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const probe = fs.readFileSync(path.join(root, 'tools/cloud/perf-probe.js'), 'utf8');
const build = fs.readFileSync(path.join(root, 'tools/cloud/build-cloud-preview.mjs'), 'utf8');

test('M212: perf-probe は構文的に有効で外部送信を持たない', () => {
  assert.doesNotThrow(() => new Function(probe));
  assert.ok(!/sendBeacon|XMLHttpRequest|fetch\(|localStorage|cookie/.test(probe), '計測は端末内のみ(送信・永続化なし)');
});
test('M212: 失敗の可視化(resource error / 20秒未起動)が入っている', () => {
  assert.match(probe, /addEventListener\('error'[\s\S]*true\)/);
  assert.match(probe, /20000/);
});
test('M212: ビルドが先読みヒントとプローブを head に注入し、プローブを配信物へコピーする', () => {
  assert.match(build, /rel="preconnect" href="https:\/\/cdn\.jsdelivr\.net"/);
  assert.match(build, /rel="preload" as="script"[^']*cesium@1\.121\.1/);
  assert.match(build, /as="fetch" href="\/ext-3dtiles\/index\.json"/);
  assert.match(build, /cloud-perf-probe\.js/);
});
test('M212: 先読みする Cesium のバージョンは 37G HTML が読むものと一致', () => {
  const html = fs.readFileSync(path.join(root, 'public/mission37g-osaka-24ward-mvp.html'), 'utf8');
  assert.ok(html.includes('cesium@1.121.1/Build/Cesium/Cesium.js'));
});
