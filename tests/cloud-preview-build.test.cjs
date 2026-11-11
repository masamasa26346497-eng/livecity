'use strict';
// Mission 196B: cloud-preview ビルドの静的な安全性チェック(ネットワーク不要)。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const build = fs.readFileSync(path.join(ROOT, 'tools/cloud/build-cloud-preview.mjs'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'public/mission37g-osaka-24ward-mvp.html'), 'utf8');

test('37G HTML の localhost ゲートが build 側の置換書式と一致する(各 1 箇所)', () => {
  const LH = String.raw`/^(localhost|127\.0\.0\.1)$/.test(location.hostname)`;
  for (const s of [LH + " && q.get('ext45') === '1'", LH + " && q.get('lod2') === '1'",
    LH + " && new URLSearchParams(location.search).get('nobuiltin') === '1'",
    '!' + LH + " || new URLSearchParams(location.search).get('ext45') !== '1'",
    "const r = await fetch(TILES_BASE + 'build-report.json');\n      if (!r.ok) return;"]) {
    assert.strictEqual(html.split(s).length - 1, 1, s.slice(0, 60));
  }
});
test('build は旧データ経路を持たず、旧内蔵サンプルを除外する', () => {
  assert.ok(build.includes('--out は temp/'));
  for (const bad of ['LiveCity-3DTiles-Out', 'allow-legacy', 'LOCALAPPDATA']) assert.ok(!build.includes(bad), bad);
  assert.ok(build.includes('mission37h-3dtiles') && build.includes("'map-data'"), '内蔵旧サンプルの除外');
});
test('vercel.json は静的出力 temp/cloud-preview/static を指し、temp/ は gitignore', () => {
  const v = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
  assert.strictEqual(v.outputDirectory, 'temp/cloud-preview/static');
  assert.ok(v.buildCommand.includes('build-cloud-preview.mjs'));
  assert.ok(/^temp\/$/m.test(fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8')));
});
