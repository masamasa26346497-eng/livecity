// tests/visual-depth.test.js
// [Mission 35H] LOD1 に陰影・立体感を与える（geometry は変えない）
//   - 面ごと / 高さごとの明暗の式（HTML から取り出してそのまま呼ぶ）
//   - 頂点カラーは material 色に乗算されるので色相が保たれること
//   - LOD1 の押し出し式が 1 文字も変わっていないこと
//   - 618,749 棟に dynamic shadow を掛けていないこと
//   - production / protected を触っていないこと
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  BUILDING_COUNT, FPS_DROP_BUDGET_PCT, FPS_DROP_IDEAL_PCT,
  VISUAL_PROFILES, LIGHT_LEVELS, BUILDING_SHADOW_MARKER,
} from '../tools/validate/visual-depth.js';
import { SITES, VIEWS, PERF_SITES, PROFILES, worldOf } from '../tools/audit/visual-depth-qa.js';
import { devUiIsGated, productionIsDevWithProfileOnly } from '../tools/lib/production-invariants.js';
import { classifyPointToWard } from '../tools/lib/point-in-polygon.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEV = path.join(ROOT, 'public', 'osaka_3d_buildings.ward-ux-v1.html');
const PROD = path.join(ROOT, 'public', 'osaka_3d_buildings.html');
const PROT = path.join(ROOT, 'public', 'osaka_3d_buildings.fullward-v3.html');
const html = fs.readFileSync(DEV, 'utf-8');
const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };
const rpt = (n) => rj(path.join(ROOT, 'data', 'reports', n));
const skip = (n) => (!rpt(n) && 'no report');
const sha = (p) => { try { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); } catch { return null; } };

/** 明暗の式を HTML から切り出して、実装と試験で式を二重に持たない。 */
function loadShading() {
  const s = html.indexOf('const SUN_AZ_DEG = 236, SUN_EL_DEG = 47;');
  const e = html.indexOf('const shadeByte =', s);
  assert.ok(s > 0 && e > s, '35H の明暗の定義が見つからない');
  const code = html.slice(s, html.indexOf('\n', e) + 1);
  // eslint-disable-next-line no-new-func
  return new Function(code + ' ; return { CR_SUN_DIR, CR_DEPTH, wallShade, heightShade, shadeByte };')();
}
const S = loadShading();

// ── §4/§6 面ごとの明暗 ──────────────────────────────────────────────────
test('35H 太陽の向きは南西・仰角 47°（34B のまま）', () => {
  const d = S.CR_SUN_DIR;
  // 方位 236°（北=0・東=90）→ 西へ寄り、南向き成分を持つ。z は北が負なので南は正。
  assert.ok(d.x < 0, '太陽が西側から来ていない');
  assert.ok(d.z > 0, '太陽が南側から来ていない');
  assert.ok(Math.abs(Math.hypot(d.x, d.y, d.z) - 1) < 1e-9, '単位ベクトルでない');
  const elev = Math.asin(d.y) * 180 / Math.PI;
  assert.ok(elev > 35 && elev < 55, `仰角 ${elev.toFixed(1)}° が §4 の 35〜55° の外`);
});

test('35H 壁は向きで 3 段階に分かれる', () => {
  const d = S.CR_SUN_DIR;
  // 壁の向きは水平面の話なので、太陽も水平成分だけを使って比べる
  const h = Math.hypot(d.x, d.z);
  const lit = S.wallShade(d.x / h, d.z / h);      // 太陽に正対
  const dark = S.wallShade(-d.x / h, -d.z / h);   // 背を向ける
  const side = S.wallShade(-d.z / h, d.x / h);    // 真横
  assert.ok(Math.abs(lit - S.CR_DEPTH.wallLit) < 1e-9, '正対した壁が wallLit にならない');
  assert.ok(Math.abs(dark - S.CR_DEPTH.wallDark) < 1e-9, '背を向けた壁が wallDark にならない');
  assert.ok(dark < side && side < lit, `3 段階になっていない ${dark} / ${side} / ${lit}`);
  // §6 の目安: 屋根 > 明るい壁 > 暗い壁 で、暗い壁は 0.72〜0.88 の範囲
  assert.ok(S.CR_DEPTH.roof > S.CR_DEPTH.wallLit);
  assert.ok(S.CR_DEPTH.wallDark >= 0.70 && S.CR_DEPTH.wallDark <= 0.88, '暗い壁 ' + S.CR_DEPTH.wallDark);
  assert.ok(S.CR_DEPTH.wallLit >= 0.90 && S.CR_DEPTH.wallLit <= 1.05, '明るい壁 ' + S.CR_DEPTH.wallLit);
});

