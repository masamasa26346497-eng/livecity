// tests/directional-balance.test.js
// [Mission 35I] 方角によって街の印象が変わりすぎる問題の調整
//   - 方向依存の主因が Lambert の太陽光だったこと（壁の頂点カラーではない）
//   - 壁の幅を詰めても、屋根と接地の陰＝方向に依らない立体感は残ること
//   - fill を厚くして暗い側だけを持ち上げる設計になっていること
//   - 35H / 35I を同じ画面で比べられること
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  WALL_TARGET, FOOT_TARGET, MIN_ROOF_WALL_GAP, FPS_DROP_BUDGET_PCT, BUILDING_COUNT,
} from '../tools/validate/directional-balance.js';
import {
  SITES, AZIMUTHS, VIEW, TUNINGS, LUMA_RATIO_TARGET, MIN_SCENE_LUMA, MAX_CLIPPED_FRACTION,
  directionStats, worldOf,
} from '../tools/audit/directional-balance-qa.js';
import { devUiIsGated } from '../tools/lib/production-invariants.js';
import { classifyPointToWard } from '../tools/lib/point-in-polygon.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEV = path.join(ROOT, 'public', 'osaka_3d_buildings.ward-ux-v1.html');
const PROD = path.join(ROOT, 'public', 'osaka_3d_buildings.html');
const html = fs.readFileSync(DEV, 'utf-8');
const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };
const rpt = (n) => rj(path.join(ROOT, 'data', 'reports', n));
const skip = (n) => (!rpt(n) && 'no report');

/** 明暗の式を HTML から切り出す（実装と試験で式を二重に持たない）。 */
function loadShading() {
  const s = html.indexOf('const SUN_AZ_DEG = 236, SUN_EL_DEG = 47;');
  const e = html.indexOf('const shadeByte =', s);
  assert.ok(s > 0 && e > s, '明暗の定義が見つからない');
  // eslint-disable-next-line no-new-func
  return new Function(html.slice(s, html.indexOf('\n', e) + 1)
    + ' ; return { CR_SUN_H, CR_DEPTH, DEPTH_TUNINGS, wallShade, heightShade, applyDepthTuning };')();
}
const S = loadShading();
const H = S.CR_SUN_H;
const wallOf = () => ({ lit: +S.wallShade(H.x, H.z).toFixed(3), side: +S.wallShade(-H.z, H.x).toFixed(3),
  dark: +S.wallShade(-H.x, -H.z).toFixed(3) });

// ── §5 壁の幅を詰めた ───────────────────────────────────────────────────
test('35I 壁の倍率が §5 の目標に入っている', () => {
  const w = wallOf();
  for (const [k, [a, b]] of Object.entries(WALL_TARGET)) {
    assert.ok(w[k] >= a && w[k] <= b, `${k} が ${w[k]}（目標 ${a}〜${b}）`);
  }
  // 背面を暗くしすぎない（35H の 0.70 は低すぎた）
  assert.ok(w.dark >= 0.80, '背面壁が暗すぎる: ' + w.dark);
  // 3 段階の順序は保つ
  assert.ok(w.dark < w.side && w.side < w.lit);
  assert.equal(S.CR_DEPTH.roof, 1.0, '屋根が基準でない');
});

test('35I 壁の幅は 35H より狭い', () => {
  const t = S.DEPTH_TUNINGS;
  const spread = (id) => t[id].wallLit - t[id].wallDark;
  assert.ok(spread('35I') < spread('35H'), `幅が狭まっていない ${spread('35H')} → ${spread('35I')}`);
  assert.ok(Math.abs(spread('35H') - 0.23) < 1e-9, '35H の幅が 0.23 でない');
  assert.ok(Math.abs(spread('35I') - 0.15) < 1e-9, '35I の幅が 0.15 でない');
});

