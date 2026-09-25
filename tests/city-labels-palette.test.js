// tests/city-labels-palette.test.js
// [Mission 33A] 地名・駅名・主要施設ラベル + 地図の配色改善
//   - ラベルデータ（OSM place を基準地名へ集約したもの）の中身
//   - ラベル層（CityLabelLayer）の実装: 優先順位 / LOD / 衝突回避 / 遅延生成 / トグル
//   - 配色 v2 の定数と、建物 geometry を触っていないこと
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { baseName, classifyPlace, aggregatePlaces, MAJOR_TOP_N } from '../tools/build-place-labels.js';

const require_ = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HTML_PATH = path.join(ROOT, 'public', 'osaka_3d_buildings.ward-ux-v1.html');
const html = fs.readFileSync(HTML_PATH, 'utf-8');
const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };
const rpt = (n) => rj(path.join(ROOT, 'data', 'reports', n));
const skip = (n) => (!rpt(n) && 'no report');
const places = rj(path.join(ROOT, 'public', 'map-data', 'osaka-city', 'derived', 'place-labels.json'));

test('[33A] 地名データ: 丁目を基準地名へ集約する（駅の近さで重み付け）', () => {
  assert.equal(baseName('梅田一丁目'), '梅田');
  assert.equal(baseName('綾之町西二丁'), '綾之町西');
  assert.equal(baseName('中之島６丁目'), '中之島');
  assert.equal(baseName('本町'), '本町');
  // 区・市名は地名ラベルにしない（区名は WardLabelLayer の担当）
  assert.equal(classifyPlace({ place: 'neighbourhood', name: '北区' }), null);
  assert.equal(classifyPlace({ place: 'city', name: '大阪市' }), null);
  assert.deepEqual(classifyPlace({ place: 'neighbourhood', name: '梅田一丁目' }), { name: '梅田一丁目', base: '梅田', placeType: 'neighbourhood' });

  const raw = [
    { name: '甲一丁目', base: '甲', placeType: 'neighbourhood', x: 0, z: 0 },
    { name: '甲二丁目', base: '甲', placeType: 'neighbourhood', x: 100, z: 0 },
    { name: '乙一丁目', base: '乙', placeType: 'neighbourhood', x: 5000, z: 0 },
    { name: '乙二丁目', base: '乙', placeType: 'neighbourhood', x: 5100, z: 0 },
    { name: '丙一丁目', base: '丙', placeType: 'neighbourhood', x: 9000, z: 0 },
  ];
  const agg = aggregatePlaces(raw, [{ name: '甲駅', point: [50, 0] }]);
  const names = agg.map((p) => p.name);
  assert.ok(names.includes('甲') && names.includes('乙'), JSON.stringify(names));
  assert.ok(!names.includes('丙'), '丁目が 1 つだけの町名は地名ラベルにしない');
  // 同名駅がある「甲」の方が上位
  assert.equal(agg[0].name, '甲');
  assert.equal(agg[0].nearStation, '甲');
  assert.ok(agg[0].score > agg[1].score);
  assert.equal(agg[0].rank, 1);
});

test('[33A] 生成済み place-labels.json の中身', { skip: !places && 'no place-labels.json' }, () => {
  assert.ok(places.places.length > 300, `地名 ${places.places.length} 件`);
  assert.equal(places.coordinateConvention, 'znorth-neg-v1');
  const majors = places.places.filter((p) => p.importance === 'major');
  assert.equal(majors.length, MAJOR_TOP_N);
  for (const p of places.places) {
    assert.ok(Number.isFinite(p.x) && Number.isFinite(p.z), p.name);
    assert.ok(p.x >= -18900 && p.x <= 9100 && p.z >= -20600 && p.z <= 4300, `${p.name} が範囲外`);
    assert.ok(p.name && !/�/.test(p.name), '文字化け: ' + p.name);
    // 区名は WardLabelLayer の担当なので地名ラベルには入れない（「今市」のような実在の町名は残す）
    assert.ok(!/区$/.test(p.name), '区名が混ざっている: ' + p.name);
  }
  // 大阪の主要地名が広域ラベル（major）として入っている
  for (const n of ['梅田', '中之島', '難波', '北浜', '天神橋']) {
    const p = places.places.find((q) => q.name === n);
    assert.ok(p, `${n} が無い`);
    assert.equal(p.importance, 'major', `${n} が major でない`);
  }
});

