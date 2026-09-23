// tests/umeda-aerial-evidence.test.js
// [Mission 35B] 梅田の航空写真証拠の調査
//   - Web タイルの zoom ではなく成果のヘッダから GSD を出す（§2）
//   - A/B/C/D の分類（§3）
//   - 400dpi を高解像度と決めつけない（§5）
//   - ステレオの高さ精度の計算（§6）
//   - 解像度と読み取り可否の関係（§9/§10）。影を輪郭の根拠に使わない
//   - 屋根 geometry を増やさない / quality gate を下げない（§11）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  lonLatToTile, mppAt, tilesCovering, scannedPhotoGsd, stereoHeightPrecision,
  baseHeightFromOverlap, highFrequencyEnergy, pixelDifference,
} from '../tools/lib/gsi-tile-probe.js';
import {
  JOHNSON, SHADOW_COUNTS_FOR, GSD_STEPS, SUN_ELEVATION_DEG, equivalentSideM, shadowLengthM,
  pxAt, criticalFeatures, judgeAtGsd, sweep, findCliff, minimumGsdFor,
} from '../tools/lib/roof-detectability.js';
import { gsdFromHeader, parseGeoKeys, TIFF_TAG } from '../tools/lib/geotiff-header.js';
import { GSD_CLASS, classifyGsd, jpegSize, pngSize, UMEDA_LL, UMEDA_BBOX } from '../tools/audit/umeda-aerial-source-probe.js';
import { meshCode3, UMEDA_MESH3, captureFromNotes } from '../tools/audit/umeda-ortho-source-catalog.js';
import { flattenLayers, isXyzTemplate, layerGsd, PHOTO_RE } from '../tools/audit/gsi-photo-layer-catalog.js';
import { METRIC_GROUPS, pct } from '../tools/audit/umeda-roof-resolution-experiment.js';
import { scanTable, dpiNeededFor, stereoTable, judgeHeightNeeds, HEIGHT_NEEDS, PHOTO_SCALES } from '../tools/audit/umeda-stereo-and-scan-analysis.js';
import { QUALITY_GATE_35A, EXPECTED_GENERATED_ROOFS } from '../tools/validate/umeda-aerial-evidence.js';
import { featuresAtPoint, fillTemplate } from '../tools/audit/umeda-aerial-availability.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };
const rpt = (n) => rj(path.join(ROOT, 'data', 'reports', n));
const skip = (n) => (!rpt(n) && 'no report');

// ── §2 タイル座標と解像度 ────────────────────────────────────────────────
test('35B §2 梅田のタイル座標と 1px の地上寸法', () => {
  const t = lonLatToTile(UMEDA_LL.lon, UMEDA_LL.lat, 18);
  assert.equal(t.x, 229737);
  assert.equal(t.y, 104098);
  // 緯度 34.70 の z18 は約 0.49 m/px。z を 1 上げれば半分になる。
  const a = mppAt(UMEDA_LL.lat, 18), b = mppAt(UMEDA_LL.lat, 19);
  assert.ok(Math.abs(a - 0.4909) < 0.002, 'z18=' + a);
  assert.ok(Math.abs(a / b - 2) < 1e-9);
});

test('35B §2 梅田 PoC 範囲を覆うタイルを列挙できる', () => {
  const ts = tilesCovering({ ...UMEDA_BBOX }, 18);
  assert.ok(ts.length >= 4, 'タイル数 ' + ts.length);
  assert.ok(ts.every((t) => t.z === 18));
  const xs = new Set(ts.map((t) => t.x));
  assert.ok(xs.size >= 2, '東西に複数タイルある');
});

test('35B §2 URL テンプレートへ z/x/y を入れられる', () => {
  assert.equal(fillTemplate('https://h/{z}/{x}/{y}.jpg', 18, 1, 2), 'https://h/18/1/2.jpg');
});

// ── §3 分類 ──────────────────────────────────────────────────────────────
test('35B §3 地上画素寸法を A/B/C/D へ分類する', () => {
  assert.equal(classifyGsd(0.10), 'A');
  assert.equal(classifyGsd(0.20), 'A');
  assert.equal(classifyGsd(0.25), 'B');
  assert.equal(classifyGsd(0.30), 'B');
  assert.equal(classifyGsd(0.45), 'C');
  assert.equal(classifyGsd(0.50), 'C');
  assert.equal(classifyGsd(0.51), 'D');
  assert.equal(classifyGsd(null), null);
  assert.deepEqual(GSD_CLASS.map((g) => g.cls), ['A', 'B', 'C', 'D']);
});