// ── §6 wrap lighting（暗部を持ち上げる） ────────────────────────────────
test('35I 壁の明暗は max(dot,0) ではなく全周なめらか（暗部も落としきらない）', () => {
  // 真後ろを向いた壁でも wallDark で止まり、0 にはならない＝ wrap lighting
  const back = S.wallShade(-H.x, -H.z);
  assert.ok(back > 0.7, '背面が落ちすぎ（max(dot,0) 的になっている）');
  // 全周 360° で単調に変化し、平坦な区間（打ち切り）が無い
  const vals = [];
  for (let d = 0; d < 360; d += 10) {
    const a = d * Math.PI / 180;
    vals.push(S.wallShade(Math.sin(a), -Math.cos(a)));
  }
  const uniq = new Set(vals.map((v) => v.toFixed(4)));
  assert.ok(uniq.size > 30, '同じ値が続いている＝どこかで打ち切っている');
  assert.ok(Math.min(...vals) >= S.CR_DEPTH.wallDark - 1e-9);
  assert.ok(Math.max(...vals) <= S.CR_DEPTH.wallLit + 1e-9);
});

// ── §7 接地の陰は残す ───────────────────────────────────────────────────
test('35I 接地の陰は残っていて、35H より少しだけ緩い', () => {
  const foot = +S.heightShade(0, 30).toFixed(3);
  const tall = +S.heightShade(0, 180).toFixed(3);
  assert.ok(foot >= FOOT_TARGET.base[0] && foot <= FOOT_TARGET.base[1], '足元 ' + foot);
  assert.ok(tall >= FOOT_TARGET.tall[0] && tall <= FOOT_TARGET.tall[1], '高層の足元 ' + tall);
  // 消していない
  assert.ok(foot < 0.95, '接地の陰が消えている');
  assert.ok(tall < foot, '高層のほうが足元が沈んでいない');
  // 上端では補正が消える
  assert.equal(+S.heightShade(30, 30).toFixed(6), 1);
  // 35H より緩い
  const t = S.DEPTH_TUNINGS;
  assert.ok(t['35I'].baseDarken > t['35H'].baseDarken, '接地の陰が緩んでいない');
  assert.ok(t['35I'].massDarken < t['35H'].massDarken, '量感の落としが緩んでいない');
});

// ── §13 方向に依らない立体感 ────────────────────────────────────────────
test('35I 屋根と壁の差＝方向に依らない立体感が残っている', () => {
  const w = wallOf();
  // 屋根は上を向いているのでカメラ方位に関係なく明るい。これが方向非依存の奥行き。
  assert.ok(S.CR_DEPTH.roof - w.dark >= MIN_ROOF_WALL_GAP,
    `屋根と背面壁の差が ${(S.CR_DEPTH.roof - w.dark).toFixed(3)}（下限 ${MIN_ROOF_WALL_GAP}）`);
  assert.ok(S.CR_DEPTH.roof > w.lit, '屋根が明るい壁より暗い');
});

// ── §3/§8 主因は太陽光だった ────────────────────────────────────────────
test('35I 主因の Lambert 太陽光を緩め、fill で暗い側を持ち上げている', () => {
  const t = S.DEPTH_TUNINGS;
  const a = t['35H'].light.STANDARD, b = t['35I'].light.STANDARD;
  // fill（太陽の反対側から当たる）を厚くするのが要点
  assert.ok(b.fill > a.fill * 2, `fill を厚くしていない ${a.fill} → ${b.fill}`);
  // sun は下げるが、ambient で塗りつぶすのではない
  assert.ok(b.sun < a.sun, 'sun を下げていない');
  assert.ok(b.hemi > a.hemi, 'hemi を上げていない');
  // 面の差は保つ（33A の 1.73 より上を維持する＝平板に戻さない）
  assert.ok(b.sun / b.hemi > 1.73, `sun/hemi が ${(b.sun / b.hemi).toFixed(2)} まで落ちて平板になる`);
  // 露出は上げすぎない
  assert.ok(b.exposure >= 0.95 && b.exposure <= 1.10, '露出 ' + b.exposure);
});

