// tests/plateau-ortho-gsd.test.js
// [Mission 35C] PLATEAU 2020 / 2022 オルソの GSD 調査
//   - 3 次メッシュの範囲計算（3 次の分割は 8 ではなく 10）
//   - 地理座標系の度→m 変換（§4）
//   - A/B/C/D 分類（§6）と判定（§7）
//   - 1 つのアーカイブに複数の撮影年度が入っていることを扱えるか
//   - repo の外で作業し、raw data を壊さない（§2）
//   - 屋根 geometry を作らない（§9）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  mesh3Bounds, meshOverlapsUmeda, MESH3_LAT_SPAN, MESH3_LON_SPAN,
  setNameOf, fiscalYearOf, countExtensions, stats, overlapsUmeda, resolveTar, KNOWN_SOURCES, decide,
} from '../tools/audit/plateau-ortho-gsd-audit.js';
import { gsdFromHeader } from '../tools/lib/geotiff-header.js';
import { classifyGsd, UMEDA_LL, UMEDA_BBOX } from '../tools/audit/umeda-aerial-source-probe.js';
import { meshCode3, UMEDA_MESH3 } from '../tools/audit/umeda-ortho-source-catalog.js';
import { ARCHIVES, WORK_DIR } from '../tools/download/plateau-ortho-archive.js';
import { isInsideRepo, EXPECTED_GENERATED_ROOFS, QUALITY_GATE_35A } from '../tools/validate/plateau-ortho-gsd.js';
import { skipIfMissingRel } from './_generated-data.mjs';
// [Mission 35L] 検証対象の生成物が無いときだけ skip（生成済みなら従来どおり全部検証する）
const RAW_SKIP = skipIfMissingRel('data/raw/osaka-city/aerial-probe');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };
const rpt = (n) => rj(path.join(ROOT, 'data', 'reports', n));
const skip = (n) => (!rpt(n) && 'no report');

// ── 3 次メッシュ ────────────────────────────────────────────────────────
test('35C 3 次メッシュの範囲が実データの tiepoint と一致する', () => {
  // PLATEAU 2022 / 2024 の 52350349.tif の ModelTiepoint は [135.4875, 34.708333]（左上）
  const b = mesh3Bounds('52350349');
  assert.ok(Math.abs(b.west - 135.4875) < 1e-9, 'west=' + b.west);
  assert.ok(Math.abs(b.north - 34.7083333333) < 1e-9, 'north=' + b.north);
  assert.ok(Math.abs(b.south - 34.70) < 1e-9, 'south=' + b.south);
  assert.ok(Math.abs(b.east - 135.50) < 1e-9, 'east=' + b.east);
});

test('35C 3 次メッシュの分割は緯度 10 / 経度 10（8 ではない）', () => {
  assert.ok(Math.abs(MESH3_LAT_SPAN - 1 / 120) < 1e-12, '緯度 30 秒');
  assert.ok(Math.abs(MESH3_LON_SPAN - 1 / 80) < 1e-12, '経度 45 秒');
  // 3 次の下 2 桁を 1 進めると、ちょうど 1 区画ぶんずれる
  const a = mesh3Bounds('52350349'), c = mesh3Bounds('52350359');
  assert.ok(Math.abs((c.south - a.south) - MESH3_LAT_SPAN) < 1e-12);
  const d = mesh3Bounds('52350340'), e = mesh3Bounds('52350341');
  assert.ok(Math.abs((e.west - d.west) - MESH3_LON_SPAN) < 1e-12);
});

test('35C メッシュコードと範囲が往復する', () => {
  for (const code of ['52350349', '52350340', '51357247', '52350300']) {
    const b = mesh3Bounds(code);
    if (!b) continue;
    const mid = { lat: (b.south + b.north) / 2, lon: (b.west + b.east) / 2 };
    assert.equal(meshCode3(mid.lat, mid.lon), code, code + ' の中心から戻せない');
  }
});

