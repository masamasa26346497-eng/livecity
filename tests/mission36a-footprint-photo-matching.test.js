// tests/mission36a-footprint-photo-matching.test.js
// [Mission 36A §12] footprint による写真対応付けと、写真を切らない表示。
//   守りたいのは「距離だけで建物を決めない」「名前が矛盾したら採らない」
//   「写真を crop / 歪ませない」。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyFootprintMatch, compareNames, normalizeName, showsOnHover }
  from '../tools/photos/lib/footprint-photo-matching.mjs';
import { pointInFeature, featureAreaM2, toLocal } from '../tools/photos/footprint-lookup.mjs';
import { pickPreferredPhoto, scorePhoto, orientationOf } from '../tools/photos/lib/photo-preference.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEV = path.join(ROOT, 'public', 'osaka_3d_buildings.ward-ux-v1.html');
const PROD = path.join(ROOT, 'public', 'osaka_3d_buildings.html');
const PROT = path.join(ROOT, 'public', 'osaka_3d_buildings.fullward-v3.html');
const INDEX = path.join(ROOT, 'public', 'map-data', 'osaka-city', 'derived', 'building-photo-index.json');
const REPORT = path.join(ROOT, 'data', 'reports', 'mission36a-footprint-photo-matching');
const html = fs.readFileSync(DEV, 'utf-8');
const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };

// 正方形（10m 角）のダミー建物
const sq = (id, x0, z0, s, name = null) => ({
  canonicalId: id, name, areaM2: s * s,
  geometryType: 'Polygon',
  coordinates: [[[x0, z0], [x0 + s, z0], [x0 + s, z0 + s], [x0, z0 + s]]],
  bbox: { minX: x0, maxX: x0 + s, minZ: z0, maxZ: z0 + s },
});

// ── §3 point in polygon ────────────────────────────────────────
test('[36A §3] 点が polygon の内外を正しく判定する', () => {
  const f = sq('a', 0, 0, 10);
  assert.equal(pointInFeature(5, 5, f), true, '内側が false');
  assert.equal(pointInFeature(15, 5, f), false, '外側が true');
  assert.equal(pointInFeature(-1, -1, f), false);
  // bbox の外は即 false（早期打ち切りが効いている）
  assert.equal(pointInFeature(1000, 1000, f), false);
});

test('[36A §3] 穴（hole）の中は内側にしない', () => {
  const withHole = {
    canonicalId: 'h', geometryType: 'Polygon',
    coordinates: [
      [[0, 0], [20, 0], [20, 20], [0, 20]],          // 外周
      [[8, 8], [12, 8], [12, 12], [8, 12]],          // 中庭
    ],
    bbox: { minX: 0, maxX: 20, minZ: 0, maxZ: 20 },
  };
  assert.equal(pointInFeature(2, 2, withHole), true, '外周の内側が false');
  assert.equal(pointInFeature(10, 10, withHole), false, '中庭が内側と判定された');
  assert.equal(pointInFeature(8.5, 8.5, withHole), false);
});

test('[36A §3] MultiPolygon のどのパートでも内側になる', () => {
  const mp = {
    canonicalId: 'm', geometryType: 'MultiPolygon',
    coordinates: [
      [[[0, 0], [10, 0], [10, 10], [0, 10]]],
      [[[50, 50], [60, 50], [60, 60], [50, 60]]],
    ],
    bbox: { minX: 0, maxX: 60, minZ: 0, maxZ: 60 },
  };
  assert.equal(pointInFeature(5, 5, mp), true);
  assert.equal(pointInFeature(55, 55, mp), true);
  assert.equal(pointInFeature(30, 30, mp), false, 'パートの間が内側になった');
});

test('[36A] 面積は穴を引いて数える', () => {
  assert.equal(Math.round(featureAreaM2(sq('a', 0, 0, 10))), 100);
  const withHole = { geometryType: 'Polygon', coordinates: [
    [[0, 0], [10, 0], [10, 10], [0, 10]], [[4, 4], [6, 4], [6, 6], [4, 6]]] };
  assert.equal(Math.round(featureAreaM2(withHole)), 96);
});

test('[36A] 投影は既存レイヤーと同じ（znorth-neg-v1）', () => {
  const p = toLocal(34.604208, 135.52502);
  assert.ok(Math.abs(p.x) < 0.01 && Math.abs(p.z) < 0.01, '原点がずれている');
  const n = toLocal(34.614208, 135.52502);          // 北へ 0.01 度
  assert.ok(n.z < 0, '北が -Z になっていない（znorth-neg-v1 違反）');
});

