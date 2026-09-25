import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const DEV = 'public/osaka_3d_buildings.ward-ux-v1.html';
const PROD = 'public/osaka_3d_buildings.html';
const PROT = 'public/osaka_3d_buildings.fullward-v3.html';
const GEN = 'tools/experiments/mission35s_build_custom_lod2.py';
const PATCH = 'tools/experiments/mission35s_patch_dev.py';
const DATA = 'public/map-data/osaka-city/experimental/mission35s/custom-lod2-267613423.json';

function dataIfPresent() {
  const p = path.join(ROOT, DATA);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
}

test('[35S] generator keeps experimental provenance and exact coordinate convention', () => {
  const s = read(GEN);
  assert.match(s, /EXPERIMENTAL_POINT_CLOUD_ROOF/);
  assert.match(s, /['"]officialPlateauLod2['"]\s*:\s*False/);
  assert.match(s, /znorth-neg-v1/);
  assert.match(s, /runtime-footprint-spatial-match/);
  assert.doesNotMatch(s, /simple_gable|heuristic gable|generated-simple-roof/i);
});

test('[35S] patcher is dev-only and fail-closed on anchors', () => {
  const s = read(PATCH);
  assert.match(s, /osaka_3d_buildings\.ward-ux-v1\.html/);
  assert.match(s, /expected exactly 1 anchor/);
  assert.doesNotMatch(s, /PROD\.write_text|PROT\.write_text/);
});

test('[35S] production and protected never contain custom layer marker', () => {
  const mark = '[Mission 35S] CustomLod2Layer';
  assert.equal(read(PROD).includes(mark), false);
  assert.equal(read(PROT).includes(mark), false);
});

test('[35S] generated custom high-LOD data contract when artifact is present', () => {
  const d = dataIfPresent();
  if (!d) return;
  assert.equal(d.coordinateConvention, 'znorth-neg-v1');
  assert.equal(d.officialPlateauLod2, false);
  assert.equal(d.status, 'EXPERIMENTAL_POINT_CLOUD_ROOF');
  assert.equal(d.match.method, 'runtime-footprint-spatial-match');
  assert.equal(d.source.osmWayId, 267613423);
  assert.ok(d.geometry.vertices.length > 10);
  assert.ok(d.geometry.indices.length > 30);
  assert.ok(d.geometry.groups.some(g => g.kind === 'roof'));
  assert.ok(d.geometry.groups.some(g => g.kind === 'wall'));
  assert.ok(d.geometry.groups.some(g => g.kind === 'ground'));
  assert.ok(d.measurement.roofCandidatePoints > 100);
});

test('[35S] dev integration contract when patched', () => {
  const s = read(DEV);
  if (!s.includes('[Mission 35S] CustomLod2Layer')) return;
  assert.match(s, /custom-lod2-267613423\.json/);
  assert.match(s, /__CUSTOM_LOD2_LAYER__/);
  assert.match(s, /__CUSTOM_LOD2_DEBUG__/);
  assert.match(s, /__CUSTOM_LOD2_FOCUS__/);
  assert.match(s, /window\.__CUSTOM_LOD2_LAYER__\s*&&\s*window\.__CUSTOM_LOD2_LAYER__\.isSuppressedBuilding\(f\.canonicalId\)/);
  assert.match(s, /window\.__CUSTOM_LOD2_LAYER__\.update\(\)/);
  assert.match(s, /window\.__CUSTOM_LOD2_LAYER__\.pick\(ray\)/);
  assert.match(s, /35S 点群LOD2へ/);
  assert.match(s, /officialPlateauLod2 !== false/);
  assert.match(s, /EXPERIMENTAL_POINT_CLOUD_ROOF/);
});

test('[35S] focus button is reliably visible on the left-bottom', () => {
  const s = read(DEV);
  if (!s.includes('[Mission 35S] CustomLod2Layer')) return;
  // 右側のデバッグパネルの裏に隠れないよう左下へ置く
  assert.match(s, /'position:fixed;left:20px;bottom:90px;z-index:99999;'/);
  // 35S のボタンに right 指定を残さない（ボタン定義の中だけを見る）
  const i = s.indexOf("b.id = 'mission35s-focus'");
  assert.ok(i > 0, 'focus ボタンの定義が無い');
  const block = s.slice(i, i + 700);
  assert.ok(!/right:\s*\d/.test(block), '35S ボタンに right 指定が残っている');
  // DOMContentLoaded を撃ち終えたあとでも必ず作る
  assert.match(s, /if \(document\.readyState === 'loading'\)[\s\S]{0,120}createMission35SFocusButton\(\);/);
});

test('[35S] patch script is the source of the button (regeneration keeps the fix)', () => {
  // dev HTML だけ直すと CI の再生成で元へ戻る。生成元にも同じ指定があること。
  const p = read(PATCH);
  assert.match(p, /position:fixed;left:20px;bottom:90px;z-index:99999;/);
  assert.match(p, /document\.readyState === 'loading'/);
  // パッチ済みでもボタンだけは貼り直す（MARK による no-op で直りが埋もれないように）
  // [Mission 35S QA] ボタンだけでなく 35S ブロック全体を貼り直すようにした
  assert.match(p, /def refresh_layer_block\(/);
});

test('[35S QA] prototype building is unmistakable: colors, label, focus distance', () => {
  const s = read(DEV);
  if (!s.includes('[Mission 35S] CustomLod2Layer')) return;
  // §1 試作 1 棟だけ QA 配色（roof=明るい青 / wall=濃い青 / ground=グレー）
  assert.match(s, /const QA_COLOR = \{ roof: 0x2f9bff, wall: 0x10399c, ground: 0x8b949c \}/);
  assert.match(s, /new THREE\.MeshStandardMaterial\(\{ color: QA_COLOR\.roof/);
  assert.match(s, /new THREE\.MeshStandardMaterial\(\{ color: QA_COLOR\.wall/);
  assert.match(s, /new THREE\.MeshStandardMaterial\(\{ color: QA_COLOR\.ground/);
  // §2 常時見えるラベル
  assert.match(s, /const LABEL_TEXT = '35S CUSTOM LOD2';/);
  assert.match(s, /function buildLabel\(g, verts\)/);
  assert.match(s, /CR_customLod2_35S_label/);
  // §3 対象棟が大きく見える距離（650m ではなく 100〜200m）
  const m = s.match(/const FOCUS_R = (\d+);/);
  assert.ok(m, 'FOCUS_R が無い');
  assert.ok(+m[1] >= 100 && +m[1] <= 200, 'FOCUS_R は 100〜200m: ' + m[1]);
  assert.ok(!/cs\.r = 650;/.test(s), '旧 650m が残っている');
  // 対象棟のある区へ切り替える（区が違うと建物タイルが読まれず一致しない）
  assert.match(s, /WardModeManager\.detectWardAt\(fx, fz\)/);
});

test('[35S QA] click shows an experimental-prototype card', () => {
  const s = read(DEV);
  if (!s.includes('[Mission 35S] CustomLod2Layer')) return;
  assert.match(s, /function getQaSummary\(\)/);
  assert.match(s, /mission35s-qa-card/);
  assert.match(s, /window\.__MISSION35S_QA_CARD__/);
  // §4 カードに出す項目
  for (const k of ['Mission', 'Type', 'officialPlateauLod2', 'OSM way', 'canonicalId', 'matchDistanceM', 'areaRatio']) {
    assert.ok(s.includes(k), 'QA カードに ' + k + ' が無い');
  }
  assert.match(s, /type: 'Experimental point-cloud LOD2'/);
  // pick 経路からカードを開く
  assert.match(s, /window\.__MISSION35S_QA_CARD__\(\);/);
});

test('[35S QA] debug exposes the values needed to verify the prototype', () => {
  const s = read(DEV);
  if (!s.includes('[Mission 35S] CustomLod2Layer')) return;
  // §5 __CUSTOM_LOD2_DEBUG__() が返すべき値
  for (const k of ['visible', 'canonicalId', 'suppressActive', 'matched', 'matchDistanceM',
    'areaRatio', 'triangles', 'heightMedianM', 'sourceFootprintAreaM2']) {
    assert.ok(s.includes(k), 'debug に ' + k + ' が無い');
  }
  assert.match(s, /window\.__CUSTOM_LOD2_DEBUG__ = \(\) => CustomLod2Layer\.getDebug\(\);/);
  // §6 公式 LOD2/LOD3・LandmarkHD が同じ棟を持つときは自分を出さない
  assert.match(s, /officialOwnsCanonical/);
  assert.match(s, /landmarkOwnsCanonical/);
  assert.match(s, /const conflict = canonicalId && \(officialOwns\(canonicalId\) \|\| landmarkOwns\(canonicalId\)\);/);
  // [Mission 35T] LOD1 抑制は visible だけでなく **判定が HIGH のとき** に限る。
  //   MEDIUM / AMBIGUOUS / UNMATCHED では既存 LOD1 を消さない。
  assert.match(s, /suppressActive = visible && stats\.lod1SuppressionAllowed === true;/);
});

test('[35S QA] patch script stays the source of the QA presentation', () => {
  const p = read(PATCH);
  assert.match(p, /const QA_COLOR = \{ roof: 0x2f9bff/);
  assert.match(p, /const LABEL_TEXT = '35S CUSTOM LOD2';/);
  assert.match(p, /const FOCUS_R = 150;/);
  assert.match(p, /function getQaSummary\(\)/);
  // パッチ済みでもブロックごと貼り直す（MARK の no-op で直りが埋もれない）
  assert.match(p, /def refresh_layer_block\(/);
  assert.match(p, /def refresh_pick_hook\(/);
  // window 公開行がテンプレートに含まれていること（欠けると runtime が壊れる）
  assert.match(p, /window\.__CUSTOM_LOD2_DEBUG__ = \(\) => CustomLod2Layer\.getDebug\(\);/);
});

test('[35S QA] browser QA proves the prototype is visible and LOD1 is suppressed', () => {
  const f = 'data/reports/mission35s-custom-lod2-qa/summary.json';
  if (!fs.existsSync(f)) return;                       // QA 未実行のときは飛ばす
  const q = JSON.parse(fs.readFileSync(f, 'utf-8')).summary;
  // §3 対象棟が画面中央に大きく入っている
  assert.ok(q.cameraR >= 100 && q.cameraR <= 200, 'カメラ距離が 100〜200m でない: ' + q.cameraR);
  assert.equal(q.meshInView, true, '試作メッシュが画面に入っていない');
  assert.ok(q.meshScreenRadius > 0.08, '試作メッシュが小さすぎる: ' + q.meshScreenRadius);
  // §2 ラベルが見えている
  assert.equal(q.labelInView, true, 'ラベルが画面に入っていない');
  // §6 元 LOD1 と同時に出ていない
  assert.equal(q.visible, true, '試作が表示されていない');
  assert.equal(q.suppressActive, true, 'LOD1 抑制が効いていない');
  // footprint 一覧は property card 用に残る仕様なので、同時表示の判定には使わない。
  //   canonical runtime が LOD1 の箱を積む直前に isSuppressedBuilding() を呼び、
  //   true なら continue する。その回数が「LOD1 を出さなかった回数」。
  assert.ok(q.lod1SuppressedCount > 0, '元 LOD1 を抑制した形跡が無い: ' + q.lod1SuppressedCount);
  // 公式が同じ棟を持つ場合は公式優先（今回は持っていない）
  assert.equal(q.officialOwnsCanonical, false);
  assert.equal(q.landmarkOwnsCanonical, false);
  // §4 QA カード
  assert.equal(q.qaCardShown, true, 'QA カードが出ていない');
  // 突き合わせの根拠
  assert.ok(q.canonicalId, 'canonicalId が決まっていない');
  assert.ok(q.matchDistanceM != null && q.matchDistanceM <= 35, 'matchDistanceM: ' + q.matchDistanceM);
  assert.ok(q.areaRatio >= 0.45 && q.areaRatio <= 2.2, 'areaRatio: ' + q.areaRatio);
  assert.equal(q.triangles, 103);
  assert.equal(q.heightMedianM, 26.512);
});