test('[33A] CityLabelLayer: 3 種のラベルを 1 つの優先度キューで配置する', () => {
  assert.match(html, /const CityLabelLayer = \(function \(\) \{/);
  // データ源は既存の canonical / 派生データ
  // [33C] ラベル用データは labels/ へ整理した（地名は OSM + PLATEAU 町丁目名称の統合）
  assert.match(html, /const PLACE_URL = 'map-data\/osaka-city\/labels\/place-labels\.json';/);
  assert.match(html, /const LANDMARK_URL = 'map-data\/osaka-city\/labels\/landmark-labels\.json';/);
  // [Mission 35K §2/§4] 駅は事業者つき・統合済みの derived/station-index.json へ移した。
  assert.match(html, /const STATION_URL = 'map-data\/osaka-city\/derived\/station-index\.json';/);
  // 優先順位: ランドマーク > 駅 > 地名
  assert.match(html, /const rank = item\.kind === 'landmark' \? \(item\.tier === 'S' \? 0 : item\.tier === 'A' \? 2\.5 : 3\)/);
  // [Mission 35K §7] 駅は町名ラベルより強い。ランドマーク S（rank 0）だけは駅より上に残す。
  assert.match(html, /: item\.kind === 'station' \? \(item\.importance === 'major' \? 0\.8\s*\n\s*: \(item\.importance === 'transfer' \|\| item\.importance === 'medium'\) \? 2\.2 : 4\.2\)/);
  // [33D] 同順位の並びに「前回出ていたか」を挟んだ（大分類の優先順位は変えない）
  assert.match(html, /pool\.sort\(\(a, z\) => \(a\.rank - z\.rank\) \|\| \(a\.stable - z\.stable\) \|\| \(a\.dc - z\.dc\)\);/);
  // 密度制御（band 別上限 + 画面グリッド）と衝突回避
  assert.match(html, /const DENSITY_CAP = \{ far: 18, mid: 36, near: 58 \};/);
  assert.match(html, /const GRID = \{ cols: 6, rows: 4, perCell: 3 \};/);
  assert.match(html, /const hits = \(c, q\) => Math\.abs\(c\.sx - q\.sx\) < \(c\.hw \+ q\.hw\) && Math\.abs\(c\.sy - q\.sy\) < \(c\.hh \+ q\.hh\);/);
  // ズームで表示数を変える
  assert.match(html, /const BANDS = \{ farM: 9000, midM: 3500 \};\s+\/\/ 道路・鉄道・公園 LOD と同じ距離帯/);
  // [Mission 35K §8] 遠景=主要駅 / 中距離=乗換駅も / 近距離=全駅
  assert.match(html, /if \(item\.kind === 'station'\) \{\s*\n\s*if \(item\.importance === 'major'\) return true;\s*\n\s*if \(item\.importance === 'transfer' \|\| item\.importance === 'medium'\) return b !== 'far';\s*\n\s*return b === 'near';\s*\n\s*\}/);
  // 画面に出るものだけ sprite 化 + texture キャッシュ
  assert.match(html, /function getSprite\(item\) \{/);
  assert.match(html, /if \(texCache\.has\(key\)\) \{ stats\.cachedTextures\+\+; return texCache\.get\(key\); \}/);
  // camera throttle
  assert.match(html, /const THROTTLE_MS = 200;/);
  // [33D] 量子化キーでの全再選定をやめ、しきい値を超えた時だけ選び直す（超えない間は大きさだけ更新）
  assert.match(html, /if \(dirty \|\| needsRelayout\(\)\) \{ dirty = false; place\(\); lastXf = xfKey\(\); return; \}/);
  // [33B] 直前にカメラを動かした直後でも正しい視点で投影する（古い行列のまま throttle で固定されると
  //   別地点のラベルが残る。実機で再現した不具合の回帰テスト）
  assert.match(html, /camera\.updateMatrixWorld\(\);[\s\S]{0,200}前回の配置をいったん全部消す/);
  assert.match(html, /for \(const rec of sprites\.values\(\)\) rec\.sprite\.visible = false;/);
  // render loop が try/catch で隔離されている
  assert.match(html, /try \{ if \(typeof CityLabelLayer !== 'undefined'\) CityLabelLayer\.update\(\); \} catch/);
});

test('[33A] ラベルの見た目: 明るい地図では濃いインク + 白ハロー、夜は白文字 + 暗ハロー', () => {
  assert.match(html, /halo: night \? 'rgba\(4,10,20,0\.82\)' : 'rgba\(255,255,255,0\.94\)',/);
  assert.match(html, /ctx\.strokeText\(text, padX, canvas\.height \/ 2 \+ R\);/);
  // 文字サイズの階層（地名 major > 地名 medium > 駅 major）
  const place = html.match(/const f = importance === 'major' \? 17 : \(importance === 'medium' \? 14 : 12\);/);
  // [Mission 35K §5] 駅は町名ラベルより強く出す（以前は地名より一段小さかった）。
  const station = html.match(/const f = importance === 'major' \? 15 : \(importance === 'transfer' \|\| importance === 'medium' \? 13\.5 : 12\);/);
  assert.ok(place && station, 'font 階層が指定どおりでない');
  assert.doesNotMatch(html, /text: '#000000'/);
  // 画面ピクセル基準のサイズ（引いても読める。world 固定サイズにしない）
  assert.match(html, /function worldPerPixel\(dist\) \{/);
  assert.match(html, /const h = rec\.pxHeight \* worldPerPixel\(dist\);/);
  assert.match(html, /const hh = \(pxHeight \/ viewportH\(\)\) \+ 0\.004;/);
  // 施設名の括弧補足は地図上では落とす（データ側の名称は変えない）
  assert.match(html, /function labelDisplayName\(name\) \{/);
  // 駅アイコンは控えめ（テクスチャ内の小さな丸。sprite は増やさない）
  assert.match(html, /ctx\.arc\(padX \+ 2\.5 \* R, canvas\.height \/ 2, 2\.6 \* R, 0, Math\.PI \* 2\);/);
});

test('[33A] labelDisplayName: 括弧の補足だけを落とす', () => {
  const m = html.match(/function labelDisplayName\(name\) \{[\s\S]*?\n  \}/);
  assert.ok(m);
  const ctx = { String };
  vm.createContext(ctx);
  vm.runInContext(m[0] + '; this.f = labelDisplayName;', ctx);
  assert.equal(ctx.f('ノースゲートビルディング（大阪ステーションシティ）'), 'ノースゲートビルディング');
  assert.equal(ctx.f('大阪府咲洲庁舎（コスモタワー）'), '大阪府咲洲庁舎');
  assert.equal(ctx.f('大阪城'), '大阪城');
  assert.equal(ctx.f('ツイン21（大阪ビジネスパーク）'), 'ツイン21');
});

test('[33A] UI: 地名 / 施設名 / 駅名 のトグルが通常パネルにある', () => {
  assert.match(html, /\{ key: 'placeLabels', label: '地名', checked: true \}/);
  assert.match(html, /\{ key: 'landmarkLabels', label: '施設名', checked: true \}/);
  assert.match(html, /if \(key === 'placeLabels'\) \{ if \(typeof CityLabelLayer !== 'undefined'\) CityLabelLayer\.setTypeVisible\('place', on\); return; \}/);
  assert.match(html, /if \(typeof CityLabelLayer !== 'undefined'\) CityLabelLayer\.setTypeVisible\('station', on\);/);
  assert.match(html, /window\.__CITY_LABEL_DEBUG__ = \(\) => CityLabelLayer\.getDebug\(\);/);
  // 旧 StationLabelLayer は自動表示しない（CityTileLayer の駅タイル依存で実機では出ていなかった）
  assert.doesNotMatch(html, /^StationLabelLayer\.show\(\);/m);
  assert.match(html, /const StationLabelLayer = \(function \(\) \{/);   // Mission14 のコードは残す
  assert.match(html, /clusterStations,/);                                // クラスタリングは再利用
  // [33B] 旧レイヤーは休止（駅 tile の件数変化で scene へ復活しない）
  assert.match(html, /if \(allowShow\) scene\.add\(group\);/);
  assert.match(html, /let allowShow = false;/);
});

test('[33A] 配色 v2: 明るく・少し鮮やかに（建物 geometry は不変）', () => {
  assert.match(html, /const MS_BG_NEUTRAL = 0xf6f7f3;/);
  assert.match(html, /water: 0x63bfe4, waterHarbor: 0x55a9d0,/);
  assert.match(html, /parkReal: 0x9bd589, parkGreen: 0x8fcd7b, grass: 0xc9e7b6,/);
  assert.match(html, /railMajor: 0x49546a, railUrban: 0x4f5f9e, railLocal: 0x69717f,/);
  assert.match(html, /const CR_USAGE_WHITEN = \{ far: 0\.46, mid: 0\.20, near: 0\.06 \};/);
  assert.match(html, /const CR_VIVID = \{ sat: 1\.24, light: 1\.03 \};/);
  assert.match(html, /const CR_STYLE = \{ exposure: 0\.93, hemi: 0\.74, sun: 1\.28, fill: 0\.26 \};/);
  // 建物の形状・高さの組み立ては触っていない
  assert.match(html, /const h = Math\.max\(2, \+a\.heightM \|\| 6\);/);
  // [Mission 35H] bucket（positions + colors）へ渡す形に変わったが、高さ h の作り方は不変。
  // [Mission 35N] 第 6 引数に高さクラスの色みが増えただけ（座標は不変）
  assert.match(html, /pushExtrude\(bucket\.pos, f\.geometryType, f\.coordinates, h, bucket\.col, hc \? CR_OTHER_TINT\[hc\] : null\);/);
  // 用途色の定義そのもの（色相の意味）は変えていない
  assert.match(html, /residential_low: 0xcaa870,/);
  assert.match(html, /office:\s+0x6d93c4,/);
});

test('[33A] crVivid: 色相を変えず彩度・明度だけ上げる', () => {
  const m = html.match(/function crVivid\(hex, satMul, lightMul\) \{[\s\S]*?\n  \}/);
  assert.ok(m, 'crVivid が取れない');
  const ctx = { Math };
  vm.createContext(ctx);
  vm.runInContext(m[0] + '; this.f = crVivid;', ctx);
  const f = ctx.f;
  // 無彩色は無彩色のまま（明度だけ上がる）
  const gray = f(0x808080, 1.24, 1.03);
  assert.equal((gray >> 16) & 255, (gray >> 8) & 255);
  assert.ok(((gray >> 16) & 255) > 0x80);
  // 有彩色は彩度が上がる（R-G-B の幅が広がる）／色相は保つ
  const before = 0x6d93c4, after = f(before, 1.24, 1.03);
  const spread = (v) => Math.max((v >> 16) & 255, (v >> 8) & 255, v & 255) - Math.min((v >> 16) & 255, (v >> 8) & 255, v & 255);
  assert.ok(spread(after) > spread(before), `彩度が上がっていない ${after.toString(16)}`);
  assert.ok((after & 255) > ((after >> 16) & 255), '青優勢（色相）が保たれていない');
  // 上限クリップ（白飛びしない）
  const bright = f(0xf4f6f2, 1.24, 1.03);
  assert.ok(((bright >> 16) & 255) <= 250 && ((bright >> 8) & 255) <= 250);
});

test('[33A] runtime: ラベルデータを読み込み、canonical residual を壊さない', async () => {
  const { runInlineScript } = require_('./_ward-ux-v1-smoke-harness.cjs');
  const boot = runInlineScript(HTML_PATH, { fetchRoot: path.join(ROOT, 'public') });
  assert.ok(boot.ok, boot.error && boot.error.message);
  const w = boot.window;
  for (let i = 0; i < 100 && !w.__CITY_LABEL_DEBUG__().loaded; i++) await new Promise((r) => setTimeout(r, 50));
  const d = w.__CITY_LABEL_DEBUG__();
  assert.equal(d.loaded, true);
  assert.equal(d.dataError, null);
  assert.ok(d.places > 300, `地名 ${d.places}`);
  assert.ok(d.landmarks > 0, `ランドマーク ${d.landmarks}`);
  assert.ok(d.stations > 100, `駅 ${d.stations}`);
  assert.equal(d.wards, 24, `区 ${d.wards}`);
  assert.ok(d.parks > 50, `公園 ${d.parks}`);
  // [Mission 35O] 建物名（building）が種別に加わった。既存の 6 種別はそのまま。
  assert.equal(JSON.stringify(d.typeVisible), JSON.stringify({ place: true, landmark: true, station: true, ward: true, park: true, river: true, building: true }));   // vm 別 realm のため JSON で比較
  assert.equal(w.__CANONICAL_SELF_CHECK__().total, 0);
  // トグルが効く
  assert.equal(w.__CITY_LABEL_TOGGLE__('place', false).place, false);
  assert.equal(w.__CITY_LABEL_TOGGLE__('place', true).place, true);
});

test('[33A] 実ブラウザ QA: 6 地点でラベルが出て、明るくなっている', { skip: skip('city-label-palette-qa.json') }, () => {
  const qa = rpt('city-label-palette-qa.json');
  assert.equal(qa.runs.after.sites.length, 6);
  for (const s of qa.runs.after.sites) {
    assert.ok(s.labels.city.visible >= 1, `${s.site}: ラベル ${s.labels.city.visible} 件`);
    assert.ok(s.labels.overlapPairs <= 2, `${s.site}: ラベルが重なっている ${s.labels.overlapPairs} 組`);
    assert.equal(s.residual, 0, s.site);
  }
  // 地名・駅データがある地点（大阪市北部は OSM 抽出の範囲外で place/station が無い）
  const rich = qa.runs.after.sites.filter((s) => s.labels.city.visibleStations >= 1
    && (s.labels.city.visiblePlaces + s.labels.city.visibleLandmarks) >= 1);
  assert.ok(rich.length >= 5, `駅名 + 地名/施設が出た地点 ${rich.length}/6`);
  for (const c of qa.comparison) {
    assert.ok(c.luminance.after >= c.luminance.before, `${c.site}: 明るくなっていない`);
  }
  assert.deepEqual(qa.runs.after.errors, []);
});

test('[33A] validator が PASS', { skip: skip('city-labels-palette-validation.json') }, () => {
  const v = rpt('city-labels-palette-validation.json');
  assert.equal(v.RESULT, 'PASS', JSON.stringify(v.errors));
  assert.equal(v.classification, 'CITY_LABELS_PALETTE_SUCCESS');
  assert.equal(v.labelDataReady, true);
  assert.equal(v.labelsVisibleAtAllSites, true);
  assert.equal(v.labelOverlapPairs, 0);
  assert.equal(v.labelImplementationOk, true);
  assert.equal(v.paletteChanged, true);
  assert.equal(v.geometryUntouched, true);
  assert.equal(v.buildingGeometryMutation, 0);
  assert.equal(v.roadV3Mutation, 0);
  assert.equal(v.projectionMutation, 0);
  assert.equal(v.productionModified, false);
  assert.equal(v.protectedModified, false);
});