// ── §4 分類 ────────────────────────────────────────────────────
test('[36A §4] 1 棟の中で名前も一致すれば VERY_HIGH', () => {
  const r = classifyFootprintMatch([{ canonicalId: 'a', name: '通天閣', areaM2: 300 }], ['通天閣']);
  assert.equal(r.matchConfidence, 'VERY_HIGH');
  assert.equal(r.matchType, 'exact-building');
  assert.equal(r.canonicalId, 'a');
  assert.equal(r.nameEvidence, 'name');
});

test('[36A §4] 1 棟の中で建物に名前が無ければ HIGH（採用はする）', () => {
  const r = classifyFootprintMatch([{ canonicalId: 'a', name: null, areaM2: 300 }], ['なにかのビル']);
  assert.equal(r.matchConfidence, 'HIGH');
  assert.equal(r.canonicalId, 'a');
  assert.equal(r.nameEvidence, 'none');
});

test('[36A §6] 名前が矛盾したら採らない（nearest fallback も無い）', () => {
  const r = classifyFootprintMatch([{ canonicalId: 'a', name: 'OCAT', areaM2: 9000 }], ['JR難波']);
  assert.equal(r.canonicalId, null, '名前が違うのに採用された');
  assert.equal(r.matchConfidence, 'UNRESOLVED');
  assert.equal(r.nameEvidence, 'conflict');
});

test('[36A §4] footprint の外なら UNRESOLVED', () => {
  const r = classifyFootprintMatch([], ['どこか']);
  assert.equal(r.matchConfidence, 'UNRESOLVED');
  assert.equal(r.canonicalId, null);
  assert.equal(r.insideCount, 0);
});

test('[36A §4/§5] 複数の footprint に入ったら AMBIGUOUS（勝手に 1 棟へ割り当てない）', () => {
  const r = classifyFootprintMatch(
    [{ canonicalId: 'a', name: null, areaM2: 500 }, { canonicalId: 'b', name: null, areaM2: 520 }],
    ['なにか']);
  assert.equal(r.matchConfidence, 'AMBIGUOUS');
  assert.equal(r.canonicalId, null);
  assert.equal(r.ambiguityReason, 'overlapping-footprints');
});

test('[36A §5] building part らしい重なりは building-part として記録する', () => {
  const r = classifyFootprintMatch(
    [{ canonicalId: 'small', name: null, areaM2: 100 }, { canonicalId: 'big', name: null, areaM2: 5000 }],
    ['なにか']);
  assert.equal(r.matchType, 'building-part');
  assert.equal(r.ambiguityReason, 'building-part-overlap');
  assert.equal(r.canonicalId, null, 'building part を勝手に 1 棟へ割り当てた');
});

test('[36A §5] 重なっていても名前が一致する棟が 1 つだけなら決まる', () => {
  const r = classifyFootprintMatch(
    [{ canonicalId: 'a', name: '大阪城ホール', areaM2: 9000 }, { canonicalId: 'b', name: '別館', areaM2: 400 }],
    ['大阪城ホール']);
  assert.equal(r.canonicalId, 'a');
  assert.equal(r.matchConfidence, 'VERY_HIGH');
});

test('[36A §5] 駅・商業施設などの複合施設は 1 棟へ決めない', () => {
  const r = classifyFootprintMatch([{ canonicalId: 'a', name: null, areaM2: 20000 }],
    ['大阪駅'], { instanceLabels: ['鉄道駅'] });
  assert.equal(r.matchType, 'complex');
  assert.equal(r.canonicalId, null);
  assert.equal(r.ambiguityReason, 'complex-facility');
});

test('[36A §6] 名前の正規化と突き合わせ', () => {
  assert.equal(normalizeName('グランフロント大阪　Ｂ棟'), 'グランフロント大阪b棟');
  assert.equal(compareNames(['通天閣'], '通天閣'), 'agree');
  assert.equal(compareNames(['大阪城ホール'], '大阪城ホール本館'), 'agree');
  assert.equal(compareNames(['通天閣'], null), 'no-name');
  assert.equal(compareNames(['通天閣'], '新世界ニューハイツ'), 'conflict');
  // 2 文字の断片で誤って一致させない
  assert.equal(compareNames(['大阪'], '大阪府立国際会議場'), 'conflict');
});

test('[36A §4] hover に出すのは HIGH / VERY_HIGH だけ', () => {
  assert.equal(showsOnHover('VERY_HIGH'), true);
  assert.equal(showsOnHover('HIGH'), true);
  assert.equal(showsOnHover('AMBIGUOUS'), false);
  assert.equal(showsOnHover('UNRESOLVED'), false);
});

