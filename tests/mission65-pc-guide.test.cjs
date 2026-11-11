'use strict';
// [Mission 65] ガイドに書いた QA フック名・URL パラメータが実在し、サーバーが --ext なしで起動できること。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const guide = fs.readFileSync('MISSION65_PC_QA_GUIDE.md', 'utf8');
const html = fs.readFileSync('public/mission37g-osaka-24ward-mvp.html', 'utf8');
const srv = fs.readFileSync('tools/mission40f-serve-local.cjs', 'utf8');
test('every __mission37dQA.<name> in the guide exists in the QA hook block', () => {
  const gate = html.indexOf("get('qa') === '1'");
  const names = new Set([...guide.matchAll(/__mission37dQA\.(\w+)/g)].map((m) => m[1]));
  assert.ok(names.size > 8);
  for (const n of names) assert.ok(html.indexOf(n, gate) > gate, n);
});
test('guide URL params exist in the page', () => {
  for (const p of ['qa', 'basemap', 'extra', 'fac', 'bw', 'vcull', 'panel']) assert.ok(html.includes("get('" + p + "')"), p);
});
test('server --ext is optional and stays read-only loopback', () => {
  assert.match(srv, /--ext is optional/);
  assert.match(srv, /127\.0\.0\.1/);
  assert.match(srv, /405/);
  assert.ok(!/writeFile|unlink|rmSync/.test(srv));
});
test('guide has no secrets and declares hooks disabled on Vercel', () => {
  assert.match(guide, /Disabled/);
  assert.ok(!/api[_-]?key\s*=|token\s*=/i.test(guide));
});

// [Mission 67] main 安全制約 / QA ゲート / ピクセル座標の整合
test('guide section 1 never merges blindly and protects local main', () => {
  const sec = guide.slice(guide.indexOf('## 1.'), guide.indexOf('## 2.'));
  assert.match(sec, /git status --short --branch/);
  assert.match(sec, /git switch --track -c \$local \$remote/);
  assert.match(sec, /git switch \$local/);
  assert.match(sec, /git merge --ff-only \$remote/);
  assert.match(sec, /never run `git merge` \/ `git pull`/);
  assert.match(sec, /local `main` is not changed/);
  assert.ok(!/^git merge --ff-only origin/m.test(sec), 'bare merge line must be gone');
  const rest = sec.replace(/never run `git merge` \/ `git pull`/, '');
  assert.ok(!/git pull|reset --hard|--force|git push/.test(rest));
  // the only merge must come after switching to the local PR branch
  assert.ok(sec.indexOf('git switch $local') < sec.indexOf('git merge --ff-only $remote'));
});
test('probe pixel contract: clientX/Y minus canvas rect (CSS px), as the guide states', () => {
  const gate = html.indexOf("get('qa') === '1'");
  const blk = html.slice(gate, html.indexOf('new Cesium.ScreenSpaceEventHandler(scene.canvas)', gate));
  assert.match(blk, /rect = \(\) => scene\.canvas\.getBoundingClientRect\(\)/);
  assert.match(blk, /probe\(px, py\) \{\s*const r = rect\(\), win = new Cesium\.Cartesian2\(px - r\.left, py - r\.top\)/);
  assert.match(blk, /pickLocal\(px, py\)[\s\S]{0,250}px - r\.left, py - r\.top/);
  const probeSrc = blk.slice(blk.indexOf('probe(px, py)'), blk.indexOf('probePair(a, b)'));
  assert.ok(!/devicePixelRatio|resolutionScale/.test(probeSrc), 'no DPR scaling inside probe');
  assert.match(guide, /CSS-pixel `clientX\/clientY`/);
  assert.match(guide, /screenshotX \/ devicePixelRatio/);
});
test('two-click recorder removes itself and does not stop events', () => {
  const sec = guide.slice(guide.indexOf('## 8b.'));
  assert.match(sec, /removeEventListener\('pointerdown'/);
  assert.match(sec, /removeEventListener\('pointerup'/);
  assert.match(sec, /__mission37dQA\.probePair/);
  assert.ok(!/stopPropagation|preventDefault/.test(sec.replace(/do not stop propagation/, '')));
});
test('guide states what is still unmeasured', () => {
  assert.match(guide, /no screenshot and no probe JSON has been obtained yet/);
  assert.match(guide, /independent horizontal error is not measured/);
  assert.match(guide, /unresolved/i);
});
