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
test('Mission 197: 「ローカル変換データ/この PC のみ」表記の置換対象が各 1 箇所あり、build が補完 LOD1 と ID 監査を行う', () => {
  for (const s of ["'3D建物: ローカル全域変換済み（' + a.tiles + 'タイル・' + fmt(a.buildings) + '棟。この PC のみ・未公開。ブラウザでの全域視認は未確認）'",
    "'3D建物: ローカル変換データ（' + a.tiles + 'タイル・' + fmt(a.buildings) + '棟。この PC のみ・未公開・全域とは未確認）'"]) {
    assert.ok(build.includes(s), 'build の置換元');
    assert.strictEqual(html.split(s).length - 1, 1, s.slice(0, 40));
  }
  assert.ok(build.includes('--exclude-ids') && build.includes('doubleDrawn') && build.includes('lod1OriginalBuildings'));
  assert.ok(build.includes('クラウド配信: '), '配信区数の表示');
});
test('vercel.json は静的出力 temp/cloud-preview/static を指し、temp/ は gitignore', () => {
  const v = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
  assert.strictEqual(v.outputDirectory, 'temp/cloud-preview/static');
  assert.ok(v.buildCommand.includes('build-cloud-preview.mjs'));
  assert.ok(/--wards kita,chuo,nishi,fukushima(\s|$)/.test(v.buildCommand), 'Mission 204: 北区+中央区+西区+福島区');
  assert.ok(!/nobuiltin=0|ext45=0/.test(JSON.stringify(v.redirects)), '旧45D混在禁止(nobuiltin=1維持)');
  assert.ok(v.redirects[0].destination.includes('nobuiltin=1'));
  assert.ok(/^temp\/$/m.test(fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8')));
});
test('Mission 199: 複数区ビルド — 区ごとに補完LOD1+ID監査、バナーに区名、LOD2は区外建物を含む旨を明示', () => {
  assert.ok(build.includes('for (const w of wardInfo)') && build.includes('auditWard('));
  assert.ok(build.includes('wardInfo.map((w) => w.name).join'), 'バナーに配信区名');
  assert.ok(build.includes('区外の建物を含む'));
  assert.ok(!build.includes('この区のみ配信'), '複数区で誤解を生む表記');
});
