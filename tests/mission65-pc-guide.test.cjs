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