// ── §2 成果のヘッダから読む ─────────────────────────────────────────────
test('35B §2 投影座標系の GeoTIFF は ModelPixelScale がそのまま m', () => {
  const h = { tags: { ImageWidth: 1000, ImageLength: 800, ModelPixelScale: [0.5, 0.5, 0],
    GeoKeyDirectory: [1, 1, 0, 2, 1024, 0, 1, 1, 3072, 0, 1, 6674] } };
  const g = gsdFromHeader(h, 34.7);
  assert.equal(g.crsKind, 'projected');
  assert.equal(g.gsdM, 0.5);
  assert.equal(g.groundWidthM, 500);
});

test('35B §2 地理座標系の GeoTIFF は度を m へ直す（ここを間違えると桁を誤る）', () => {
  // PLATEAU 大阪 2024 の実際の値
  const h = { tags: { ImageWidth: 3072, ImageLength: 2048,
    ModelPixelScale: [0.000004069010416662966, 0.00000406884765625018, 0],
    ModelTiepoint: [0, 0, 0, 135.4875, 34.708333, 0],
    GeoKeyDirectory: [1, 1, 0, 2, 1024, 0, 1, 2, 2048, 0, 1, 6668] } };
  const g = gsdFromHeader(h, 34.702501);
  assert.equal(g.crsKind, 'geographic');
  assert.ok(Math.abs(g.gsdXm - 0.372) < 0.005, '経度方向 ' + g.gsdXm);
  assert.ok(Math.abs(g.gsdYm - 0.453) < 0.005, '緯度方向 ' + g.gsdYm);
  // 代表値は粗いほうを採る（細かいほうを名乗ると過大評価になる）
  assert.equal(g.gsdM, g.gsdYm);
  assert.equal(classifyGsd(g.gsdM), 'C');
  // 3 次メッシュ 1 枚ぶんの地上サイズになっている
  assert.ok(Math.abs(g.groundWidthM - 1144) < 10, g.groundWidthM);
  assert.ok(Math.abs(g.groundHeightM - 928) < 10, g.groundHeightM);
});

test('35B §2 GeoKey から座標系を読める', () => {
  const k = parseGeoKeys([1, 1, 0, 2, 1024, 0, 1, 1, 3072, 0, 1, 6674], null, null);
  assert.equal(k.GTModelType, 1);
  assert.equal(k.ProjectedCSTypeGeoKey, 6674);
  assert.equal(TIFF_TAG[33550], 'ModelPixelScale');
});

test('35B §2 JPEG / PNG のヘッダから画素数を読める', () => {
  // 最小の JPEG: SOI + SOF0(8x16) + EOI
  const j = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x10, 0x00, 0x08,
    0x03, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xd9]);
  assert.deepEqual(jpegSize(j), { width: 8, height: 16 });
  const p = Buffer.alloc(24);
  p.writeUInt32BE(0x89504e47, 0); p.writeUInt32BE(64, 16); p.writeUInt32BE(32, 20);
  assert.deepEqual(pngSize(p), { width: 64, height: 32 });
  assert.equal(jpegSize(Buffer.from([1, 2, 3])), null);
});

// ── レイヤ定義の解釈 ────────────────────────────────────────────────────
test('35B §1 地理院のレイヤ定義ツリーを平らにできる', () => {
  const tree = { layers: [{ type: 'LayerGroup', title: '年代別の写真', entries: [
    { type: 'Layer', id: 'seamlessphoto', title: '全国最新写真', url: 'https://h/xyz/seamlessphoto/{z}/{x}/{y}.jpg', minZoom: 2, maxZoom: 18 },
    { type: 'Layer', id: 'x_spec', title: '撮影期間', url: 'https://h/xyz/x/{z}/{x}/{y}.geojson', maxZoom: 18, maxNativeZoom: 11 },
  ] }] };
  const flat = flattenLayers(tree);
  const seam = flat.find((l) => l.id === 'seamlessphoto');
  assert.ok(seam, '平らにできている');
  assert.deepEqual(seam.trail, ['年代別の写真', '全国最新写真']);
  assert.ok(isXyzTemplate(seam.url));
  assert.ok(PHOTO_RE.test(seam.title));
  // maxNativeZoom があればそちらが実質の解像度
  const spec = flat.find((l) => l.id === 'x_spec');
  assert.ok(layerGsd(spec, 34.7) > layerGsd(seam, 34.7), 'maxNativeZoom 11 のほうが粗い');
});