test('[36A] 距離による nearest fallback が実装に存在しない', () => {
  const lib = fs.readFileSync(path.join(ROOT, 'tools', 'photos', 'lib', 'footprint-photo-matching.mjs'), 'utf-8');
  assert.ok(!/nearest|Math\.hypot|distance/i.test(lib), '距離で決める処理が混ざっている');
  const re = fs.readFileSync(path.join(ROOT, 'tools', 'photos', 'rematch-photos-by-footprint.mjs'), 'utf-8');
  assert.match(re, /point-in-polygon/);
  assert.ok(!/radiusM/.test(re), '半径で決める処理が残っている');
});

// ── 追加要件 §7/§8/§9 写真の選び方 ──────────────────────────────
test('[36A 表示] 全景らしい写真を先頭にする', () => {
  const photos = [
    { title: 'File:Foo interior lobby.jpg', width: 800, height: 600 },
    { title: 'File:Foo building exterior facade.jpg', width: 800, height: 600 },
  ];
  const r = pickPreferredPhoto(photos, null);
  assert.match(r.photos[0].title, /exterior/, '内部写真が先頭のまま');
  assert.ok(scorePhoto(photos[1]).score > scorePhoto(photos[0]).score);
});

test('[36A 表示 §8] preferredImageTitle があればそれを最優先', () => {
  const photos = [
    { title: 'File:A exterior.jpg', width: 800, height: 600 },
    { title: 'File:B night.jpg', width: 800, height: 600 },
  ];
  const r = pickPreferredPhoto(photos, { preferredImageTitle: 'File:B night.jpg' });
  assert.equal(r.photos[0].title, 'File:B night.jpg');
  assert.equal(r.appliedManual, true);
});

test('[36A 表示 §8] preferredPhoto が見つからなければ点数順へ戻す', () => {
  const photos = [
    { title: 'File:A sign closeup.jpg', width: 800, height: 600 },
    { title: 'File:B exterior full view.jpg', width: 800, height: 600 },
  ];
  const r = pickPreferredPhoto(photos, { preferredImageTitle: 'File:NOT-THERE.jpg' });
  assert.equal(r.appliedManual, false, '存在しない指定を適用してしまった');
  assert.match(r.photos[0].title, /exterior/);
});

test('[36A 表示 §3] 向きの判定', () => {
  assert.equal(orientationOf({ width: 1600, height: 900 }), 'landscape');
  assert.equal(orientationOf({ width: 900, height: 1600 }), 'portrait');
  assert.equal(orientationOf({ width: 1000, height: 1000 }), 'square');
  assert.equal(orientationOf({}), 'unknown');
});