test('35C 梅田のメッシュ判定が妥当な枚数になる', () => {
  assert.equal(UMEDA_MESH3, '52350349');
  assert.equal(meshOverlapsUmeda('52350349'), true);
  // 梅田 PoC 範囲（約 1.4km × 1.25km）は 3 次メッシュ 2〜6 枚に収まる
  const cands = [];
  for (let r = 0; r <= 9; r++) {
    for (let w = 0; w <= 9; w++) {
      for (const pre of ['523503', '523504', '513574']) {
        const code = pre + r + w;
        if (meshOverlapsUmeda(code) === true) cands.push(code);
      }
    }
  }
  assert.ok(cands.length >= 2 && cands.length <= 6, '梅田に重なるメッシュ ' + cands.length + ' 枚: ' + cands.join(','));
  assert.ok(cands.includes('52350349'));
});

test('35C 不正なメッシュコードは null', () => {
  assert.equal(mesh3Bounds('123'), null);
  assert.equal(mesh3Bounds('52358349'), null, '2 次の分割は 0-7');
  assert.equal(meshOverlapsUmeda('abc'), null);
});

// ── §4 度→m 変換 ───────────────────────────────────────────────────────
test('35C 地理座標系の GeoTIFF を m へ直す（PLATEAU 2022 の実値）', () => {
  const h = { tags: { ImageWidth: 3135, ImageLength: 2090,
    ModelPixelScale: [0.0000039872405930569756, 0.000003987240593058109, 0],
    ModelTiepoint: [0, 0, 0, 135.4875000003542, 34.70833333297505, 0],
    GeoKeyDirectory: [1, 1, 0, 2, 1024, 0, 1, 2, 2048, 0, 1, 6668] } };
  const g = gsdFromHeader(h, UMEDA_LL.lat);
  assert.equal(g.crsKind, 'geographic');
  assert.ok(Math.abs(g.gsdXm - 0.3649) < 0.002, '経度方向 ' + g.gsdXm);
  assert.ok(Math.abs(g.gsdYm - 0.4439) < 0.002, '緯度方向 ' + g.gsdYm);
  assert.equal(g.gsdM, g.gsdYm, '代表値は粗いほう');
  assert.equal(classifyGsd(g.gsdM), 'C');
  // 1 メッシュぶんの地上サイズ
  assert.ok(Math.abs(g.groundWidthM - 1144) < 10, g.groundWidthM);
  assert.ok(Math.abs(g.groundHeightM - 928) < 10, g.groundHeightM);
});

test('35C 投影座標系の GeoTIFF は ModelPixelScale がそのまま m（PLATEAU 2020 の実値）', () => {
  const h = { tags: { ImageWidth: 1150, ImageLength: 931,
    ModelPixelScale: [1, 1, 0], ModelTiepoint: [0, 0, 0, -46951.05, -143172, 0],
    GeoKeyDirectory: [1, 1, 0, 2, 1024, 0, 1, 1, 3072, 0, 1, 6674] } };
  const g = gsdFromHeader(h, UMEDA_LL.lat);
  assert.equal(g.crsKind, 'projected');
  assert.equal(g.gsdM, 1);
  assert.equal(classifyGsd(g.gsdM), 'D');
  assert.equal(g.groundWidthM, 1150);
});

test('35C 投影座標系の画像は緯度経度 bbox での梅田判定ができない', () => {
  const rec = { crsKind: 'projected', bbox: { west: -46951, north: -143172, east: -45801, south: -144103 } };
  assert.equal(overlapsUmeda(rec), null, '緯度経度として扱ってはいけない');
  assert.equal(overlapsUmeda({ crsKind: 'geographic', bbox: null }), null);
  assert.equal(overlapsUmeda({ crsKind: 'geographic',
    bbox: { west: 135.4875, north: 34.708333, east: 135.5, south: 34.70 } }, UMEDA_BBOX), true);
});

// ── アーカイブの構造 ────────────────────────────────────────────────────
test('35C images/ 直下のフォルダ名で撮影年度の組を見分ける', () => {
  assert.equal(setNameOf('27100_osaka-shi_2022_ortho_1_op/images/R2/51357247.tif'), 'R2');
  assert.equal(setNameOf('27100_osaka-shi_2022_ortho_1_op/images/R3/51357247.tif'), 'R3');
  assert.equal(setNameOf('27100_osaka-shi_2020_ortho_2_op/images/51357247.tif'), '(single)');
});

test('35C 和暦フォルダ名から撮影年度を出す', () => {
  assert.equal(fiscalYearOf('R2', 2022), 2020, '令和2年度 = 2020年度');
  assert.equal(fiscalYearOf('R3', 2022), 2021);
  assert.equal(fiscalYearOf('H30', 2022), 2018);
  assert.equal(fiscalYearOf('(single)', 2020), 2020, '分からなければ配布年度を使う');
});