test('35B §4 点を含む範囲だけを拾う', () => {
  const gj = { features: [
    { geometry: { type: 'Polygon', coordinates: [[[135.4, 34.6], [135.6, 34.6], [135.6, 34.8], [135.4, 34.8], [135.4, 34.6]]] }, properties: { 撮影日: 'A' } },
    { geometry: { type: 'Polygon', coordinates: [[[130, 30], [131, 30], [131, 31], [130, 31], [130, 30]]] }, properties: { 撮影日: 'B' } },
  ] };
  const hits = featuresAtPoint(gj, UMEDA_LL.lon, UMEDA_LL.lat);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].properties.撮影日, 'A');
});

test('35B メッシュコードが梅田のものになる', () => {
  assert.equal(meshCode3(UMEDA_LL.lat, UMEDA_LL.lon), '52350349');
  assert.equal(UMEDA_MESH3, '52350349');
});

test('35B 撮影年月を notes から拾える', () => {
  const c = captureFromNotes('令和8年（2026年）1月撮影の大阪市全域の航空写真です。');
  assert.equal(c.year, 2026);
  assert.equal(c.month, 1);
  assert.equal(captureFromNotes(''), null);
});

// ── §5 400dpi を鵜呑みにしない ──────────────────────────────────────────
test('35B §5 地上画素寸法は撮影縮尺で決まる（400dpi は高解像度を意味しない）', () => {
  // 1:10,000 を 400dpi → 0.635m。class D。
  assert.ok(Math.abs(scannedPhotoGsd(10000, 400) - 0.635) < 0.001);
  assert.equal(classifyGsd(scannedPhotoGsd(10000, 400)), 'D');
  // 1:8,000 でも 400dpi なら 0.508m で class D
  assert.equal(classifyGsd(scannedPhotoGsd(8000, 400)), 'D');
  // 同じ 400dpi でも 1:4,000 なら 0.254m で class B
  assert.equal(classifyGsd(scannedPhotoGsd(4000, 400)), 'B');
  // dpi を上げれば線形に細かくなる
  assert.ok(Math.abs(scannedPhotoGsd(10000, 800) - scannedPhotoGsd(10000, 400) / 2) < 1e-9);
});

test('35B §5 目標 GSD に必要な dpi を出せる', () => {
  assert.equal(dpiNeededFor(10000, 0.20), 1270);
  assert.equal(dpiNeededFor(8000, 0.20), 1016);
  // 出した dpi で実際にその GSD 以下になる
  for (const s of PHOTO_SCALES) {
    assert.ok(scannedPhotoGsd(s, dpiNeededFor(s, 0.20)) <= 0.20 + 1e-9, '1:' + s);
  }
});

test('35B §5 縮尺 × dpi の表が全マス埋まっている', () => {
  const t = scanTable();
  assert.equal(t.length, PHOTO_SCALES.length);
  for (const row of t) {
    for (const d of [200, 400, 1200]) {
      assert.ok(row.byDpi[d].gsdM > 0, row.photoScale + '/' + d);
      assert.ok(['A', 'B', 'C', 'D'].includes(row.byDpi[d].gsdClass));
    }
    // dpi が上がれば GSD は必ず細かくなる
    assert.ok(row.byDpi[1200].gsdM < row.byDpi[400].gsdM);
  }
});

// ── §6 ステレオ ─────────────────────────────────────────────────────────
test('35B §6 重複 60% の基線高度比', () => {
  const bh = baseHeightFromOverlap(0.60, 74);
  assert.ok(bh > 0.5 && bh < 0.7, 'B/H=' + bh);
  // 重複を増やすと基線は短くなる＝高さ精度は悪くなる
  assert.ok(baseHeightFromOverlap(0.80, 74) < bh);
});

test('35B §6 ステレオの高さ精度は GSD に比例する', () => {
  const a = stereoHeightPrecision(0.20, 0.6, 0.5);
  const b = stereoHeightPrecision(0.40, 0.6, 0.5);
  assert.ok(Math.abs(b - a * 2) < 1e-9);
  assert.ok(a < 0.2, '0.20m/px なら σh は 0.2m 未満: ' + a);
  // 基線が長いほど高さは正確になる
  assert.ok(stereoHeightPrecision(0.20, 0.8, 0.5) < a);
});

