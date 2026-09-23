// tests/high-lod-visual-quality.test.js
// [Mission 34B] 高 LOD の見え方（屋根形状・段差が読めるか）
//   - 屋根と壁の色の分け方（色相は変えず、輝度 +9% / 彩度 −3%）
//   - 材質（Standard / flatShading / roughness / metalness）
//   - 主光の向き（南西〜西南西・仰角 47°）と影カメラの追従
//   - 比較モード（LOD1 ONLY / HIGH LOD / LOD DIFF / ROOF QA）と camera preset
//   - geometry / 位置 / 投影を一切変えていないこと
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MATERIAL_SPEC, LIGHT_SPEC, SITE_HIGH_LOD_COUNT } from '../tools/validate/high-lod-visual-quality.js';
import { SITES, VIEW, PERF_SITES } from '../tools/audit/high-lod-visual-qa.js';
import { devUiIsGated } from '../tools/lib/production-invariants.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEV = path.join(ROOT, 'public', 'osaka_3d_buildings.ward-ux-v1.html');
const PROD = path.join(ROOT, 'public', 'osaka_3d_buildings.html');
const html = fs.readFileSync(DEV, 'utf-8');
const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };
const rpt = (n) => rj(path.join(ROOT, 'data', 'reports', n));
const skip = (n) => (!rpt(n) && 'no report');

// HTML から tintRoof を切り出して、そのまま呼べるようにする（実装と試験で式を二重に持たない）
function loadTintRoof() {
  const s = html.indexOf('const ROOF_TINT = { lumRatio');
  const e = html.indexOf('ROOF_TINT_CACHE.set(key, out);', s);
  assert.ok(s > 0 && e > s, 'tintRoof の定義が見つからない');
  const code = html.slice(s, html.indexOf('}', e + 40) + 1);
  // eslint-disable-next-line no-new-func
  return new Function(code + ' ; return { tintRoof, relLum, hslToRgb, ROOF_TINT };')();
}
const M = loadTintRoof();
const relLum = M.relLum;
const satOf = (c) => {
  const mx = Math.max(c.r, c.g, c.b), mn = Math.min(c.r, c.g, c.b), l = (mx + mn) / 2;
  if (mx === mn) return 0;
  const d = mx - mn;
  return l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
};
const hueOf = (c) => {
  const mx = Math.max(c.r, c.g, c.b), mn = Math.min(c.r, c.g, c.b);
  if (mx === mn) return null;
  const d = mx - mn;
  if (mx === c.r) return ((c.g - c.b) / d + (c.g < c.b ? 6 : 0)) / 6;
  if (mx === c.g) return ((c.b - c.r) / d + 2) / 6;
  return ((c.r - c.g) / d + 4) / 6;
};
// 実際に使われている用途色（33A の vivid 済み）を再現する
const USAGE = { residential_low: 0xcaa870, residential_mid: 0x9aa1c6, commercial: 0xd6a259, office: 0x6d93c4,
  industrial: 0x8894a2, public: 0x8d9acc, school: 0xb7bd68, medical: 0x72b2a4, hotel: 0xc78f9b, other: 0xb2bac0 };