// ── 追加要件 §1/§2/§6 表示で切らない・歪ませない ────────────────
test('[36A 表示 §1/§2] hover も click も contain（cover を使わない）', () => {
  assert.ok(!/object-fit:cover/.test(html), 'cover が残っている');
  assert.match(html, /#bldg-photo-card \.bp-img\{[^}]*object-fit:contain/);
  assert.match(html, /#pc-photo-section \.pc-photo img\{[^}]*object-fit:contain/);
});

test('[36A 表示 §6] 幅と高さを同時に固定していない（歪ませない）', () => {
  const bp = html.match(/#bldg-photo-card \.bp-img\{[^}]*\}/)[0];
  assert.match(bp, /max-width:100%/);
  assert.match(bp, /max-height:\d+px/);
  assert.match(bp, /width:auto/);
  assert.match(bp, /height:auto/);
  // 向きごとの規則が width を 100% に固定していない（箱の比が崩れる）
  for (const m of html.matchAll(/\.bp-figure\.is-\w+ \.bp-img\{([^}]*)\}/g)) {
    assert.ok(!/width:100%/.test(m[1]), '向き規則が width を固定している: ' + m[1]);
  }
});

test('[36A 表示 §4/§5] 画像の高さは可変で、上限だけ持ち、余白は淡い色', () => {
  for (const k of ['is-portrait', 'is-landscape', 'is-square', 'is-panorama']) {
    assert.ok(html.includes('.bp-figure.' + k), k + ' の規則が無い');
  }
  const fig = html.match(/#bldg-photo-card \.bp-figure\{[^}]*\}/)[0];
  assert.match(fig, /background:#eef1f4/, '余白が黒っぽい');
  assert.match(fig, /align-items:center/);
  assert.match(fig, /justify-content:center/);
});

test('[36A 表示] 実寸から向きを決めている（固定 16:9 に押し込まない）', () => {
  // hover 側と click 側の 2 か所で、読み込み後の実寸から向きを決めている
  const uses = [...html.matchAll(/naturalWidth \/ \w+\.naturalHeight/g)];
  assert.ok(uses.length >= 2, '実寸から向きを決めている箇所が ' + uses.length + ' か所しかない');
  assert.match(html, /addEventListener\('load'/, '読み込み完了を待っていない');
  assert.ok(!/aspect-ratio:\s*16\s*\/\s*9/.test(html), '16:9 を強制している');
});

// ── 索引 ───────────────────────────────────────────────────────
test('[36A §9] photo index に footprint 由来の項目がある',
  { skip: !fs.existsSync(INDEX) && 'no index' }, () => {
    const idx = rj(INDEX);
    assert.equal(idx.policy.matching.includes('point-in-polygon'), true);
    assert.match(idx.policy.noDistanceFallback, /距離だけ/);
    assert.deepEqual(idx.policy.hoverShows, ['VERY_HIGH', 'HIGH']);
    const withFp = idx.records.filter((r) => r.matchMethod === 'footprint');
    assert.ok(withFp.length > 1000, 'footprint 方式の記録が少ない: ' + withFp.length);
    for (const r of withFp.slice(0, 50)) {
      for (const k of ['matchConfidence', 'matchType', 'nameEvidence', 'insideFootprint',
        'footprintCanonicalId', 'wikidataCoordinate']) {
        assert.ok(k in r, k + ' が無い');
      }
    }
    // hover に載っているのは HIGH / VERY_HIGH だけ
    for (const [cid, r] of Object.entries(idx.byCanonicalId)) {
      assert.ok(r.matchConfidence === 'HIGH' || r.matchConfidence === 'VERY_HIGH', cid);
      assert.ok(r.photos && r.photos.length, cid + ' に写真が無い');
      assert.equal(r.canonicalId, cid);
    }
  });

test('[36A §10] ライセンス不明の写真は入っていない', { skip: !fs.existsSync(INDEX) && 'no index' }, () => {
  const idx = rj(INDEX);
  for (const r of idx.records) for (const p of (r.photos || [])) {
    assert.ok(p.license && !/^unknown$/i.test(p.license), 'ライセンス不明: ' + r.curatedName);
  }
});

// ── §11 監査 ───────────────────────────────────────────────────
test('[36A §11] 自動採用した対応付けに wrong building が無い',
  { skip: !fs.existsSync(path.join(REPORT, 'match-audit.json')) && 'no audit' }, () => {
    const a = rj(path.join(REPORT, 'match-audit.json'));
    assert.ok(a.audited >= 100, '監査件数が 100 未満: ' + a.audited);
    assert.equal(a.tally.wrong, 0, 'wrong building がある: ' + a.tally.wrong);
    assert.equal(a.tally.noMatch, 0, '採用した建物に点が入っていないものがある');
    assert.ok(a.accuracy >= 99, 'accuracy が低い: ' + a.accuracy);
  });

test('[36A 表示 §10] 実機: 切らない・歪まない・はみ出さない',
  { skip: !fs.existsSync(path.join(REPORT, 'display-qa.json')) && 'no display qa' }, () => {
    const d = rj(path.join(REPORT, 'display-qa.json')).summary;
    assert.ok(d.measured >= 10, '標本が少ない: ' + d.measured);
    assert.equal(d.allContain, true, 'contain になっていない');
    assert.equal(d.noneDistorted, true, '歪んでいる画像がある');
    assert.equal(d.noneOverflow, true, 'カードからはみ出している');
    assert.equal(d.licenseAlwaysVisible, true, 'ライセンス表示が隠れている');
    assert.equal(d.cardAlwaysFitsViewport, true, 'カードが画面外へ出ている');
    assert.equal(d.jsErrors, 0);
    // 縦長・横長・正方形・超横長がそろっている
    for (const k of ['is-portrait', 'is-landscape', 'is-square', 'is-panorama']) {
      assert.ok((d.orientations[k] || 0) > 0, k + ' の標本が無い');
    }
  });

// ── §0 production / protected ─────────────────────────────────
test('[36A §0] production / protected は変更していない', () => {
  for (const [n, p] of [['production', PROD], ['protected', PROT]]) {
    const s = fs.readFileSync(p, 'utf-8');
    assert.ok(!/bp-figure/.test(s), n + ' に 36A の表示変更が入っている');
    assert.ok(!/BuildingPhoto/.test(s), n + ' に写真機能が入っている');
  }
});