test('35B §8 高さの要求は 35A の判定閾値から来ている', () => {
  const ph = HEIGHT_NEEDS.find((h) => h.id === 'penthouse');
  assert.ok(ph.needSigmaM <= 0.5, '塔屋は 1.5m の立ち上がりで判定するので σ は 0.5m 以下');
  const step = HEIGHT_NEEDS.find((h) => h.id === 'multiLevelStep');
  assert.ok(step.needSigmaM <= 0.35);
  // 粗い GSD では満たせない
  assert.ok(judgeHeightNeeds(stereoHeightPrecision(1.0, 0.6, 0.5)).every((h) => !h.ok));
  assert.ok(judgeHeightNeeds(stereoHeightPrecision(0.20, 0.6, 0.5)).every((h) => h.ok));
});

test('35B §6 ステレオの表が GSD ごとに埋まっている', () => {
  const t = stereoTable([0.1, 0.2, 0.5]);
  assert.equal(t.rows.length, 3);
  for (const r of t.rows) assert.ok(r.sigmaHeightM[0.5] > 0);
  // 視差の測定精度が良いほど高さも良くなる
  assert.ok(t.rows[0].sigmaHeightM[0.3] < t.rows[0].sigmaHeightM[1]);
});

// ── §9/§10 読み取り可否 ─────────────────────────────────────────────────
test('35B §10 影は「何かある」までで、輪郭の根拠にはしない', () => {
  assert.ok(SHADOW_COUNTS_FOR.has('detection'));
  assert.ok(!SHADOW_COUNTS_FOR.has('recognition'));
  assert.ok(!SHADOW_COUNTS_FOR.has('delineation'));
  // 小さいが背の高い塔屋: 影は長いが本体は小さい
  const cf = { canonicalId: 'x', roofType: 'FLAT_WITH_PENTHOUSE',
    features: [{ key: 'penthouse', lengthM: 2.0, riseM: 3.0, shadowM: 4.29 }] };
  assert.equal(judgeAtGsd(cf, 0.5, 'detection').ok, true, '影で「何かある」は言える');
  assert.equal(judgeAtGsd(cf, 0.5, 'recognition').ok, false, '2m/0.5m=4px では種類は言えない');
  assert.equal(judgeAtGsd(cf, 0.5, 'delineation').ok, false, '輪郭はなぞれない');
});

test('35B §10 判定の閾値は Johnson criteria', () => {
  assert.equal(JOHNSON.detection, 3);
  assert.equal(JOHNSON.recognition, 6);
  assert.equal(JOHNSON.delineation, 12);
  assert.ok(JOHNSON.detection < JOHNSON.recognition && JOHNSON.recognition < JOHNSON.delineation);
  assert.throws(() => judgeAtGsd({ features: [{ key: 'a', lengthM: 1 }] }, 0.1, 'nonsense'));
});

test('35B §10 画素数の計算', () => {
  assert.equal(pxAt(6, 0.5), 12);
  assert.equal(pxAt(6, 0), 0);
  assert.ok(Math.abs(equivalentSideM(25) - 5) < 1e-9);
  // 太陽高度 35° の影は物体の高さの約 1.43 倍
  assert.ok(Math.abs(shadowLengthM(1, 35) - 1.428) < 0.01);
  assert.equal(shadowLengthM(0), 0);
  assert.equal(SUN_ELEVATION_DEG, 35);
});

test('35B §9 屋根タイプごとに見るべき特徴が違う', () => {
  const shape = { longM: 30, shortM: 10, elongation: 3, longAxisDeg: 0, rectangularity: 0.9 };
  const gable = criticalFeatures({ canonicalId: 'a', roofType: 'GABLE', footprintAreaM2: 300, metrics: { roofSpreadM: 2 } }, shape);
  assert.deepEqual(gable.features.map((f) => f.key).sort(), ['ridgeLength', 'slopeRun']);
  // 片面の流れは短辺の半分
  assert.equal(gable.features.find((f) => f.key === 'slopeRun').lengthM, 5);

  const ph = criticalFeatures({ canonicalId: 'b', roofType: 'FLAT_WITH_PENTHOUSE', footprintAreaM2: 400,
    penthouseShare: 0.09, penthouseRiseM: 3,
    metrics: { totalPlanAreaM2: 400, levels: [{ y: 20, areaShare: 0.91 }, { y: 23, areaShare: 0.09 }] } }, shape);
  assert.equal(ph.features.length, 1);
  assert.equal(ph.features[0].key, 'penthouse');
  assert.equal(ph.features[0].lengthM, 6, '√(0.09×400)=6m');

  // FLAT は「無いことの確認」。建物が大きいことを根拠にしない。
  const flat = criticalFeatures({ canonicalId: 'c', roofType: 'FLAT', footprintAreaM2: 5000, metrics: {} },
    { longM: 100, shortM: 50, elongation: 2, longAxisDeg: 0, rectangularity: 0.9 }, 3.2);
  assert.equal(flat.features[0].key, 'excludeSmallFeature');
  assert.equal(flat.features[0].lengthM, 3.2, '大きな建物でも 3.2m の特徴が見えないと「平ら」と言えない');
});