test('35H 倍率は 1.0 を超えない（正規化 Uint8 で表せる範囲）', () => {
  // 1.0 を超える値は頂点カラー（0..1）で表せず、material 色を持ち上げると白飛びする。
  for (const k of ['roof', 'wallLit', 'wallDark', 'baseDarken']) {
    assert.ok(S.CR_DEPTH[k] <= 1.0, k + ' が 1.0 を超えている');
  }
  assert.equal(S.CR_DEPTH.roof, 1.0, '屋根が基準（1.0）でない');
  // 実際に焼かれる値も 0..255 に収まる
  for (const y of [0, 5, 20, 100, 200]) {
    for (const h of [6, 30, 180]) {
      const v = S.shadeByte(S.CR_DEPTH.roof * S.heightShade(Math.min(y, h), h));
      assert.ok(v >= 0 && v <= 255, `shadeByte(${y},${h}) = ${v}`);
    }
  }
});

// ── §9/§11 接地と量感 ───────────────────────────────────────────────────
test('35H 足元は暗く、上へ向かって戻る（接地感）', () => {
  const h = 30;
  const foot = S.heightShade(0, h), mid = S.heightShade(S.CR_DEPTH.baseM, h), up = S.heightShade(20, h);
  assert.ok(foot < mid, '足元が暗くなっていない');
  // 足元には baseDarken に加えて量感ぶんも掛かるので、baseDarken 以下になる
  assert.ok(foot <= S.CR_DEPTH.baseDarken + 1e-9, '足元が baseDarken より明るい');
  assert.ok(foot >= S.CR_DEPTH.baseDarken * (1 - S.CR_DEPTH.massDarken) - 1e-9, '足元が暗すぎる');
  assert.ok(mid <= up + 1e-9);
  // 接地の陰は数 m で解ける（建物全体が暗くならない）
  assert.ok(S.CR_DEPTH.baseM > 0 && S.CR_DEPTH.baseM <= 15, '接地の陰が効く高さ ' + S.CR_DEPTH.baseM);
});

test('35H 高い棟ほど下部が落ちる（量感）。ただし低い棟には効かない', () => {
  // 同じ高さ 20m の地点でも、200m の棟のほうが 30m の棟より暗い
  const tall = S.heightShade(20, 200), short = S.heightShade(20, 30);
  assert.ok(tall < short, `量感が出ていない tall=${tall} short=${short}`);
  // 上端では量感の補正が消える（屋根は基準のまま）
  assert.ok(Math.abs(S.heightShade(200, 200) - 1) < 1e-9, '上端で 1.0 に戻っていない');
  assert.ok(Math.abs(S.heightShade(30, 30) - 1) < 1e-9);
  // 高さを誇張しない（§11）= 形は変えず明暗だけ。最大でも massDarken の分しか落とさない
  assert.ok(S.CR_DEPTH.massDarken > 0 && S.CR_DEPTH.massDarken <= 0.2, '量感が強すぎる ' + S.CR_DEPTH.massDarken);
});

test('35H 高さ 0 の退化した棟でも落ちない', () => {
  assert.ok(Number.isFinite(S.heightShade(0, 0)));
  assert.ok(Number.isFinite(S.heightShade(0, null)));
  assert.ok(Number.isFinite(S.wallShade(0, 0)), '長さ 0 の辺で NaN');
});

