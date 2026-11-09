'use strict';
// Issue #52: 写真パネル・ライセンス判定・取り込み検証の試験。ネットワーク不使用。
// 区別: [fixture]=合成データ / [real-index]=リポジトリ内の既存索引（実データ）。実ブラウザでの画面確認ではない。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const load = (f) => { const sb = { module: { exports: {} } }; vm.runInNewContext(fs.readFileSync(path.join(root, f), 'utf8'), sb); return sb.module.exports; };
const PS = load('public/mission37f-photo-select.js');
const PP = load('public/mission52-photo-panel.js');
const idx = JSON.parse(fs.readFileSync(path.join(root, 'public/map-data/osaka-city/derived/building-photo-index.json'), 'utf8'));
const HANWA_OLD = 'bldg_ec74351a-f344-4b61-b2e6-04b660b05aa0';
const HANWA_MEM = 'bldg_fae25b63-cddc-4545-8004-c41620676308';

const ph = (f, extra) => Object.assign({ thumbnailUrl: 'https://thumb.wikimedia.org/x/' + f, license: 'CC BY-SA 4.0', author: 'Taro', width: 320, height: 240,
  sourcePageUrl: 'https://commons.wikimedia.org/wiki/File:' + f, licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0' }, extra || {});

// ── 最小のDOMスタブ（textContent / 属性 / 子要素 / イベント）
function makeDoc() {
  class N { constructor(t) { this.tag = t; this.children = []; this.attrs = {}; this._t = ''; this.parent = null; this.l = {}; }
    set textContent(v) { this._t = v; this.children = []; } get textContent() { return this._t + this.children.map((c) => c.textContent).join(''); }
    appendChild(c) { c.parent = this; this.children.push(c); return c; }
    replaceChild(n, o) { const i = this.children.indexOf(o); n.parent = this; this.children[i] = n; o.parent = null; }
    setAttribute(k, v) { this.attrs[k] = String(v); } addEventListener(e, f) { this.l[e] = f; }
    get isConnected() { return true; } }
  return { createElement: (t) => new N(t), createTextNode: (t) => { const n = new N('#text'); n._t = t; return n; } };
}
const walk = (n, f) => { f(n); n.children.forEach((c) => walk(c, f)); };

test('[fixture] ライセンス判定: CC BY/BY-SA/CC0/PD は採用、NC/ND・不明・曖昧名は採用しない', async () => {
  const { classifyLicense } = await import('../tools/photos/lib/photo-license.mjs');
  for (const l of ['CC BY 4.0', 'CC BY-SA 3.0', 'CC0', 'Public domain', 'CC BY 2.5']) { assert.equal(classifyLicense(l).ok, true, l); assert.equal(PP.classifyLicense(l).ok, true, l); }
  for (const l of ['CC BY-NC 4.0', 'CC BY-ND 2.0', 'CC BY-NC-SA 3.0', '', null, 'Attribution', 'FAL', 'All rights reserved']) {
    assert.equal(classifyLicense(l).ok, false, String(l)); assert.equal(PP.classifyLicense(l).ok, false, String(l));
  }
  // ブラウザ版と tools 版は同じ判定
  for (const l of Object.keys({ 'CC BY 4.0': 1, 'CC BY-NC 4.0': 1, FAL: 1, CC0: 1, '': 1 })) assert.equal(PP.classifyLicense(l).kind, classifyLicense(l).kind);
});

test('[fixture] 外部メタデータのHTMLは無害化され、DOMへは textContent だけで入る', () => {
  assert.equal(PP.plainText('<script>alert(1)</script><b>Taro</b>'), 'alert(1) Taro');
  assert.equal(PP.authorText('Own work'), null);
  assert.equal(PP.authorText('<a href="javascript:x">Hanako</a>'), 'Hanako');
  const e = { matchConfidence: 'HIGH', photos: [ph('A_2020.jpg', { author: '<img src=x onerror=alert(1)>Evil' })] };
  const m = PP.buildModel(e, {}, PS);
  const doc = makeDoc(); const slot = doc.createElement('div');
  PP.render(slot, m, doc, '<b>名前</b>');
  assert.ok(!/<img|onerror|<b>/.test(slot.textContent), slot.textContent);
  assert.match(slot.textContent, /Evil/);
});

test('[fixture] 低確度・ライセンス保留・権利不明は表示せず、別の写真で埋めない', () => {
  assert.equal(PP.buildModel(null, {}, PS).state, 'no-entry');
  assert.equal(PP.buildModel({ matchConfidence: 'UNRESOLVED', photos: [ph('A.jpg')] }, {}, PS).state, 'low-confidence');
  const nc = PP.buildModel({ matchConfidence: 'HIGH', photos: [ph('A.jpg', { license: 'CC BY-NC 4.0' })] }, {}, PS);
  assert.equal(nc.state, 'license-hold'); assert.equal(nc.primary, null); assert.equal(nc.held[0].reason, 'license-restricted');
  const none = PP.buildModel({ matchConfidence: 'HIGH', photos: [ph('A.jpg', { license: '' })] }, {}, PS);
  assert.equal(none.primary, null);
  const mix = PP.buildModel({ matchConfidence: 'HIGH', photos: [ph('A_2010.jpg', { license: 'Attribution' }), ph('B_2005.jpg')] }, {}, PS);
  assert.equal(PS.fileName(mix.primary.photo), 'B_2005.jpg', '権利確認できない新しい写真ではなく、確認できる写真を代表にする');
});

test('[fixture] 代表/追加写真の分離: 周辺の街並みは代表にしない、外観がなければ代表なし', () => {
  const e = { matchConfidence: 'VERY_HIGH', photos: [ph('Street_2024.jpg', { kind: 'surroundings' }), ph('Front_2020.jpg', { kind: 'exterior' }), ph('In_2021.jpg', { kind: 'interior' })] };
  const m = PP.buildModel(e, {}, PS);
  assert.equal(PS.fileName(m.primary.photo), 'Front_2020.jpg');
  assert.deepEqual(Array.from(m.additional, (u) => u.file), ['In_2021.jpg']);
  assert.equal(m.surroundings.length, 1, '周辺写真は別枠で数える');
  const only = PP.buildModel({ matchConfidence: 'HIGH', photos: [ph('In_2021.jpg', { kind: 'interior' })] }, {}, PS);
  assert.equal(only.state, 'no-exterior'); assert.equal(only.primary, null);
});

test('[fixture] 撮影日: 検証済みだけ表示、unknown は最新扱いにせず「未確認」、アップロード日は使わない', () => {
  const e = { matchConfidence: 'HIGH', photos: [ph('Unknown.jpg'), ph('Old_2015.jpg')] };
  const m = PP.buildModel(e, {}, PS);
  assert.equal(PS.fileName(m.primary.photo), 'Old_2015.jpg', '年が分かる写真が unknown より前');
  const doc = makeDoc(); const slot = doc.createElement('div'); PP.render(slot, m, doc, 'X');
  const taken = []; walk(slot, (n) => { if (n.attrs['data-photo-taken']) taken.push(n.attrs['data-photo-taken']); });
  assert.ok(taken.every((t) => t === 'unknown'), '検証済み日付がなければ全て未確認: ' + taken);
});

test('[fixture] 画像404: 別の写真に差し替えず、出典リンクだけを示す', () => {
  const m = PP.buildModel({ matchConfidence: 'HIGH', photos: [ph('A_2020.jpg')] }, {}, PS);
  const doc = makeDoc(); const slot = doc.createElement('div'); PP.render(slot, m, doc, 'X');
  let img; walk(slot, (n) => { if (n.tag === 'img') img = n; });
  img.l.error();
  let err = false, imgs = 0; walk(slot, (n) => { if (n.attrs['data-photo-error']) err = true; if (n.tag === 'img') imgs++; });
  assert.ok(err); assert.equal(imgs, 0);
});

test('[real-index] 阪和病院の新旧: 旧IDは2023年の新病棟写真を使わない（37Fの移転除外を維持）', () => {
  const e = idx.byCanonicalId['cg_bldg_' + HANWA_OLD];
  const mem = idx.byCanonicalId['cg_bldg_' + HANWA_MEM];
  const opts = (ex) => ({ okConfidence: idx.policy.clickShows, exclude: ex });
  const old = PP.buildModel(e, opts(['Hanwa_memorial_hospital_2023-12_2.jpg']), PS);
  assert.equal(old.primary.file, 'Hanwa_hospital-01.jpg');
  assert.ok(!old.additional.some((u) => /2023-12/.test(u.file)));
  const m2 = PP.buildModel(mem, opts(['Hanwa_memorial_hospital_2023-12_1.jpg']), PS);
  assert.ok(![m2.primary].concat(m2.additional).filter(Boolean).some((u) => /2023-12_1/.test(u.file)));
  // ページが RELOCATED を buildModel へ渡す配線になっている
  const page = fs.readFileSync(path.join(root, 'public/mission37g-osaka-24ward-mvp.html'), 'utf8');
  assert.match(page, /<script src="mission52-photo-panel\.js"><\/script>/);
  assert.match(page, /LiveCityPhotoPanel\.buildModel\(entry, photoOpts, LiveCityPhotoSelect\)/);
  assert.match(page, /exclude: \(reloc \? reloc\.exclude : \[\]\)/);
  assert.match(page, /LiveCityPhotoPanel\.classifyLicense/);
});

test('[real-index] 既存の確認済み写真: 採用された写真は全て出典URL・https・個別ライセンスを持つ。曖昧なライセンス名は保留', () => {
  let shown = 0, withExtra = 0, heldTotal = 0;
  for (const [k, e] of Object.entries(idx.byCanonicalId)) {
    const m = PP.buildModel(e, { okConfidence: idx.policy.clickShows }, PS);
    heldTotal += m.held.length;
    for (const u of [m.primary].concat(m.additional).filter(Boolean)) {
      assert.ok(PP.classifyLicense(u.photo.license).ok, k);
      assert.match(u.photo.sourcePageUrl, /^https:\/\/commons\.wikimedia\.org\/wiki\/File:/);
      assert.match(u.photo.thumbnailUrl, /^https:/);
    }
    if (m.primary) shown++;
    if (m.additional.length) withExtra++;
  }
  assert.equal(heldTotal, 2, '建物IDで引ける写真のうち曖昧なライセンス名(Attribution / FAL)は2件');
  assert.equal(shown, 573, '574件中1件(FALのみのFestivalGate)は代表なし。今昔館は別の写真が代表');
  assert.equal(withExtra, 11, '複数写真を持つ12件のうち、保留で1件が単一になる');
});

test('[fixture] 取り込み: 距離だけ・名称不一致・ライセンス不明・移転前後・同名施設・重複・撮影日不明を処理', async () => {
  const { importCandidates, evaluateEvidence } = await import('../tools/photos/lib/import-candidates.mjs');
  const existing = { byCanonicalId: { 'cg_bldg_A': { photos: [ph('Existing.jpg')] } } };
  const c = (f, o) => Object.assign({ canonicalId: 'cg_bldg_B', route: 'wikidata-p18', thumbnailUrl: 'https://thumb.wikimedia.org/' + f, imageUrl: 'https://upload.wikimedia.org/' + f,
    sourcePageUrl: 'https://commons.wikimedia.org/wiki/File:' + f, license: 'CC BY-SA 4.0', licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0', author: 'Taro',
    evidence: { explicitLink: true, name: true } }, o || {});
  const cands = [
    c('Good_2024.jpg', { takenAt: '2024-05-03', dateEvidenceUrl: 'https://commons.wikimedia.org/wiki/File:Good_2024.jpg' }),
    c('Good_2024.jpg', { route: 'commons-category' }),                                   // 同一ファイルの別経路 → 二重計上しない
    c('Existing.jpg', { canonicalId: 'cg_bldg_A', route: 'commons-p180' }),               // 既存と同一 → 重複
    c('Near.jpg', { route: 'geosearch', evidence: { distanceM: 12 } }),                  // 距離のみ → 保留
    c('Conflict.jpg', { evidence: { explicitLink: true, nameConflict: true } }),         // 名称衝突 → 保留
    c('NC.jpg', { license: 'CC BY-NC 4.0' }),                                           // 非商用 → 保留
    c('NoLic.jpg', { license: '' }),
    c('NoAuthor.jpg', { author: '' }),                                                  // 帰属必須で作者なし → 保留
    c('Hanwa_memorial_hospital_2023-12_2.jpg', { canonicalId: HANWA_OLD, evidence: { name: true, address: true } }), // 移転後の写真を旧IDへ → 保留
    c('Same.jpg', { canonicalId: 'cg_bldg_C', route: 'name-search', evidence: { name: true, address: true } }),     // 同名施設で同一ファイルが2棟へ → 保留
    c('Same.jpg', { canonicalId: 'cg_bldg_D', route: 'name-search', evidence: { name: true, address: true } }),
    c('NoDate.jpg', { route: 'name-search', evidence: { name: true, subject: true }, takenAt: '2020-01-01' }),          // 日付根拠URLなし → 日付は不明扱い
    c('Plain.jpg', { thumbnailUrl: 'http://insecure/x.jpg' })
  ];
  const r = importCandidates(cands, existing, { relocated: { [HANWA_OLD]: ['Hanwa memorial hospital 2023-12 2.jpg'] } });
  const adopted = r.adopted.map((a) => a.file).sort();
  assert.deepEqual(adopted, ['Good 2024.jpg', 'NoDate.jpg']);
  const reasons = Object.fromEntries(r.held.map((h) => [h.file + '@' + h.canonicalId, h.reason]));
  assert.equal(reasons['Near.jpg@cg_bldg_B'], 'distance-only');
  assert.equal(reasons['Conflict.jpg@cg_bldg_B'], 'name-conflict');
  assert.equal(reasons['NC.jpg@cg_bldg_B'], 'license-restricted');
  assert.equal(reasons['NoLic.jpg@cg_bldg_B'], 'license-unknown');
  assert.equal(reasons['NoAuthor.jpg@cg_bldg_B'], 'attribution-required-author-missing');
  assert.equal(reasons['Hanwa memorial hospital 2023-12 2.jpg@' + HANWA_OLD], 'relocation-excluded');
  assert.equal(reasons['Same.jpg@cg_bldg_C'], 'same-file-multiple-buildings');
  assert.equal(reasons['Plain.jpg@cg_bldg_B'], 'non-https-or-missing-url');
  assert.equal(r.duplicates.length, 2);
  assert.equal(r.adopted.find((a) => a.file === 'NoDate.jpg').takenAt, null, '根拠URLなしの日付は採用しない');
  assert.equal(r.adopted.find((a) => a.file === 'Good 2024.jpg').takenAt, '2024-05-03');
  assert.equal(r.stats.buildingsWithPhotoBefore, 1); assert.equal(r.stats.buildingsWithPhotoAfter, 2); assert.equal(r.stats.netNewBuildings, 1);
  assert.equal(r.stats.adoptedWithKnownDate, 1);
  assert.equal(evaluateEvidence({ route: 'geosearch', evidence: { distanceM: 3 } }).ok, false);
});

test('[real-index] 監査: 既存データの実測値（本PRの純増は0）', async () => {
  const { audit } = await import('../tools/photos/audit-photo-index.mjs');
  const a = audit(idx, JSON.parse(fs.readFileSync(path.join(root, 'public/map-data/osaka-city/derived/photo-dates.json'), 'utf8')));
  assert.equal(a.records.facilityRecords, 2596);
  assert.equal(a.uniqueBuildingIds.byCanonicalId, 574);
  assert.equal(a.denominators.namedBuildingsTotal, 20130);
  assert.equal(a.photos.uniqueCommonsFiles, a.photos.total, '同一ファイルの多重計上なし');
  assert.deepEqual(a.photos.licensesNotAdopted, { Attribution: 4, FAL: 1 });
  assert.equal(a.netNewFromThisPR, 0);
  const saved = JSON.parse(fs.readFileSync(path.join(root, 'data/photos/audit-before.json'), 'utf8'));
  assert.deepEqual(saved, JSON.parse(JSON.stringify(a)), 'data/photos/audit-before.json が最新');
});