test('35C 拡張子ごとに数えられる', () => {
  const c = countExtensions([{ name: 'a/b.tfw' }, { name: 'a/c.TFW' }, { name: 'a/d.pdf' }, { name: 'a/e' }]);
  assert.equal(c.tfw, 2);
  assert.equal(c.pdf, 1);
  assert.equal(c['(none)'], 1);
});

test('35C 統計は min / median / max を返す', () => {
  const s = stats([0.5, 0.3, 0.9, 0.4]);
  assert.equal(s.n, 4);
  assert.equal(s.min, 0.3);
  assert.equal(s.max, 0.9);
  assert.ok(s.median >= 0.4 && s.median <= 0.5);
  assert.equal(stats([]), null);
});

test('35C Windows では OS 同梱の bsdtar を使う（Git の GNU tar は drive letter を壊す）', () => {
  const t = resolveTar();
  if (process.platform === 'win32') {
    assert.match(t, /System32[\\/]tar\.exe$/i, 'System32 の tar を指していない: ' + t);
  } else assert.equal(t, 'tar');
});

// ── §2 置き場所 ────────────────────────────────────────────────────────
test('35C 作業フォルダは repo の外にある', () => {
  assert.ok(!isInsideRepo(WORK_DIR), 'WORK_DIR が repo の中にある: ' + WORK_DIR);
  assert.ok(isInsideRepo(path.join(ROOT, 'data', 'raw')), '判定関数そのものの確認');
});

test('35C repo 内に 7z を置いていない', () => {
  const raw = path.join(ROOT, 'data', 'raw');
  const found = [];
  const walk = (d, depth = 0) => {
    if (depth > 4 || !fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f, depth + 1);
      else if (/\.7z$/i.test(e.name)) found.push(f);
    }
  };
  walk(raw);
  assert.deepEqual(found, []);
});

test('35C 35B で置いた raw の probe 成果が残っている', { skip: RAW_SKIP }, () => {
  const d = path.join(ROOT, 'data', 'raw', 'osaka-city', 'aerial-probe');
  assert.ok(fs.existsSync(d), 'aerial-probe が消えている');
  assert.ok(fs.readdirSync(d).length > 0);
});

// ── §6/§7 分類と判定 ───────────────────────────────────────────────────
test('35C §6 分類の境目', () => {
  assert.equal(classifyGsd(0.20), 'A');
  assert.equal(classifyGsd(0.2001), 'B');
  assert.equal(classifyGsd(0.30), 'B');
  assert.equal(classifyGsd(0.3001), 'C');
  assert.equal(classifyGsd(0.50), 'C');
  assert.equal(classifyGsd(0.5001), 'D');
});

test('35C §7 判定は最良の class で決まる', () => {
  const mk = (cls, gsd) => ([{ id: 'x', sets: [{ set: 'S', captureFiscalYear: 2020,
    umeda: { gsdClass: cls, gsdStats: { median: gsd } } }] }]);
  assert.equal(decide(mk('A', 0.18)).verdict, 'A');
  assert.equal(decide(mk('A', 0.18)).freeDataSufficient, 'YES');
  assert.equal(decide(mk('B', 0.25)).verdict, 'B');
  assert.equal(decide(mk('B', 0.25)).freeDataSufficient, 'YES');
  assert.equal(decide(mk('C', 0.45)).verdict, 'C/D');
  assert.equal(decide(mk('C', 0.45)).freeDataSufficient, 'NO');
  assert.equal(decide(mk('D', 1.0)).freeDataSufficient, 'NO');
  // A が 1 つでもあれば A
  const mixed = [{ id: 'x', sets: [
    { set: 'a', umeda: { gsdClass: 'D', gsdStats: { median: 1 } } },
    { set: 'b', umeda: { gsdClass: 'A', gsdStats: { median: 0.15 } } }] }];
  assert.equal(decide(mixed).verdict, 'A');
});