// ── §3 geometry を変えていない ──────────────────────────────────────────
test('35H LOD1 の押し出し式が変わっていない', () => {
  // 壁 2 枚 + 屋根。頂点の並びが変わると頂点カラーの並びとずれる。
  assert.ok(html.includes('positions.push(a[0], 0, a[1], b[0], 0, b[1], b[0], h, b[1]);'));
  assert.ok(html.includes('positions.push(a[0], 0, a[1], b[0], h, b[1], a[0], h, a[1]);'));
  assert.ok(html.includes('positions.push(v.x, h, v.y);'));
  // 頂点カラーは positions と同じ数だけ積む（壁 1 面 = 6 頂点）。
  //   [Mission 35N] 1 頂点ぶんを push3() にまとめ、用途不明の建物だけ色みを掛けられるようにした。
  //   積む順番・個数は変えていない（壁 6 頂点 → push3 を 6 回 / 屋根 1 頂点 → 1 回）。
  assert.match(html, /const push3 = \(c\) => colors\.push\(shadeByte\(c \* tr \/ 255\), shadeByte\(c \* tg \/ 255\), shadeByte\(c \* tb \/ 255\)\);/);
  assert.match(html, /push3\(c0\); push3\(c0\); push3\(c1\);/);
  assert.match(html, /push3\(c0\); push3\(c1\); push3\(c1\);/);
  assert.match(html, /if \(colors\) push3\(rc\);/);
});