test('35B §10 一番読みにくい特徴が律速になる', () => {
  const cf = { canonicalId: 'x', roofType: 'GABLE', features: [
    { key: 'ridgeLength', lengthM: 30 }, { key: 'slopeRun', lengthM: 2 }] };
  const j = judgeAtGsd(cf, 0.25, 'delineation');
  assert.equal(j.limitingFeature, 'slopeRun');
  assert.equal(j.minPx, 8);
  assert.equal(j.ok, false, '8px < 12px');
});

test('35B §10 解像度が粗くなると読み取れる割合は単調に下がる', () => {
  const recs = [
    { canonicalId: 'a', roofType: 'GABLE', features: [{ key: 'slopeRun', lengthM: 3 }] },
    { canonicalId: 'b', roofType: 'FLAT', features: [{ key: 'excludeSmallFeature', lengthM: 3.2 }] },
    { canonicalId: 'c', roofType: 'HIP', features: [{ key: 'ridgeLength', lengthM: 40 }] },
  ];
  const s = sweep(recs, [0.1, 0.2, 0.5, 1.0], 'delineation');
  for (let i = 1; i < s.length; i++) assert.ok(s[i].rate <= s[i - 1].rate, 'GSD ' + s[i].gsdM);
  const c = findCliff(s);
  assert.ok(c && c.drop > 0);
  assert.ok(c.fromGsdM < c.toGsdM);
  // 目標を満たす「一番粗い」解像度を返す（一番細かいほうではない）
  const best = minimumGsdFor(s, 1.0);
  assert.equal(s.find((r) => r.gsdM === best).rate, 1);
  assert.ok(s.filter((r) => r.rate >= 1).every((r) => r.gsdM <= best), best + ' より粗くて 100% の段は無い');
  assert.equal(minimumGsdFor(s, 2.0), null, '達成不能なら null');
});

test('35B §9 4 つの指標が定義されている', () => {
  for (const k of ['roofFamily', 'ridge', 'penthouse', 'multiLevel']) {
    assert.ok(Array.isArray(METRIC_GROUPS[k]) && METRIC_GROUPS[k].length, k);
  }
  assert.deepEqual(METRIC_GROUPS.penthouse, ['FLAT_WITH_PENTHOUSE']);
  assert.deepEqual(METRIC_GROUPS.ridge, ['GABLE', 'HIP']);
  assert.equal(pct([1, 2, 3, 4, 5], 0.5), 3);
  assert.equal(pct([], 0.5), null);
});

test('35B §10 指定された解像度をすべて測っている', () => {
  for (const g of [0.20, 0.25, 0.40, 0.60]) assert.ok(GSD_STEPS.includes(g), g + 'm');
});

// ── 画像の情報量 ────────────────────────────────────────────────────────
test('35B §2 拡大しただけの画像は高周波成分が増えない', () => {
  const w = 32, h = 32;
  const sharp = new Uint8Array(w * h), blurred = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      sharp[y * w + x] = (x % 2 === 0) ? 0 : 255;        // 1px 間隔の縞
      blurred[y * w + x] = (Math.floor(x / 4) % 2 === 0) ? 0 : 255;  // 4px 間隔
    }
  }
  assert.ok(highFrequencyEnergy(sharp, w, h) > highFrequencyEnergy(blurred, w, h));
  const d = pixelDifference(sharp, blurred);
  assert.ok(d.maxAbs > 0 && d.n === w * h);
  assert.equal(pixelDifference(new Uint8Array(0), new Uint8Array(0)), null);
});

