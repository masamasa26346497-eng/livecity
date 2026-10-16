'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { inventory, convertSubset, verify, existingTilesets } = require('../tools/mission40b-legacy-tiles-batch.cjs');

test('棚卸し: 24 区、manifest 件数 574,213、実体のある区だけ legacy complete', () => {
  const inv = inventory();
  assert.strictEqual(inv.wards.length, 24);
  assert.strictEqual(inv.rootManifest.buildingCount, 574213);
  assert.ok(inv.wards.find((w) => w.wardId === 'sumiyoshi').legacyTilesLocal.complete);
  assert.strictEqual(inv.totals.legacyBuildingsLocal, inv.wards.reduce((n, w) => n + w.legacyTilesLocal.buildings, 0));
  // 実体が無い区を「変換可能」と偽らない
  for (const w of inv.wards) if (!w.legacyTilesLocal.complete) assert.match(w.action, /not in this checkout/);
});

test('既存 tileset の検出（37B/37H/38E は再生成対象にしない）', () => {
  const ids = existingTilesets().map((x) => x.wardId);
  for (const w of ['sumiyoshi', 'kita', 'chuo', 'tennoji', 'nishi', 'naniwa']) assert.ok(ids.includes(w), w);
});

test('住吉 9 tile を旧タイルから変換 → 既存 37B tileset と canonicalId・GLB が一致', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'm40b-test-'));
  try {
    const keys = [-6, -5, -4].flatMap((x) => [-3, -2, -1].map((z) => `${x}_${z}`));
    const r = convertSubset('sumiyoshi', keys, out);
    assert.strictEqual(r.buildings, 10546);
    assert.strictEqual(r.uniqueIds, 10546);
    assert.strictEqual(r.skipped, 0);
    const v = verify(out, path.join(__dirname, '../public/mission37b-3dtiles/osaka-sumiyoshi-9tile'));
    assert.ok(v.identical, JSON.stringify(v));
    const a = fs.readFileSync(path.join(out, 'tiles/t_-5_-2.glb'));
    const b = fs.readFileSync(path.join(__dirname, '../public/mission37b-3dtiles/osaka-sumiyoshi-9tile/tiles/t_-5_-2.glb'));
    assert.ok(a.equals(b));
    // attrs サイドカーは旧タイルの高さ・用途を保持
    const at = JSON.parse(fs.readFileSync(path.join(out, 'attrs/t_-5_-2.json'), 'utf8'));
    assert.strictEqual(at.byId['bldg_530f4af4-8df2-4700-ab01-82a823a97b6c'][0], 6.9);
  } finally { fs.rmSync(out, { recursive: true, force: true }); }
});

test('ツールは Google/ネットワークを参照しない', () => {
  const src = fs.readFileSync(path.join(__dirname, '../tools/mission40b-legacy-tiles-batch.cjs'), 'utf8');
  assert.ok(!/https?:\/\/|fetch\(|googleapis/.test(src.replace(/\/\/.*$/gm, '')));
});

test('40C: 外部入力指定 (--src) と validate は読み取り専用で、住吉の実データは整合する', () => {
  const { validate, setSource } = require('../tools/mission40b-legacy-tiles-batch.cjs');
  const src = fs.readFileSync(path.join(__dirname, '../tools/mission40b-legacy-tiles-batch.cjs'), 'utf8');
  assert.match(src, /LIVECITY_LEGACY_BUILDINGS/);
  assert.ok(!/unlinkSync|rmSync\([^)]*BLD|rmdirSync/.test(src.replace(/fs\.rmSync\(tmp[^;]*;/, '')), '元データを消す処理が無い');
  setSource(path.join(__dirname, '../public/map-data/osaka-city/buildings'));
  const r = validate();
  const s = r.wards.find((w) => w.wardId === 'sumiyoshi');
  assert.strictEqual(s.status, 'ok', JSON.stringify(s.issues));
  assert.strictEqual(s.buildings, 35031);
  assert.strictEqual(r.wards.length, 24);
  for (const w of r.wards) if (w.wardId !== 'sumiyoshi') assert.ok(['ok', 'missing'].includes(w.status) || w.buildings > 0);
});

test('40C: PowerShell ワンショットは元データへ書かず、出力先が非空なら中止する', () => {
  const ps = fs.readFileSync(path.join(__dirname, '../tools/mission40c-run-local.ps1'), 'utf8');
  assert.match(ps, /上書きしません/);
  assert.ok(!/Remove-Item|robocopy|Copy-Item|Move-Item/i.test(ps.replace(/<#[\s\S]*?#>/, '')));
});