test('35I fill を厚くするぶん、その色を無彩色寄りにする（§10 青へ寄らない）', () => {
  assert.match(html, /const CR_FILL_COLOR_DEPTH = 0x[0-9a-f]{6};/);
  const m = html.match(/const CR_FILL_COLOR_DEPTH = (0x[0-9a-f]{6});/);
  const hex = parseInt(m[1], 16);
  const r = (hex >> 16) & 255, g = (hex >> 8) & 255, b = hex & 255;
  // 青成分が突出していない＝ほぼ無彩色
  assert.ok(b - r <= 24, `fill が青すぎる（B−R = ${b - r}）`);
  assert.ok(b >= r, 'fill が暖色になっている（空からの光ではない）');
  assert.ok(Math.min(r, g, b) > 150, 'fill が暗すぎる');
  // 35I のときだけ当てる。CURRENT / 35H へ戻したら元の色へ返す。
  assert.match(html, /if \(depthEnabled\(\) && DEPTH_TUNINGS\[depthTuning\]\.neutralFill\) \{/);
  assert.match(html, /__fillColorBeforeDepth/);
  assert.equal(S.DEPTH_TUNINGS['35H'].neutralFill, false);
  assert.equal(S.DEPTH_TUNINGS['35I'].neutralFill, true);
});

test('35I LIGHT の 3 段階は両方の調整で単調', () => {
  for (const id of TUNINGS) {
    const L = S.DEPTH_TUNINGS[id].light;
    assert.ok(L.LOW.hemi > L.STANDARD.hemi && L.STANDARD.hemi > L.STRONG.hemi, id + ' の hemi が単調でない');
    assert.ok(L.LOW.sun < L.STANDARD.sun && L.STANDARD.sun < L.STRONG.sun, id + ' の sun が単調でない');
  }
});

// ── §11 before / after を比べられる ────────────────────────────────────
test('35I 35H と 35I を同じ画面で切り替えられる', () => {
  assert.deepEqual(Object.keys(S.DEPTH_TUNINGS).sort(), ['35H', '35I']);
  assert.match(html, /setDepthTuning\(id\)/);
  assert.match(html, /window\.__VISUAL_TUNING__/);
  // 頂点カラーに焼いてあるので、切り替えたら建物 tile を作り直す
  const s = html.indexOf('setDepthTuning(id) {');
  const e = html.indexOf('getLightLevel:', s);
  const block = html.slice(s, e);
  assert.match(block, /applyDepthTuning\(\);/);
  assert.match(block, /applyLightStyle\(\);/);
  assert.match(block, /e\.layer !== 'buildings'/, '建物 tile を作り直していない');
  // 開発用トグルは production で隠れる箱の中
  assert.deepEqual(devUiIsGated(['visual-tuning-toggle'], html), { ok: true });
});

test('35I production は 35I の調整で動く（35J で反映済み）', () => {
  // 35I の時点では dev 限定だった。[Mission 35J] ユーザー承認のうえ production へ反映。
  //   守るのは「反映されたのが 35I の値そのものであること」。
  const prod = fs.readFileSync(PROD, 'utf-8');
  assert.match(prod, /let depthTuning = '35I';/, 'production の調整が 35I でない');
  assert.match(prod, /const CR_FILL_COLOR_DEPTH = 0xc6ced6;/);
  assert.match(prod, /'35I': \{ wallLit: 0\.96, wallDark: 0\.81, baseDarken: 0\.83, massDarken: 0\.07/);
  assert.match(prod, /let buildingsVersion = 'V4';/, '建物は V4 のまま');
  // protected には入れない
  const prot = fs.readFileSync(path.join(ROOT, 'public', 'osaka_3d_buildings.fullward-v3.html'), 'utf-8');
  assert.ok(!/DEPTH_TUNINGS/.test(prot), 'protected に 35I が入っている');
});

// ── QA の作り ───────────────────────────────────────────────────────────
test('35I 6 方向を同じ地点・同じズームで測る', () => {
  assert.equal(AZIMUTHS.length, 6);
  assert.deepEqual(AZIMUTHS, [0, 60, 120, 180, 240, 300]);
  // §11 の必須地点
  for (const need of ['umeda', 'honmachi', 'namba']) {
    assert.ok(SITES.some((s) => s.id === need), need + ' が無い');
  }
  // 立体感は斜めで見る
  assert.ok(VIEW.phDeg >= 30 && VIEW.phDeg <= 45, '俯角 ' + VIEW.phDeg);
  // 地点は区の中（区外だと建物タイルが読まれない）
  const wards = (rj(path.join(ROOT, 'data', 'processed', 'osaka-city', 'boundaries',
    'ward-classification-polygons.json')) || {}).wards;
  if (!wards) return;
  for (const s of SITES) {
    const w = worldOf(s);
    const r = classifyPointToWard(w.x, w.z, wards);
    assert.ok(r && r.wardId, s.id + ' が区ポリゴンの外にある');
  }
});

test('35I 方向差の指標の出し方', () => {
  const st = directionStats([0.5, 0.6, 0.55, 0.45, 0.52, 0.58]);
  assert.equal(st.min, 0.45);
  assert.equal(st.max, 0.6);
  assert.ok(Math.abs(st.ratio - 0.6 / 0.45) < 1e-4);
  assert.ok(st.cv > 0 && st.cv < 1);
  // 数字が無ければ判定しない
  assert.equal(directionStats([]), null);
  assert.equal(directionStats([NaN, null]), null);
});

// ── 実測 ────────────────────────────────────────────────────────────────
test('35I 実測: 方向による建物の明暗差が縮んだ', { skip: skip('directional-balance-qa.json') }, () => {
  const q = rpt('directional-balance-qa.json');
  const s = q.summary;
  assert.equal(s.directionDependentBrightnessReduced, true, JSON.stringify(s.buildingRatioOldNew));
  // 全地点で改善していること
  for (const id of Object.keys(s.building.new.bySite)) {
    const a = s.building.old.bySite[id], b = s.building.new.bySite[id];
    assert.ok(b.ratio < a.ratio, `${id} の方向差が縮んでいない ${a.ratio} → ${b.ratio}`);
  }
  assert.ok(s.building.new.worstRatio <= LUMA_RATIO_TARGET,
    `方向差 ${s.building.new.worstRatio}（目標 ${LUMA_RATIO_TARGET} 以下）`);
});

test('35I 実測: 暗い方向でも沈まず、明るい方向でも飛ばない',
  { skip: skip('directional-balance-qa.json') }, () => {
    const q = rpt('directional-balance-qa.json');
    const s = q.summary;
    assert.equal(s.darkFacingViewStillReadable, true, '暗い方向 ' + s.darkestSceneLuma.new);
    assert.ok(s.darkestSceneLuma.new > s.darkestSceneLuma.old, '暗い方向が持ち上がっていない');
    assert.ok(s.darkestSceneLuma.new >= MIN_SCENE_LUMA);
    assert.equal(s.brightFacingViewNotWashedOut, true, '白飛び ' + s.maxClippedFraction.new);
    assert.ok(s.maxClippedFraction.new <= MAX_CLIPPED_FRACTION);
    // §10 暗い方向で青へ寄っていない
    assert.ok(s.blueBias.new <= s.blueBias.old + 0.02, `青寄り ${s.blueBias.old} → ${s.blueBias.new}`);
  });

test('35I 実測: 性能と回帰', { skip: skip('directional-balance-qa.json') }, () => {
  const q = rpt('directional-balance-qa.json');
  const s = q.summary;
  assert.ok(s.perf.fpsDropPct <= FPS_DROP_BUDGET_PCT, `FPS 低下 ${s.perf.fpsDropPct}%`);
  assert.equal(s.perf.drawCallsSame, true, 'draw call が増えている');
  assert.equal(s.perf.trianglesSame, true, '三角形が増えている');
  assert.equal(s.regressionOk, true, JSON.stringify(s.regression));
  assert.equal(s.jsErrors, 0);
});

test('35I 実測: データが 1 つも動いていない', { skip: skip('directional-balance-validation.json') }, () => {
  const v = rpt('directional-balance-validation.json');
  assert.equal(v.buildingCount, BUILDING_COUNT);
  assert.equal(v.canonicalGeometryMutation, 0);
  assert.equal(v.canonicalIdLoss, 0);
  assert.equal(v.projectionMutation, 0);
  assert.equal(v.placementMutation, 0);
  assert.equal(v.productionModified, false);
  assert.equal(v.protectedModified, false);
  assert.equal(v.contactShadowRetained, true);
  assert.equal(v.visualDepthRetained, true);
  assert.equal(v.classification, 'DIRECTIONAL_VISUAL_BALANCE_SUCCESS', JSON.stringify(v.errors));
});