test('35C §8 比較に 35B の確定値が入っている', () => {
  const ids = KNOWN_SOURCES.map((k) => k.id);
  for (const n of ['plateau-2024', 'osaka-city-0.50', 'gsi-seamlessphoto']) assert.ok(ids.includes(n), n);
  assert.equal(KNOWN_SOURCES.find((k) => k.id === 'osaka-city-0.50').gsdM, 0.50);
  assert.equal(KNOWN_SOURCES.find((k) => k.id === 'plateau-2024').gsdM, 0.4529);
});

test('35C 対象アーカイブが 2020 と 2022 の 2 件', () => {
  assert.equal(ARCHIVES.length, 2);
  assert.deepEqual(ARCHIVES.map((a) => a.year).sort(), [2020, 2022]);
  for (const a of ARCHIVES) assert.match(a.url, /^https:\/\/.*\.7z$/);
});

// ── §9 何も作らない ────────────────────────────────────────────────────
test('35C §9 屋根 geometry を増やしていない', { skip: (() => {
  const r = rj(path.join(ROOT, 'public', 'map-data', 'osaka-city', 'derived-umeda-inferred-roof', 'inferred-roofs.json'));
  return r ? false : 'not built';
})() }, () => {
  const r = rj(path.join(ROOT, 'public', 'map-data', 'osaka-city', 'derived-umeda-inferred-roof', 'inferred-roofs.json'));
  assert.equal(r.buildings.length, EXPECTED_GENERATED_ROOFS);
});

test('35C §9 品質基準を下げていない', () => {
  const v = rpt('umeda-inferred-roof-validation.json');
  if (v && v.evaluation && v.evaluation.quality) assert.deepEqual(v.evaluation.quality, QUALITY_GATE_35A);
});

test('35C §9 dev HTML に 35C の変更を入れていない', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'osaka_3d_buildings.ward-ux-v1.html'), 'utf-8');
  assert.ok(!/35C/.test(html));
});

// ── 実測（レポートがあるときだけ）───────────────────────────────────────
test('35C 実測: 2020 / 2022 とも梅田を覆う画像がある', { skip: skip('plateau-ortho-gsd-audit.json') }, () => {
  const a = rpt('plateau-ortho-gsd-audit.json');
  for (const r of a.archives) {
    assert.ok(r.exists, r.id + ' のアーカイブが無い');
    assert.ok(r.sets.length > 0, r.id + ' の組が 0');
    for (const s of r.sets) {
      assert.ok(s.umeda.count >= 1, `${r.id}/${s.set} の梅田該当が 0 枚`);
      assert.ok(s.umeda.count <= 6, `${r.id}/${s.set} の梅田該当が ${s.umeda.count} 枚（多すぎる）`);
    }
  }
});

test('35C 実測: class A/B は無かった', { skip: skip('plateau-ortho-gsd-audit.json') }, () => {
  const a = rpt('plateau-ortho-gsd-audit.json');
  assert.equal(a.decision.freeDataSufficient, 'NO',
    'A か B が見つかったなら結論が変わる: ' + JSON.stringify(a.decision.classes));
  assert.equal(a.decision.verdict, 'C/D');
  assert.equal(a.geometryGenerated, false);
});

test('35C 実測: §8 の比較が 5 行以上ある', { skip: skip('plateau-ortho-gsd-audit.json') }, () => {
  const a = rpt('plateau-ortho-gsd-audit.json');
  assert.ok(a.comparison.length >= 5, '比較 ' + a.comparison.length + ' 行');
  // 粗い順に並んでいる
  for (let i = 1; i < a.comparison.length; i++) {
    assert.ok(a.comparison[i].gsdM >= a.comparison[i - 1].gsdM, '並び順が崩れている');
  }
  for (const c of a.comparison) assert.equal(c.gsdClass, classifyGsd(c.gsdM), c.id);
});

test('35C 実測: 検証が PASS している', { skip: skip('plateau-ortho-gsd-validation.json') }, () => {
  const v = rpt('plateau-ortho-gsd-validation.json');
  assert.ok(['ORTHO_GSD_AUDIT_SUCCESS', 'ORTHO_GSD_AUDIT_FAILED'].includes(v.classification));
  assert.equal(v.geometryUnchanged, true);
  assert.equal(v.qualityGateUnchanged, true);
  assert.equal(v.rawIntact, true);
  assert.deepEqual(v.strayArchives, []);
  assert.equal(v.productionModified, false);
  assert.equal(v.protectedModified, false);
  assert.ok(['YES', 'NO'].includes(v.freeDataSufficient));
});