const WHITEN = { far: 0.46, mid: 0.20, near: 0.06 };
function blend(a, b, t) {
  const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
  const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
  return (Math.round(ar + (br - ar) * t) << 16) | (Math.round(ag + (bg - ag) * t) << 8) | Math.round(ab + (bb - ab) * t);
}
function vivid(hex, sm, lm) {
  const r = ((hex >> 16) & 255) / 255, g = ((hex >> 8) & 255) / 255, b = (hex & 255) / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
  let h = 0, sa = 0;
  if (mx !== mn) {
    const d = mx - mn;
    sa = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    if (mx === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (mx === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }
  const s2 = Math.min(1, sa * sm), l2 = Math.min(0.95, l * lm);
  const c = M.hslToRgb(h, s2, l2);
  return { r: c.r, g: c.g, b: c.b };
}
const wallColors = (band) => Object.entries(USAGE).map(([k, v]) => [k, vivid(blend(v, 0xffffff, WHITEN[band]), 1.24, 1.03)]);

// ── §4/§5 屋根と壁の色の分け方 ────────────────────────────────────────────
test('[34B §4] 屋根は全用途色で壁より +6〜12% 明るい', () => {
  for (const band of ['near', 'mid']) {
    for (const [cat, w] of wallColors(band)) {
      const r = M.tintRoof(w);
      const ratio = relLum(r.r, r.g, r.b) / relLum(w.r, w.g, w.b);
      assert.ok(ratio >= MATERIAL_SPEC.roofLumRatio[0] && ratio <= MATERIAL_SPEC.roofLumRatio[1],
        `${band}/${cat} の輝度比 ${ratio.toFixed(4)} が ${MATERIAL_SPEC.roofLumRatio} の外`);
    }
  }
});

test('[34B §16] 屋根補正で色相は変わらない（白く塗らない）', () => {
  for (const [cat, w] of wallColors('near')) {
    const r = M.tintRoof(w);
    const hw = hueOf(w), hr = hueOf(r);
    assert.ok(hw != null && hr != null, cat + ' の色相が取れない');
    assert.ok(Math.abs(hr - hw) * 360 < 0.5, `${cat} の色相が ${(Math.abs(hr - hw) * 360).toFixed(2)}° ずれた`);
    // 白（無彩色）へ寄せていない：彩度が残っている
    assert.ok(satOf(r) > satOf(w) * 0.9, cat + ' の彩度が落ちすぎ');
  }
});

test('[34B §4] 彩度の低下は 0〜5% に収まる', () => {
  for (const [cat, w] of wallColors('mid')) {
    const drop = 1 - satOf(M.tintRoof(w)) / satOf(w);
    assert.ok(drop >= MATERIAL_SPEC.roofSatDrop[0] - 1e-9 && drop <= MATERIAL_SPEC.roofSatDrop[1],
      `${cat} の彩度低下 ${(drop * 100).toFixed(2)}% が範囲外`);
  }
});

test('[34B §4] 明度を一定倍する実装ではない（用途色ごとのばらつきを潰している）', () => {
  // L を 1.09 倍する素朴な実装だと輝度比が 1.038〜1.130 にばらつき §4 を外れる。
  // 輝度そのものを目標にしているので、ばらつきは 0.001 未満に収まる。
  const ratios = wallColors('near').map(([, w]) => {
    const r = M.tintRoof(w);
    return relLum(r.r, r.g, r.b) / relLum(w.r, w.g, w.b);
  });
  assert.ok(Math.max(...ratios) - Math.min(...ratios) < 0.001, '輝度比がばらついている: ' + JSON.stringify(ratios));
  assert.match(html, /const ROOF_TINT = \{ lumRatio: 1\.09, sat: 0\.97, maxLight: 0\.96 \};/);
});

test('[34B §4] 屋根の補正結果は cache される（頂点ごとに計算し直さない）', () => {
  const w = wallColors('near')[0][1];
  assert.equal(M.tintRoof(w), M.tintRoof({ ...w }), '同じ色で同じオブジェクトが返らない＝cache が効いていない');
});

// ── §4 材質 ───────────────────────────────────────────────────────────────
test('[34B §4] 高 LOD の material は Standard + flatShading、roughness / metalness は規定内', () => {
  assert.match(html, /const SURFACE_PBR = \{/);
  assert.match(html, /new THREE\.MeshStandardMaterial\(\{\s*\n\s*vertexColors: true, side: THREE\.DoubleSide, flatShading: true,/);
  assert.match(html, /roughness: pbr\.roughness, metalness: pbr\.metalness,/);
  const block = html.slice(html.indexOf('const SURFACE_PBR = {'), html.indexOf('const relLum ='));
  const rough = [...block.matchAll(/roughness: ([\d.]+)/g)].map((m) => Number(m[1]));
  const metal = [...block.matchAll(/metalness: ([\d.]+)/g)].map((m) => Number(m[1]));
  assert.ok(rough.length >= 5 && metal.length >= 5, 'surface 種別ごとの設定が足りない');
  for (const v of rough) assert.ok(v >= MATERIAL_SPEC.roughness[0] && v <= MATERIAL_SPEC.roughness[1], 'roughness 範囲外: ' + v);
  for (const v of metal) assert.ok(v >= MATERIAL_SPEC.metalness[0] && v <= MATERIAL_SPEC.metalness[1], 'metalness 範囲外: ' + v);
  // 屋根のほうが壁より少しだけ滑らか（面の向きが読めるように）
  assert.ok(Number(block.match(/roof:\s+\{ roughness: ([\d.]+)/)[1]) < Number(block.match(/wall:\s+\{ roughness: ([\d.]+)/)[1]));
});

test('[34B §12] 通常の高 LOD 表示では透明化しない', () => {
  const block = html.slice(html.indexOf('function materialFor(kind)'), html.indexOf('function qaMaterialFor'));
  assert.doesNotMatch(block, /transparent:\s*true/);
  assert.doesNotMatch(block, /opacity:/);
});

test('[34B §11] 全建物への黒 outline は入れていない', () => {
  const block = html.slice(html.indexOf('const BuildingLODLayer'), html.indexOf('const CanonicalRuntime'));
  assert.doesNotMatch(block, /EdgesGeometry|LineSegments|LineBasicMaterial/);
});

test('[34B §6] 33A/33B の用途色 palette は変えていない', () => {
  assert.match(html, /residential_low: 0xcaa870,/);
  assert.match(html, /const CR_VIVID = \{ sat: 1\.24, light: 1\.03 \};/);
  assert.match(html, /const CR_USAGE_WHITEN = \{ far: 0\.46, mid: 0\.20, near: 0\.06 \};/);
  // 高 LOD の色は LOD1 と同じ material から取る
  assert.match(html, /CanonicalRuntime\.buildingMaterial\(cat, band === 'near' \? 'near' : 'mid'\)/);
});

// ── §7/§8/§9 光 ───────────────────────────────────────────────────────────
test('[34B §7] 主光は南西〜西南西・仰角 40〜55°', () => {
  const m = html.match(/sunColor: 0xfff4e0, sunIntensity: 1\.2, sunPosition: \[(-?\d+), (-?\d+), (-?\d+)\],\n\s+fillColor/);
  assert.ok(m, 'day の sunPosition が読めない');
  const [x, y, z] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const az = ((Math.atan2(x, -z) * 180 / Math.PI) + 360) % 360;
  const el = Math.atan2(y, Math.hypot(x, z)) * 180 / Math.PI;
  assert.ok(az >= LIGHT_SPEC.azimuthDeg[0] && az <= LIGHT_SPEC.azimuthDeg[1], 'azimuth ' + az.toFixed(1));
  assert.ok(el >= LIGHT_SPEC.elevationDeg[0] && el <= LIGHT_SPEC.elevationDeg[1], 'elevation ' + el.toFixed(1));
  // 真上からだけの光ではない
  assert.ok(el < 80, '真上からの光になっている');
});

test('[34B §7] 初期値と VISUAL_CONFIG の向きが一致している', () => {
  const init = html.match(/sun\.position\.set\((-?\d+), (-?\d+), (-?\d+)\);\nsun\.castShadow/);
  assert.ok(init, '初期 sun.position が読めない');
  const cfg = html.match(/sunColor: 0xfff4e0, sunIntensity: 1\.2, sunPosition: \[(-?\d+), (-?\d+), (-?\d+)\],\n\s+fillColor/);
  const a = [Number(init[1]), Number(init[2]), Number(init[3])];
  const b = [Number(cfg[1]), Number(cfg[2]), Number(cfg[3])];
  const az = (v) => ((Math.atan2(v[0], -v[2]) * 180 / Math.PI) + 360) % 360;
  const el = (v) => Math.atan2(v[1], Math.hypot(v[0], v[2])) * 180 / Math.PI;
  assert.ok(Math.abs(az(a) - az(b)) < 1, '初期値と config で方位が違う');
  assert.ok(Math.abs(el(a) - el(b)) < 1, '初期値と config で仰角が違う');
});

test('[34B §8] 補助光は残っていて、主光の反対側にある', () => {
  const f = html.match(/fillLight\.position\.set\((-?\d+), (-?\d+), (-?\d+)\);/);
  assert.ok(f, 'fillLight の位置が読めない');
  const fa = ((Math.atan2(Number(f[1]), -Number(f[3])) * 180 / Math.PI) + 360) % 360;
  const s = html.match(/sun\.position\.set\((-?\d+), (-?\d+), (-?\d+)\);\nsun\.castShadow/);
  const sa = ((Math.atan2(Number(s[1]), -Number(s[3])) * 180 / Math.PI) + 360) % 360;
  const signed = Math.abs((((fa - sa + 180) % 360) + 360) % 360 - 180);   // 0〜180 の角度差
  assert.ok(Math.abs(signed - 180) < 30, `主光 ${sa.toFixed(0)}° と補助光 ${fa.toFixed(0)}° が対角になっていない（差 ${signed.toFixed(0)}°）`);
  assert.match(html, /const fillLight = new THREE\.DirectionalLight\(0x6fa8dc, 0\.6\);/);
});

test('[34B §9] 環境光・露出は 33A のまま（明るくしすぎていない）', () => {
  assert.match(html, /const CR_STYLE = \{ exposure: 0\.93, hemi: 0\.74, sun: 1\.28, fill: 0\.26 \};/);
  assert.match(html, /new THREE\.HemisphereLight\(0xbfd8f0, 0xe8dcc8, 1\.0\)/);
});

test('[34B §7] 影の正射影カメラが注視点へ追従する', () => {
  assert.match(html, /const SUN_OFFSET = \{ x: -2224, y: 2877, z: 1500 \};/);
  assert.match(html, /sun\.position\.set\(cs\.tgt\.x \+ SUN_OFFSET\.x, SUN_OFFSET\.y, cs\.tgt\.z \+ SUN_OFFSET\.z\);/);
  assert.match(html, /if \(sun\.target\.parent !== scene\) scene\.add\(sun\.target\);/);
  assert.match(html, /sun\.target\.position\.set\(cs\.tgt\.x, 0, cs\.tgt\.z\);/);
  // 影の範囲は見ている範囲に合わせて絞る（負荷を増やさないため）
  assert.match(html, /const ext = Math\.max\(320, Math\.min\(2600, cs\.r \* 1\.3\)\);/);
  // 時間帯を切り替えたら offset も追従する
  assert.match(html, /SUN_OFFSET\.x = L\.sunPosition\[0\]; SUN_OFFSET\.y = L\.sunPosition\[1\]; SUN_OFFSET\.z = L\.sunPosition\[2\];/);
  // camUpd から毎回呼ばれる（TDZ で落ちないよう try で囲う）
  assert.match(html, /try \{ updateSunFollow\(\); \} catch \(e\) \{ \/\* noop \*\/ \}/);
});

test('[34B §28] 影マップの更新は間引く（追従で増えた負荷を抑える）', () => {
  assert.match(html, /renderer\.shadowMap\.autoUpdate = false;/);
  const m = html.match(/const SHADOW_THROTTLE = \{ every: (\d+), tick: 0 \};/);
  assert.ok(m, 'SHADOW_THROTTLE が無い');
  assert.ok(Number(m[1]) >= 2 && Number(m[1]) <= 4, '間引き幅が極端: ' + m[1]);
  // 描画ループで needsUpdate を立てる（さもないと影が一度も描かれない）
  assert.match(html, /renderer\.shadowMap\.needsUpdate = \(SHADOW_THROTTLE\.tick === 0\);/);
  // 影 OFF のときは触らない
  assert.match(html, /if \(renderer\.shadowMap\.enabled\) \{\n\s+SHADOW_THROTTLE\.tick/);
});

// ── §22 比較モード ────────────────────────────────────────────────────────
test('[34B §22] LOD1 ONLY / HIGH LOD / LOD DIFF / ROOF QA が揃っている', () => {
  assert.match(html, /const mode = \(m === 'lod1' \|\| m === 'diff' \|\| m === 'roof'\) \? m : 'high';/);
  assert.match(html, /window\.__BUILDING_LOD_MODE__ = \(m\) => BuildingLODLayer\.setViewMode\(m\);/);
  // ボタン id は 'lod-view-mode-' + mk で組み立てるので、定義側を見る
  assert.match(html, /b\.id = 'lod-view-mode-' \+ mk;/);
  for (const mk of ["'lod1', 'LOD1 ONLY'", "'high', 'HIGH LOD'", "'diff', 'LOD DIFF'"]) {
    assert.ok(html.includes('[' + mk), mk + ' のボタン定義が無い');
  }
  assert.ok(html.includes("roofQaBtn.id = 'lod-roof-qa-toggle'"), 'ROOF QA ボタンが無い');
  // LOD1 ONLY は高 LOD レイヤーごと止める
  assert.match(html, /if \(mode === 'lod1'\) \{ setEnabled\(false\); \}/);
  // 止めているあいだ古い集計を残さない
  assert.match(html, /stats\.tilesVisible = 0; stats\.visibleLod2 = 0; stats\.visibleLod3 = 0; stats\.triangles = 0; stats\.drawCalls = 0;/);
});

test('[34B §22] LOD DIFF は LOD1 灰 / LOD2 青 / LOD3 金', () => {
  assert.match(html, /const QA_COLOR = \{ lod2: 0x3f8fe0, lod3: 0xd8a83a \};/);
  assert.match(html, /const c2 = new THREE\.Color\(QA_COLOR\.lod2\), c3 = new THREE\.Color\(QA_COLOR\.lod3\);/);
  assert.match(html, /const c = r\.lod === 3 \? c3 : c2;/);
  assert.match(html, /function setBuildingDiffGray\(on\) \{/);
  assert.match(html, /CanonicalRuntime\.setBuildingDiffGray\(mode === 'diff'\)/);
  // 灰色は diff のときだけ。通常表示では必ず用途色へ戻す
  assert.match(html, /o\.material = want \? crBuildingGrayMaterial\(\) : crBuildingMaterial\(o\.userData\.usageCategory, o\.userData\.crBuildingBand \|\| 'mid'\);/);
  // diff 中に読み込まれたタイルも灰色になる
  assert.match(html, /material: crBuildingDiffGray \? crBuildingGrayMaterial\(\) : crBuildingMaterial\(cat, band\)/);
});

test('[34B §22] 比較モードは material ではなく頂点カラーを差し替える（draw call を増やさない）', () => {
  assert.match(html, /baseColor: geom\.getAttribute\('color'\), alt: null/);
  assert.match(html, /mesh\.geometry\.setAttribute\('color', ud\.alt\.attr\);/);
  assert.match(html, /if \(!alt\) \{ ud\.alt = null; mesh\.geometry\.setAttribute\('color', ud\.baseColor\); return; \}/);
  // 新しく作ったタイルにも現在のモードを反映する
  assert.match(html, /applyViewModeToMesh\(mesh\);\n\s+g\.add\(mesh\);/);
});

test('[34B §22] QA モードは production に出さない', () => {
  // [Mission 35G] 入口は production のバイトにも入る。既定が通常表示（'high'）で、
  //   LOD VIEW のトグルが production で非表示になる箱の中にあることで担保する。
  const prod = fs.readFileSync(PROD, 'utf-8');
  assert.match(prod, /let viewMode = 'high';/, '既定が通常表示でない');
  assert.deepEqual(devUiIsGated(['lod-view-toggle']), { ok: true });
});

// ── §13 camera preset ─────────────────────────────────────────────────────
test('[34B §13] LOD VIEW の preset は pitch 45〜55° / fov 40〜48° / 600〜1200m', () => {
  const m = html.match(/const LOD_VIEW_PRESET = \{ pitchDeg: (\d+), fov: (\d+), r: (\d+), headingDeg: (-?\d+) \};/);
  assert.ok(m, 'LOD_VIEW_PRESET が読めない');
  const [pitch, fov, r] = [Number(m[1]), Number(m[2]), Number(m[3])];
  assert.ok(pitch >= 45 && pitch <= 55, 'pitch ' + pitch);
  assert.ok(fov >= 40 && fov <= 48, 'fov ' + fov);
  assert.ok(r >= 600 && r <= 1200, 'r ' + r);
  // cs.ph は天頂角なので 90 − pitch を入れる
  assert.match(html, /cs\.ph = Math\.max\(cs\.minPh, Math\.min\(cs\.maxPh, \(90 - P\.pitchDeg\) \* Math\.PI \/ 180\)\);/);
  // camUpd が毎フレーム fov を書き戻すので CAMERA_MODE_FOV 経由で入れる
  assert.match(html, /CAMERA_MODE_FOV\[cameraMode\] = P\.fov;/);
  // 抜けたら元の fov とラベルを戻す
  assert.match(html, /CAMERA_MODE_FOV\[cameraMode\] = \(lodViewPrevFov != null\) \? lodViewPrevFov : WARD_FOV;/);
});

test('[34B §13] 5 地点の preset が揃っている', () => {
  for (const s of ['honmachi', 'umeda', 'nakanoshima', 'osakacastle', 'shinosaka']) {
    assert.ok(html.includes(`id: '${s}'`), s + ' の preset が無い');
    assert.ok(html.includes(`id = 'lod-view-site-' + s.id`), '地点ボタンが無い');
  }
  for (const label of ['本町', '梅田', '中之島', '大阪城', '新大阪']) {
    assert.ok(html.includes(`label: '${label}'`), label + ' のラベルが無い');
  }
  // QA ツールの地点と HTML の preset が同じ座標を指している
  for (const s of SITES) {
    const m = html.match(new RegExp(`id: '${s.id}', label: '[^']+', x: (-?\\d+), z: (-?\\d+)`));
    assert.ok(m, s.id + ' の座標が読めない');
    assert.equal(Number(m[1]), s.x, s.id + ' の x が QA と違う');
    assert.equal(Number(m[2]), s.z, s.id + ' の z が QA と違う');
  }
});

test('[34B §13] LOD VIEW 中はラベル密度を落とし、抜けたら戻す', () => {
  assert.match(html, /const LOD_VIEW_QUIET_LABELS = \['place', 'park', 'river'\];/);
  assert.match(html, /for \(const k of LOD_VIEW_QUIET_LABELS\) \{ try \{ CityLabelLayer\.setTypeVisible\(k, false\); \}/);
  assert.match(html, /for \(const k of LOD_VIEW_QUIET_LABELS\) \{ try \{ CityLabelLayer\.setTypeVisible\(k, true\); \}/);
});

// ── §1 geometry / 位置 / 投影は変えない ───────────────────────────────────
test('[34B §1] 頂点座標をそのまま積む経路は変えていない', () => {
  assert.match(html, /acc\.pos\.push\(p\.positions\[i\], p\.positions\[i \+ 1\], p\.positions\[i \+ 2\]\);/);
  // 34B で触ったのは色だけ
  assert.match(html, /const cc = p\.kind === 'roof' \? tintRoof\(col\) : col;/);
  assert.match(html, /acc\.col\.push\(cc\.r, cc\.g, cc\.b\);/);
  assert.doesNotMatch(html, /const shade = p\.kind === 'roof' \? ROOF_SHADE/);
});

test('[34B §1] Zone VII 変換は復活していない', () => {
  assert.doesNotMatch(html, /latLonToJPRect\s*\(/);
});

// ── 実計測（レポートがあるときだけ）─────────────────────────────────────
test('[34B §2] 変更前の計測が残っている', { skip: skip('high-lod-visual-qa.json') }, () => {
  const v = rpt('high-lod-visual-qa.json');
  const b = v.phases && v.phases.before;
  assert.ok(b, 'before の計測が無い');
  assert.equal(b.sites.length, SITES.length);
  // 変更前は屋根のほうが暗かった（これが 34B の出発点）
  for (const s of b.sites) assert.ok(s.high.roofWall.colorRatio < 1.0, s.site + ' の変更前 roof/wall が 1 未満でない');
});

test('[34B §3] 変更後は屋根が壁より明るく、LOD1 との差も出ている', { skip: skip('high-lod-visual-qa.json') }, () => {
  const v = rpt('high-lod-visual-qa.json');
  const a = v.phases && v.phases.after;
  if (!a) return;   // after 未実行のときは何も主張しない
  for (const s of a.sites) {
    const r = s.high.roofWall.colorRatio;
    assert.ok(r >= MATERIAL_SPEC.roofLumRatio[0] && r <= MATERIAL_SPEC.roofLumRatio[1], `${s.site} roof/wall=${r}`);
    assert.ok(s.high.roofWall.litRatio >= 1.0, `${s.site} は受光込みで屋根が壁より暗い: ${s.high.roofWall.litRatio}`);
    assert.ok(s.high.pixels.localContrast > s.lod1.pixels.localContrast, `${s.site} は HIGH LOD と LOD1 で階調が変わらない`);
  }
});

test('[34B §1] 描いている棟数は 34A から変わっていない', { skip: skip('high-lod-visual-qa.json') }, () => {
  const v = rpt('high-lod-visual-qa.json');
  const a = v.phases && v.phases.after;
  if (!a) return;
  for (const s of a.sites) {
    const got = s.high.lod.visibleLod2 + s.high.lod.visibleLod3;
    assert.equal(got, SITE_HIGH_LOD_COUNT[s.site], s.site + ' の高 LOD 棟数が変わった');
  }
});

test('[34B §1] before / after で描画中の geometry 指紋が一致する', { skip: skip('high-lod-visual-qa.json') }, () => {
  const v = rpt('high-lod-visual-qa.json');
  if (!v.comparison) return;
  const compared = v.comparison.reduce((n, c) => n + ((c.geometry && c.geometry.comparedMeshes) || 0), 0);
  const changed = v.comparison.reduce((n, c) => n + ((c.geometry && c.geometry.changedMeshes) || 0), 0);
  if (compared === 0) return;   // before に指紋が無い版で撮っていた場合
  assert.equal(changed, 0, '描画中の geometry が変わっている');
});

test('[34B §28] 性能は 4 地点 × ON/OFF で測っている', { skip: skip('high-lod-visual-qa.json') }, () => {
  const v = rpt('high-lod-visual-qa.json');
  const a = v.phases && v.phases.after;
  if (!a || !a.performance) return;
  assert.equal(a.performance.length, PERF_SITES.length * 2);
  for (const p of a.performance) assert.ok(p.fpsAverage > 0 && p.trianglesAvg > 0, p.site + ' の計測が空');
});

test('[34B §23-§27] 屋根に段差があり、footprint からはみ出していない', { skip: skip('high-lod-roof-structure-qa.json') }, () => {
  const r = rpt('high-lod-roof-structure-qa.json');
  assert.equal(r.sites.length, SITES.length);
  for (const s of r.sites) {
    assert.ok(s.roof.buildingsWithRoof > 0, s.site + ' で屋根面が 1 つも取れていない');
    assert.ok(s.roof.multiLevelPct >= 15, `${s.site} は段差のある屋根が ${s.roof.multiLevelPct}% しかない`);
    // はみ出しは 34A の geometry 由来（34B では未変更）。多数の棟でずれていないことだけを見る。
    const pct = 100 * s.roof.overhang.over2m / s.roof.overhang.checked;
    assert.ok(pct <= 2, `${s.site} で屋根が footprint からはみ出す棟が ${pct.toFixed(2)}%`);
  }
  const castle = r.sites.find((s) => s.site === 'osakacastle');
  assert.ok(castle.landmark && castle.landmark.available, 'LandmarkHD の状態が取れていない');
  assert.equal(castle.landmark.landmarkOwnedDrawnByHighLod, 0, 'LandmarkHD の棟を高 LOD も描いている');
});

test('[34B §30] validator が通っている', { skip: skip('high-lod-visual-quality-validation.json') }, () => {
  const r = rpt('high-lod-visual-quality-validation.json');
  assert.equal(r.geometryMutation, 0);
  assert.equal(r.positionMutation, 0);
  assert.equal(r.projectionMutation, 0);
  assert.equal(r.highLodRoofReadable, true);
  assert.equal(r.roofWallVisualSeparation, true);
  assert.equal(r.lodDiffQaAvailable, true);
  assert.equal(r.lodCameraPresetsAvailable, true);
  assert.equal(r.productionModified, false);
  assert.equal(r.protectedModified, false);
  assert.equal(r.classification, 'HIGH_LOD_VISUAL_QUALITY_SUCCESS');
});

test('[34B] QA ツールの camera は preset と同じ向き', () => {
  assert.equal(VIEW.fov, 44);
  assert.ok(Math.abs((90 - VIEW.ph * 180 / Math.PI) - 50) < 0.01, 'QA の pitch が preset と違う');
  assert.equal(VIEW.r, 900);
});