test('35H 頂点カラーは positions と同じ長さのときだけ使う', () => {
  // 長さが食い違ったまま attribute にすると描画が壊れる。
  assert.match(html, /if \(opts\.colors && opts\.colors\.length === arr\.length\) \{/);
  assert.match(html, /new THREE\.BufferAttribute\(new Uint8Array\(opts\.colors\), 3, true\)/);
});

// ── §6/§7 色相を変えない ────────────────────────────────────────────────
test('35H 頂点カラーは無彩色（色相を動かさない）', () => {
  // 35H の意図: **陰影**が色相を動かさないこと（明るさだけを変える）。
  //   [Mission 35N] 用途不明の建物にだけ高さクラスの色みを掛けられるようにしたが、
  //   それは tint として明示的に渡したときだけ効き、渡さなければ従来どおり r=g=b になる。
  const s = html.indexOf('const pushWallShades =');
  const e = html.indexOf('for (const poly of polys)', s);
  const block = html.slice(s, e);
  // 陰影の値そのものは 1 つのスカラー（c0 / c1）で、色相を持たない
  assert.match(block, /const c0 = shadeByte\(s \* heightShade\(0, h\)\), c1 = shadeByte\(s \* heightShade\(yTop, h\)\);/);
  assert.ok(!/c0, c1, c2/.test(block), '陰影に 3 チャンネル別の値を使っている');
  // tint を渡さないときは 3 チャンネルとも同じ値（= 無彩色）
  const tr = html.match(/const tr = tint \? tint\[0\] : 1, tg = tint \? tint\[1\] : 1, tb = tint \? tint\[2\] : 1;/);
  assert.ok(tr, 'tint 既定値（無彩色）の定義が無い');
});

test('35H DEPTH は彩度だけ上げ、明度は上げない（§7/§18）', () => {
  const cur = html.match(/const CR_VIVID = \{ sat: ([\d.]+), light: ([\d.]+) \};/);
  const dep = html.match(/const CR_VIVID_DEPTH = \{ sat: ([\d.]+), light: ([\d.]+) \};/);
  assert.ok(cur && dep, 'vivid の定義が読めない');
  const [cs, cl] = [Number(cur[1]), Number(cur[2])];
  const [ds, dl] = [Number(dep[1]), Number(dep[2])];
  assert.ok(ds > cs, '彩度が上がっていない');
  // §7 の +15〜30% を 33A 比で満たす
  const gain = (ds / cs - 1) * 100;
  assert.ok(gain >= 15 && gain <= 30, `彩度の上げ幅 ${gain.toFixed(1)}% が §7 の範囲外`);
  assert.equal(dl, cl, '明度を上げている（白飛びの原因になる）');
  assert.ok(ds <= 1.5, '原色ベタ塗りになる彩度');
});

// ── §14/§15/§16 配色 ───────────────────────────────────────────────────
test('35H 水・緑・道路は役割を変えずに強める', () => {
  const pick = (name) => {
    const m = html.match(new RegExp('const ' + name + ' = \\{[\\s\\S]*?\\n  \\};'));
    assert.ok(m, name + ' が読めない');
    const o = {};
    for (const k of ['water', 'road', 'parkReal', 'grass']) {
      const mm = m[0].match(new RegExp(k + ': (0x[0-9a-f]+)'));
      if (mm) o[k] = parseInt(mm[1], 16);
    }
    return o;
  };
  const cur = pick('COL'), dep = pick('COL_DEPTH');
  const hue = (hex) => {
    const r = ((hex >> 16) & 255) / 255, g = ((hex >> 8) & 255) / 255, b = (hex & 255) / 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    if (mx === mn) return null;
    const d = mx - mn;
    if (mx === r) return ((g - b) / d + (g < b ? 6 : 0)) / 6;
    if (mx === g) return ((b - r) / d + 2) / 6;
    return ((r - g) / d + 4) / 6;
  };
  const sat = (hex) => {
    const r = ((hex >> 16) & 255) / 255, g = ((hex >> 8) & 255) / 255, b = (hex & 255) / 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
    if (mx === mn) return 0;
    const d = mx - mn;
    return l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  };
  // 水は青のまま・彩度が上がる（§14 ネオンにしない = 彩度 1.0 未満）
  assert.ok(Math.abs(hue(dep.water) - hue(cur.water)) < 0.03, '水の色相が動いている');
  assert.ok(sat(dep.water) > sat(cur.water), '水の彩度が上がっていない');
  assert.ok(sat(dep.water) < 1.0, '水がネオン');
  // 緑も同じ
  assert.ok(Math.abs(hue(dep.parkReal) - hue(cur.parkReal)) < 0.03, '緑の色相が動いている');
  assert.ok(sat(dep.parkReal) > sat(cur.parkReal), '緑の彩度が上がっていない');
  // §16 道路は暗くする（白くして建物と同化させない）
  const lum = (hex) => 0.2126 * ((hex >> 16) & 255) + 0.7152 * ((hex >> 8) & 255) + 0.0722 * (hex & 255);
  assert.ok(lum(dep.road) < lum(cur.road), '道路が明るくなっている（建物と同化する）');
});

// ── §4/§5/§18 光 ───────────────────────────────────────────────────────
test('35H hemisphere を下げ、主光の比率を上げる', () => {
  const cur = html.match(/const CR_STYLE = \{ exposure: ([\d.]+), hemi: ([\d.]+), sun: ([\d.]+), fill: ([\d.]+) \};/);
  assert.ok(cur, 'CR_STYLE が読めない');
  const [, ce, ch, cs2, cf] = cur.map(Number);
  const m = html.match(/STANDARD:\s+\{ exposure: ([\d.]+), hemi: ([\d.]+), sun: ([\d.]+), fill: ([\d.]+) \}/);
  assert.ok(m, 'STANDARD の preset が読めない');
  const [, de, dh, ds, df] = m.map(Number);
  assert.ok(dh < ch, 'hemisphere を下げていない（面の差が出ない）');
  assert.ok(ds > cs2, '主光を上げていない');
  assert.ok(ds / dh > cs2 / ch, '主光と環境光の比が上がっていない');
  // §5 影側を黒く潰さない＝ hemisphere と fill を残す
  assert.ok(dh > 0.3, 'hemisphere が弱すぎて影側が潰れる');
  assert.ok(df > 0, '補助光を消している');
  // §18 落ちた明るさは exposure で取り戻すが、上げすぎない
  assert.ok(de > ce, '露出を上げていない');
  assert.ok(de <= 1.15, '露出が高すぎて白飛びする');
});

test('35H LIGHT の 3 段階が単調（LOW < STANDARD < STRONG）', () => {
  const get = (name) => {
    const m = html.match(new RegExp(name + ':\\s+\\{ exposure: ([\\d.]+), hemi: ([\\d.]+), sun: ([\\d.]+), fill: ([\\d.]+) \\}'));
    assert.ok(m, name + ' が読めない');
    return { exposure: +m[1], hemi: +m[2], sun: +m[3], fill: +m[4] };
  };
  const lo = get('LOW'), st = get('STANDARD'), sg = get('STRONG');
  assert.ok(lo.hemi > st.hemi && st.hemi > sg.hemi, 'hemi が単調でない');
  assert.ok(lo.sun < st.sun && st.sun < sg.sun, 'sun が単調でない');
  assert.deepEqual(LIGHT_LEVELS, ['LOW', 'STANDARD', 'STRONG']);
});

// ── §10/§22/§26 影の方針 ───────────────────────────────────────────────
test('35H 618,749 棟に dynamic shadow を掛けていない', () => {
  // canonical の建物 mesh は castShadow / receiveShadow を明示的に切る。
  assert.ok(html.includes(BUILDING_SHADOW_MARKER), '建物の shadow を切る記述が無い');
  assert.equal(BUILDING_COUNT, 618749);
  // 接地感は shadowMap ではなく頂点カラー（= draw call が増えない）で出す
  assert.match(html, /baseDarken/);
  assert.ok(!/castShadow = true/.test(html.slice(html.indexOf('function meshFromPositions'), html.indexOf('function lineMesh', html.indexOf('function meshFromPositions')))));
});

// ── §20/§21/§28 dev だけ ───────────────────────────────────────────────
test('35H プロファイル切替がある。production UI には出ない', () => {
  assert.deepEqual(VISUAL_PROFILES, ['CURRENT', 'DEPTH']);
  assert.match(html, /const VISUAL_PROFILES = \['CURRENT', 'DEPTH'\];/);
  assert.match(html, /window\.__VISUAL_PROFILE__/);
  assert.match(html, /window\.__VISUAL_LIGHT__/);
  assert.match(html, /window\.__VISUAL_DEPTH_DEBUG__/);
  // §21 トグルは production で隠れる箱の中
  assert.deepEqual(devUiIsGated(['visual-profile-toggle', 'visual-light-toggle'], html), { ok: true });
});

test('35H production / protected は手で書き換えられていない', () => {
  // 35H の時点では production は 35G のままで、visual は dev 限定だった。
  //   [Mission 35J] ユーザー承認のうえ 35I の見た目を production へ反映したので、
  //   「production に visual が入っていないこと」はもう仕様ではない。
  //   常時守れるのは「production が自分のビルド記録のまま」と「protected 不変」。
  const build = rpt('production-cutover-build.json');
  if (build && build.productionSha256) assert.equal(sha(PROD), build.productionSha256, 'production HTML が手で書き換えられている');
  const base = rpt('baselines/prod-protected-hashes.json');
  if (base && base.prot) assert.equal(sha(PROT), base.prot, 'protected HTML が変わっている');
  const prod = fs.readFileSync(PROD, 'utf-8');
  assert.match(prod, /let buildingsVersion = 'V4';/);
  // protected には 35H の visual を入れない（こちらは変わらない約束）
  const prot = fs.readFileSync(PROT, 'utf-8');
  assert.ok(!/CR_VIVID_DEPTH|CR_DEPTH/.test(prot), 'protected に 35H が入っている');
});

// ── QA の作り ───────────────────────────────────────────────────────────
test('35H §23 の地点が揃っていて、全部が区の中にある', () => {
  for (const need of ['umeda', 'nakanoshima', 'honmachi', 'namba', 'tennoji', 'shin-osaka', 'higashiyodogawa']) {
    assert.ok(SITES.some((s) => s.id === need), need + ' が無い');
  }
  const wards = (rj(path.join(ROOT, 'data', 'processed', 'osaka-city', 'boundaries',
    'ward-classification-polygons.json')) || {}).wards;
  if (!wards) return;
  for (const s of SITES) {
    const w = worldOf(s);
    const r = classifyPointToWard(w.x, w.z, wards);
    assert.ok(r && r.wardId, s.id + ' が区ポリゴンの外にある');
  }
});

test('35H 低い角度の視点で撮る（立体感は斜めで出る）', () => {
  assert.ok(VIEWS.low.phDeg >= 30 && VIEWS.low.phDeg <= 45, '§23 の 30〜45° でない: ' + VIEWS.low.phDeg);
  assert.ok(VIEWS.overview.phDeg > VIEWS.low.phDeg, '俯瞰と斜めが同じ');
  // §29 比較のため CURRENT と DEPTH で同じカメラを使う
  assert.deepEqual(PROFILES, ['CURRENT', 'DEPTH']);
  assert.ok(PERF_SITES.includes('umeda') && PERF_SITES.includes('shin-osaka'));
});

// ── 実測 ────────────────────────────────────────────────────────────────
test('35H 実測: DEPTH で全建物 mesh に明暗が入り、CURRENT では入らない',
  { skip: skip('visual-depth-qa.json') }, () => {
    const q = rpt('visual-depth-qa.json');
    const s = q.summary;
    assert.equal(s.depthAllMeshesShaded, true, 'DEPTH で色が付いていない mesh がある');
    assert.equal(s.currentNoVertexColor, true, 'CURRENT に頂点カラーが残っている');
    assert.equal(s.jsErrors, 0);
    // 屋根（255）と陰の壁のあいだに実際に差が開いている
    assert.ok(s.shadeSpread.max >= 250, '屋根が基準になっていない: ' + s.shadeSpread.max);
    assert.ok(s.shadeSpread.min <= 200, '陰の壁が暗くなっていない: ' + s.shadeSpread.min);
  });

test('35H 実測: 白飛びしていない / 高 LOD が壊れていない',
  { skip: skip('visual-depth-qa.json') }, () => {
    const q = rpt('visual-depth-qa.json');
    assert.equal(q.summary.noWhiteClipping, true, JSON.stringify(q.summary.clipping.depth));
    assert.equal(q.summary.highLodIntact, true, JSON.stringify(q.summary.highLod.depth));
    assert.equal(q.summary.highLod.depth.lod1ShadeLeakedIntoHighLod, 0);
  });

test('35H 実測: 性能が落ちていない', { skip: skip('visual-depth-validation.json') }, () => {
  // City Mode の比較は **同じタイル状態で測った値** を使う。
  //   一連の QA では 2 つのプロファイルが別のタイミングで測られ、読み込み済みタイル数が
  //   違っていた（draw call 2,917 と 3,012）。validator が controlled な測定へ差し替える。
  const v = rpt('visual-depth-validation.json');
  assert.ok(v.perf, '性能の記録が無い');
  assert.ok(v.perf.worstFpsDropPct <= FPS_DROP_BUDGET_PCT,
    `FPS 低下 ${v.perf.worstFpsDropPct}%（許容 ${FPS_DROP_BUDGET_PCT}%）`);
  // 頂点カラーは draw call も三角形も増やさない
  for (const [id, d] of Object.entries(v.perf.delta)) {
    assert.ok(d.drawCalls.depth <= d.drawCalls.current * 1.02, id + ' の draw call が増えている');
    assert.ok(d.triangles.depth <= d.triangles.current * 1.02, id + ' の三角形が増えている');
  }
  // City Mode は controlled な測定に基づいていること
  assert.ok(v.perf.cityModeControlled, 'City Mode を同一条件で測り直していない');
  assert.ok(v.perf.delta['city-mode'].uncontrolled, '条件を揃えない測定も記録に残す');
});

test('35H 実測: データが 1 つも動いていない', { skip: skip('visual-depth-validation.json') }, () => {
  const v = rpt('visual-depth-validation.json');
  assert.equal(v.buildingCount, BUILDING_COUNT);
  assert.equal(v.canonicalGeometryMutation, 0);
  assert.equal(v.canonicalIdMutation, 0);
  assert.equal(v.projectionMutation, 0);
  assert.equal(v.placementMutation, 0);
  assert.equal(v.roadGeometryMutation, 0);
  assert.equal(v.railGeometryMutation, 0);
  assert.equal(v.waterGeometryMutation, 0);
  assert.equal(v.parkGeometryMutation, 0);
  assert.equal(v.productionModified, false);
  assert.equal(v.protectedModified, false);
  assert.equal(v.lod1GeometryUnchanged, true);
  assert.equal(v.buildingShadowOff, true);
  assert.equal(v.classification, 'LIVE_CITY_VISUAL_DEPTH_SUCCESS', JSON.stringify(v.errors));
});
