'use strict';
// Mission 44A: ブラウザ描画 E2E の配線テスト。
//   既定: 静的チェック（スクリプトの存在、Google/有料通信なし、実データを公開しない、ビューアの導線）。高速・ブラウザ不要。
//   実ブラウザ E2E は MISSION44A_E2E=1 のときだけ spawn する（Chrome と CesiumJS CDN への接続が必要）。
//     MISSION44A_E2E=1 node --test tests/mission44a-render-e2e.test.cjs
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const page = read('public/mission37g-osaka-24ward-mvp.html');

test('E2E scripts exist, are read-only wrt data, and use no Google / paid endpoints', () => {
  for (const f of ['tools/experiments/mission44a_render_e2e.mjs', 'tools/experiments/mission44a_ext_e2e.mjs']) {
    const s = read(f);
    assert.ok(!/places\.googleapis|maps\.googleapis|api[_-]?key/i.test(s), f);
    assert.ok(!/git (add|push)|upload|artifact/i.test(s.replace(/\/\/.*$/gm, '')), f + ' must not publish');
  }
  assert.ok(/googleRequests/.test(read('tools/experiments/mission44a_render_e2e.mjs')));
});

test('render E2E covers exactly the 6 Git-tracked partial wards and requires a pixel difference', () => {
  const s = read('tools/experiments/mission44a_render_e2e.mjs');
  for (const n of ['住吉区', '北区', '中央区', '天王寺区', '西区', '浪速区']) assert.ok(s.includes(n), n);
  assert.ok(/pct >= 1\.0/.test(s) && /glb200 >= 1/.test(s) && /userPath\.focused/.test(s));
  // every directory the script reads is a Git-tracked tileset dir
  for (const m of s.matchAll(/dir: '([^']+)'/g)) assert.ok(fs.existsSync(path.join(ROOT, m[1], 'attrs')), m[1]);
});

test('viewer: selecting a ward focuses the mounted buildings; unmounted wards stay "3D未整備"', () => {
  assert.ok(/flyToBoundingSphere\(sphere/.test(page) && /setBuildingWard\(w\.wardCode\)\.then/.test(page));
  assert.ok(/3D建物未整備/.test(page) && /（3D一部）/.test(page) && /（3D未整備）/.test(page));
  assert.ok(/cameraVsTilesets/.test(page));
  // QA hooks stay localhost+qa only
  assert.ok(/qa'\) === '1'|get\('qa'\) === '1'/.test(page));
});

test('ext (43G) wiring: viewer matches source.json.wardCode and ?ext= is localhost-only', () => {
  assert.ok(/source\.wardCode === wardCode/.test(page));
  assert.ok(/localhost|127\.0\.0\.1/.test(page.slice(page.indexOf('40F: ローカル変換'), page.indexOf('40F: ローカル変換') + 600)));
});

test('real-browser E2E (opt-in: MISSION44A_E2E=1)', { skip: process.env.MISSION44A_E2E !== '1' }, () => {
  for (const f of ['mission44a_render_e2e.mjs', 'mission44a_ext_e2e.mjs']) {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'tools/experiments', f)], { cwd: ROOT, encoding: 'utf8', timeout: 900000 });
    assert.strictEqual(r.status, 0, f + '\n' + (r.stdout || '').slice(-1500) + (r.stderr || '').slice(-500));
  }
});