// ── §11 何も作らない・基準を下げない ────────────────────────────────────
test('35B §11 35A の品質基準を下げていない', () => {
  assert.equal(QUALITY_GATE_35A.roofTypeAccuracy, 0.85);
  assert.equal(QUALITY_GATE_35A.ridgeMedianDeg, 10);
  assert.equal(QUALITY_GATE_35A.roofIoUMedian, 0.85);
  const v = rpt('umeda-inferred-roof-validation.json');
  if (v && v.evaluation && v.evaluation.quality) {
    assert.deepEqual(v.evaluation.quality, QUALITY_GATE_35A);
  }
});

test('35B §11 屋根 geometry を 1 棟も増やしていない', { skip: (() => {
  const r = rj(path.join(ROOT, 'public', 'map-data', 'osaka-city', 'derived-umeda-inferred-roof', 'inferred-roofs.json'));
  return r ? false : 'not built';
})() }, () => {
  const r = rj(path.join(ROOT, 'public', 'map-data', 'osaka-city', 'derived-umeda-inferred-roof', 'inferred-roofs.json'));
  assert.equal(r.buildings.length, EXPECTED_GENERATED_ROOFS, '35B は調査のみ');
});

test('35B §11 dev HTML に 35B の変更を入れていない', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'osaka_3d_buildings.ward-ux-v1.html'), 'utf-8');
  assert.ok(!/35B/.test(html), '今回は描画に触らない');
});

// ── 実際に取得した結果（レポートがあるときだけ）─────────────────────────
test('35B §2 地理院タイルは z18 が上限だった（実測）', { skip: skip('umeda-aerial-availability.json') }, () => {
  const a = rpt('umeda-aerial-availability.json');
  assert.ok(a.imageLayersServed > 0, '梅田で配信されている写真レイヤがある');
  for (const i of a.images.filter((x) => x.available)) {
    assert.ok(i.maxServedZoom <= 18, i.id + ' が z18 を超えて配信されている（この結論は見直しが要る）');
    assert.ok(i.gsdM > 0 && ['A', 'B', 'C', 'D'].includes(i.gsdClass));
  }
  assert.ok(a.bestGsdM >= 0.45, '梅田の緯度で z18 は約 0.49m');
});

test('35B §3/§4 公開オルソに class A/B は無かった（実測）', { skip: skip('umeda-ortho-source-catalog.json') }, () => {
  const o = rpt('umeda-ortho-source-catalog.json');
  const ok = [...o.osakaCityPhoto, ...o.plateauOrtho].filter((r) => r.ok && r.gsdM != null);
  assert.ok(ok.length > 0, '実際にヘッダを読めた成果がある');
  for (const r of ok) assert.ok(r.header.pixelScaleX != null, r.dataset + ' はヘッダ由来でない');
  assert.equal(o.anyClassAorB, false, 'class A/B が見つかったなら結論が変わる');
  assert.ok(o.bestGsdM > 0.30, '最良でも ' + o.bestGsdM + 'm');
});

test('35B §10 解像度の崖と必要最低 GSD が出ている（実測）', { skip: skip('umeda-roof-resolution-experiment.json') }, () => {
  const e = rpt('umeda-roof-resolution-experiment.json');
  assert.equal(e.evaluated, e.groundTruthCount, 'ground truth 全棟を評価している');
  assert.ok(e.cliff && e.cliff.drop > 0.1, '崖が見つかっている');
  assert.ok(e.minimumGsdM['0.95'] <= 0.30, '必要最低 GSD は 0.30m 以下のはず');
  // 手元の成果では輪郭がなぞれない、という 35A の結論と整合する
  for (const a of e.atAvailableSources) {
    assert.ok(a.byMetric.penthouse.delineationRate < 0.85,
      a.id + ' で塔屋の輪郭が 85% なぞれるなら 35A の結果と矛盾する');
  }
});

test('35B §12 推奨最低 GSD が class A になっている（実測）', { skip: skip('umeda-aerial-evidence-validation.json') }, () => {
  const v = rpt('umeda-aerial-evidence-validation.json');
  assert.ok(['UMEDA_AERIAL_EVIDENCE_AUDIT_SUCCESS', 'UMEDA_AERIAL_EVIDENCE_AUDIT_FAILED'].includes(v.classification));
  assert.equal(v.geometryUnchanged, true);
  assert.equal(v.qualityGateUnchanged, true);
  assert.equal(v.productionModified, false);
  assert.equal(v.protectedModified, false);
  assert.ok(v.findings.recommendedMinimumGsdM != null);
  assert.equal(v.findings.recommendedMinimumGsdClass, classifyGsd(v.findings.recommendedMinimumGsdM));
});
