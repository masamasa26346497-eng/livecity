'use strict';
// Issue #52 追補: レビュー指摘の回帰 + 取得経路アダプタ（Wikidata P18 / Commons カテゴリ・P180 / OSM 明示タグ / geosearch / 名称検索）+ 取得器の制限。
// 区別: [fixture]=合成データ。経路のレスポンスは各 API の JSON 形式に沿った「記録済みレスポンス相当の合成物」で、実際の取得結果ではない。
// ネットワーク・実ブラウザは使わない。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), os = require('node:os');
const root = path.resolve(__dirname, '..');
const load = (f) => { const sb = { module: { exports: {} }, URL }; vm.runInNewContext(fs.readFileSync(path.join(root, f), 'utf8'), sb); return sb.module.exports; };
const PS = load('public/mission37f-photo-select.js');
const PP = load('public/mission52-photo-panel.js');
const T = 'https://thumb.wikimedia.org/wikipedia/commons/thumb/a/ab/';
const ph = (f, extra) => Object.assign({ thumbnailUrl: T + f, license: 'CC BY-SA 4.0', author: 'Taro', width: 320, height: 240,
  sourcePageUrl: 'https://commons.wikimedia.org/wiki/File:' + f, licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0' }, extra || {});
const imp = () => import('../tools/photos/lib/import-candidates.mjs');
const ada = () => import('../tools/photos/lib/route-adapters.mjs');
const sf = () => import('../tools/photos/lib/safe-fetch.mjs');

// Commons imageinfo 相当のレスポンス（実 API の形式に準拠した合成物）
const iiPage = (file, o) => {
  o = o || {};
  const meta = (v) => (v == null ? undefined : { value: v });
  return { title: 'File:' + file, imageinfo: [{ url: 'https://upload.wikimedia.org/wikipedia/commons/a/ab/' + file, thumburl: T + file, thumbwidth: 320, thumbheight: 240,
    descriptionurl: 'https://commons.wikimedia.org/wiki/File:' + file.replace(/ /g, '_'),
    extmetadata: Object.fromEntries(Object.entries({
      LicenseShortName: meta('license' in o ? o.license : 'CC BY-SA 4.0'), LicenseUrl: meta('licenseUrl' in o ? o.licenseUrl : 'https://creativecommons.org/licenses/by-sa/4.0'),
      Artist: meta('artist' in o ? o.artist : '<a href="//commons.wikimedia.org/wiki/User:Taro">Taro</a>'), ImageDescription: meta(o.desc || ''), DateTimeOriginal: meta(o.taken)
    }).filter(([, v]) => v)) }] };
};
const iiResp = (pages) => ({ query: { pages: Object.fromEntries(pages.map((p, i) => [String(100 + i), p])) } });
const BLD = { cg_A: { names: ['阪南タワー', 'Hannan Tower'], addressTokens: ['住吉区南住吉'], otherNames: ['南海ビル'], otherAddressTokens: ['平野区'] },
  cg_B: { names: ['南海ビル'], addressTokens: ['平野区'], otherNames: ['阪南タワー'], otherAddressTokens: ['住吉区南住吉'] } };

// ── レビュー1: カテゴリ所属は採用根拠にならない
test('[fixture] commons-category: explicitLink:true でも個別被写体/名称+住所の確認がなければ保留（カテゴリ内の別建物を採用しない）', async () => {
  const { importCandidates, evaluateEvidence } = await imp();
  const base = { canonicalId: 'cg_A', route: 'commons-category', thumbnailUrl: T + 'X.jpg', sourcePageUrl: 'https://commons.wikimedia.org/wiki/File:X.jpg', license: 'CC BY 4.0', licenseUrl: 'https://creativecommons.org/licenses/by/4.0', author: 'Taro' };
  assert.deepEqual(evaluateEvidence(Object.assign({}, base, { evidence: { explicitLink: true } })), { ok: false, reason: 'category-membership-only' });
  assert.equal(evaluateEvidence(Object.assign({}, base, { evidence: { explicitLink: true, name: true } })).ok, false, '名称だけでは不足');
  assert.equal(evaluateEvidence(Object.assign({}, base, { evidence: { name: true, address: true } })).ok, true, '個別写真の名称+住所が一致すれば採用可');
  // 明示的な矛盾は直接リンクでも不採用
  for (const [ev, why] of [[{ explicitLink: true, nameConflict: true }, 'name-conflict'], [{ explicitLink: true, addressConflict: true }, 'address-conflict'], [{ explicitLink: true, subject: false }, 'subject-conflict']]) {
    for (const route of ['wikidata-p18', 'osm-explicit', 'commons-p180']) assert.equal(evaluateEvidence({ route, evidence: ev }).reason, why, route + ' ' + why);
  }
  assert.equal(evaluateEvidence({ route: 'commons-p180', evidence: { explicitLink: true } }).ok, false, 'P180 は被写体が確認できて初めて直接リンク');
  const r = importCandidates([Object.assign({}, base, { evidence: { explicitLink: true } })], { byCanonicalId: {} });
  assert.equal(r.adopted.length, 0); assert.equal(r.held[0].reason, 'category-membership-only');
});

test('[fixture] カテゴリ内の別建物: ファイル名/説明に別の建物名だけが出る写真は name-conflict で保留、自建物と確認できる写真だけ採用', async () => {
  const { fromCommonsCategoryMembers, parseImageInfo, enrichRefs } = await ada();
  const { importCandidates } = await imp();
  const cat = { query: { categorymembers: [{ ns: 6, title: 'File:Hannan Tower front 2022.jpg' }, { ns: 6, title: 'File:Nankai Building 2021.jpg' }, { ns: 6, title: 'File:Nankai.jpg' }, { ns: 14, title: 'Category:Sub' }] } };
  const { refs } = fromCommonsCategoryMembers(cat, { canonicalId: 'cg_A', category: '阪南タワー' });
  assert.equal(refs.length, 3, '名前空間 6 (File) だけを候補にする');
  const ii = parseImageInfo(iiResp([
    iiPage('Hannan Tower front 2022.jpg', { desc: 'Hannan Tower, 住吉区南住吉 の正面' }),
    iiPage('Nankai Building 2021.jpg', { desc: '南海ビル 平野区 の外観' }),
    iiPage('Nankai.jpg', { desc: '' })]));
  const { candidates } = enrichRefs(refs, ii, BLD);
  const r = importCandidates(candidates, { byCanonicalId: {} });
  assert.deepEqual(r.adopted.map((a) => a.file), ['Hannan Tower front 2022.jpg']);
  const why = Object.fromEntries(r.held.map((h) => [h.file, h.reason]));
  assert.equal(why['Nankai Building 2021.jpg'], 'name-conflict');
  assert.equal(why['Nankai.jpg'], 'category-membership-only');
});

// ── レビュー2: 表示可否と import の一致、作者表記、ライセンスURL
test('[fixture] 帰属必須ライセンスの作者欠落・ライセンスURL欠落は保留（表示可否と保留理由を分離）。名称からURLを推測しない', () => {
  const m = (o) => PP.buildModel({ matchConfidence: 'HIGH', photos: [ph('A_2020.jpg', o)] }, {}, PS);
  const noAuthor = m({ author: '' });
  assert.equal(noAuthor.primary, null); assert.deepEqual(Array.from(noAuthor.held, (h) => h.reason), ['attribution-required-author-missing']);
  assert.equal(m({ author: 'Own work' }).held[0].reason, 'attribution-required-author-missing', '名前のない定型句だけでは帰属を満たせない');
  const noUrl = m({ licenseUrl: undefined });
  assert.equal(noUrl.primary, null); assert.equal(noUrl.held[0].reason, 'license-url-missing');
  assert.equal(m({ licenseUrl: 'https://evil.example/by-sa' }).held[0].reason, 'license-url-missing', '許可ホスト以外のURLは使わない');
  // CC0 / パブリックドメインは帰属・URLなしでも表示可
  assert.ok(m({ license: 'CC0', author: '', licenseUrl: undefined }).primary);
  assert.ok(m({ license: 'Public domain', author: '', licenseUrl: undefined }).primary);
  // 表示条件と import 側の判定は同じ関数（panel）を共有
  for (const o of [{ author: '' }, { licenseUrl: undefined }, { license: 'CC BY-NC 4.0' }, {}]) {
    const p = ph('A_2020.jpg', o);
    assert.equal(m(o).primary !== null, PP.photoEligibility(p).ok);
  }
});

test('[fixture] import 側も panel と同じ条件: ライセンスURLなしの帰属必須写真は保留', async () => {
  const { importCandidates } = await imp();
  const c = { canonicalId: 'cg_A', route: 'wikidata-p18', thumbnailUrl: T + 'Z.jpg', sourcePageUrl: 'https://commons.wikimedia.org/wiki/File:Z.jpg', license: 'CC BY 4.0', author: 'Taro', evidence: { explicitLink: true } };
  const r = importCandidates([c], { byCanonicalId: {} });
  assert.equal(r.held[0].reason, 'license-url-missing');
});

test('[fixture] 作者表記: 「I, 実名」「Photo taken by 実名」は実名を保持、名前のない定型句だけ作者なし', () => {
  assert.equal(PP.authorText('I, Taro Yamada, the copyright holder of this work, hereby publish it under'), 'Taro Yamada');
  assert.equal(PP.authorText('Photo taken by Hanako Sato'), 'Hanako Sato');
  assert.equal(PP.authorText('Photo by Jiro'), 'Jiro');
  assert.equal(PP.authorText('<a href="x">Taro</a>'), 'Taro');
  for (const g of ['Own work', 'own work', 'Unknown author', 'Unknown authorUnknown author', 'No machine-readable author provided. Foo assumed', '', null, 'I']) assert.equal(PP.authorText(g), null, String(g));
  const e = { matchConfidence: 'HIGH', photos: [ph('A_2020.jpg', { author: 'I, Taro Yamada, the copyright holder' })] };
  const doc = (function () { class N { constructor(t) { this.tag = t; this.children = []; this.attrs = {}; this._t = ''; } set textContent(v) { this._t = v; this.children = []; } get textContent() { return this._t + this.children.map((c) => c.textContent).join(''); }
    appendChild(c) { this.children.push(c); return c; } setAttribute(k, v) { this.attrs[k] = String(v); } addEventListener() {} get isConnected() { return true; } }
    return { createElement: (t) => new N(t), createTextNode: (t) => { const n = new N('#t'); n._t = t; return n; } }; })();
  const slot = doc.createElement('div'); PP.render(slot, PP.buildModel(e, {}, PS), doc, 'X');
  assert.match(slot.textContent, /作者: Taro Yamada \/ ライセンス: CC BY-SA 4\.0/);
});

// ── レビュー3: URL 検証
test('[fixture] commonsFile / サムネイル: ホスト・パスを URL として検証し、偽 Commons を弾く', async () => {
  const bad = ['https://evil.example/wiki/File:A.jpg', 'https://commons.wikimedia.org.evil.example/wiki/File:A.jpg', 'http://commons.wikimedia.org/wiki/File:A.jpg',
    'https://user:pw@commons.wikimedia.org/wiki/File:A.jpg', 'https://commons.wikimedia.org/wiki/File:A.jpg?x=1', 'https://commons.wikimedia.org/wiki/File:A.jpg#x',
    'https://commons.wikimedia.org/evil/wiki/File:A.jpg', 'https://commons.wikimedia.org/wiki/File:a/b.jpg', 'https://commons.wikimedia.org:8443/wiki/File:A.jpg',
    'javascript:alert(1)//wiki/File:A.jpg', 'https://commons.wikimedia.org/wiki/File:', '', null, undefined, 42];
  for (const u of bad) assert.equal(PP.commonsFile(u), null, String(u));
  assert.equal(PP.commonsFile('https://commons.wikimedia.org/wiki/File:Hanwa_hospital-01.jpg'), 'Hanwa hospital-01.jpg');
  assert.equal(PP.commonsFile('https://commons.wikimedia.org/wiki/File:%E9%98%AA.jpg'), '阪.jpg');
  for (const u of ['https://evil.example/wikipedia/commons/a.jpg', 'http://upload.wikimedia.org/wikipedia/commons/a.jpg', 'javascript:alert(1)', 'https://upload.wikimedia.org.evil.example/wikipedia/commons/a.jpg', 'https://upload.wikimedia.org/other/a.jpg', 'data:image/png;base64,AAAA'])
    assert.equal(PP.commonsImage(u), null, u);
  assert.ok(PP.commonsImage('https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/A.jpg/320px-A.jpg'));
  // buildModel: 偽 Commons / 偽サムネは保留、DOM の src に入らない
  const fake = PP.buildModel({ matchConfidence: 'HIGH', photos: [ph('A.jpg', { sourcePageUrl: 'https://evil.example/wiki/File:A.jpg' }), ph('B.jpg', { thumbnailUrl: 'https://evil.example/t.jpg' })] }, {}, PS);
  assert.equal(fake.primary, null);
  assert.deepEqual(Array.from(fake.held, (h) => h.reason).sort(), ['invalid-source-url', 'invalid-thumbnail-url']);
  const { importCandidates } = await imp();
  const mk = (o) => Object.assign({ canonicalId: 'cg_A', route: 'wikidata-p18', thumbnailUrl: T + 'A.jpg', sourcePageUrl: 'https://commons.wikimedia.org/wiki/File:A.jpg', license: 'CC0', evidence: { explicitLink: true } }, o);
  const r = importCandidates([mk({ sourcePageUrl: 'https://evil.example/wiki/File:Q.jpg' }), mk({ thumbnailUrl: 'https://evil.example/x.jpg' }), mk({ sourcePageUrl: 'https://commons.wikimedia.org/wiki/File:Ok.jpg' })], { byCanonicalId: {} });
  assert.deepEqual(r.held.map((h) => h.reason).sort(), ['invalid-source-url', 'invalid-thumbnail-url']);
  assert.equal(r.adopted.length, 1);
});

// ── レビュー4: maxAdditional と外観確認
test('[fixture] maxAdditional:0 は全分岐で追加写真 0。未分類は外観確認済みに数えない', () => {
  const ext = { matchConfidence: 'HIGH', photos: [ph('E_2020.jpg', { kind: 'exterior' }), ph('I1_2020.jpg', { kind: 'interior' }), ph('I2_2020.jpg', { kind: 'interior' })] };
  assert.equal(PP.buildModel(ext, { maxAdditional: 0 }, PS).additional.length, 0);
  assert.equal(PP.buildModel(ext, { maxAdditional: 1 }, PS).additional.length, 1);
  assert.equal(PP.buildModel(ext, {}, PS).additional.length, 2, '既定は最大4');
  const noExt = { matchConfidence: 'HIGH', photos: [ph('I1_2020.jpg', { kind: 'interior' }), ph('I2_2020.jpg', { kind: 'interior' })] };
  const z = PP.buildModel(noExt, { maxAdditional: 0 }, PS);
  assert.equal(z.state, 'no-exterior'); assert.equal(z.additional.length, 0, 'no-exterior 分岐でも 0 を尊重');
  assert.equal(PP.buildModel(noExt, { maxAdditional: 1 }, PS).additional.length, 1);
  assert.equal(PP.buildModel(noExt, {}, PS).additional.length, 2);
  const un = PP.buildModel({ matchConfidence: 'HIGH', photos: [ph('U_2020.jpg')] }, {}, PS);
  assert.ok(un.primary); assert.equal(un.exteriorConfirmed, false, '未分類は外観確認済みではない'); assert.equal(un.primary.exteriorConfirmed, false);
  assert.equal(PP.buildModel(ext, {}, PS).exteriorConfirmed, true);
  // 外観確認済みがあれば、未分類より優先
  const mix = PP.buildModel({ matchConfidence: 'HIGH', photos: [ph('U_2024.jpg'), ph('E_2010.jpg', { kind: 'exterior' })] }, {}, PS);
  assert.equal(mix.primary.file, 'E_2010.jpg');
});

// ── 経路別: 記録済みレスポンス → 統一候補 → 照合 → 採用/保留 → 索引接続 → 画面モデル
test('[fixture] Wikidata P18: wbgetentities → 候補 → 採用 → 索引接続 → 表示。Q が複数建物に結ばれていれば確定しない', async () => {
  const { fromWikidataEntities, parseImageInfo, enrichRefs } = await ada();
  const { importCandidates, mergeIntoIndex } = await imp();
  const wd = { entities: {
    Q1: { claims: { P18: [{ mainsnak: { datavalue: { value: 'Hannan_Tower_2022.jpg' } }, rank: 'preferred' }, { mainsnak: { datavalue: { value: 'Old_deprecated.jpg' } }, rank: 'deprecated' }] } },
    Q2: { claims: { P18: [{ mainsnak: { datavalue: { value: 'Shared.jpg' } } }] } },
    Q3: { claims: { P18: [{ mainsnak: { datavalue: { value: 'Unmapped.jpg' } } }] } } } };
  const { refs, skipped } = fromWikidataEntities(wd, { Q1: 'cg_A', Q2: ['cg_A', 'cg_B'] });
  assert.deepEqual(refs.map((r) => r.file), ['Hannan Tower 2022.jpg']);
  assert.deepEqual(skipped.map((s) => s.reason).sort(), ['qid-multiple-buildings', 'qid-unmapped']);
  const ii = parseImageInfo(iiResp([iiPage('Hannan Tower 2022.jpg', { desc: '阪南タワー', taken: '2022-04-01 10:00:00' })]));
  const { candidates } = enrichRefs(refs, ii, BLD, { fetchedAt: '2026-11-10' });
  const existing = { version: 2, byCanonicalId: {} };
  const r = importCandidates(candidates, existing);
  assert.equal(r.adopted.length, 1); assert.equal(r.adopted[0].evidenceBasis, 'explicit-link'); assert.equal(r.adopted[0].takenAt, '2022-04-01');
  assert.equal(r.adopted[0].photo.author, 'Taro', 'Artist の HTML は無害化される');
  // 索引に無い建物は registry がなければ接続しない
  assert.equal(mergeIntoIndex(existing, r.adopted).unattached.length, 1);
  const { index } = mergeIntoIndex(existing, r.adopted, { cg_A: { buildingName: '阪南タワー', wikidataId: 'Q1' } });
  assert.equal(Object.keys(existing.byCanonicalId).length, 0, '入力は変更しない');
  const m = PP.buildModel(index.byCanonicalId.cg_A, {}, PS);
  assert.equal(m.primary.file, 'Hannan_Tower_2022.jpg'.replace(/_/g, ' ').replace(/ /g, '_'));
  assert.equal(m.primary.author, 'Taro');
});

test('[fixture] Commons P180: 被写体リンクは直接採用、名称検索は名称+住所が要る、geosearch は距離のみで保留', async () => {
  const { fromCommonsSearch, fromCommonsGeosearch, parseImageInfo, enrichRefs } = await ada();
  const { importCandidates } = await imp();
  const p180 = fromCommonsSearch({ query: { search: [{ ns: 6, title: 'File:P180 photo.jpg' }] } }, { canonicalId: 'cg_A', route: 'commons-p180' });
  const nm = fromCommonsSearch({ query: { search: [{ ns: 6, title: 'File:Name only 阪南タワー.jpg' }, { ns: 6, title: 'File:Name addr 阪南タワー.jpg' }] } }, { canonicalId: 'cg_A', route: 'name-search' });
  const geo = fromCommonsGeosearch({ query: { geosearch: [{ ns: 6, title: 'File:Near.jpg', dist: 8.5 }] } }, { canonicalId: 'cg_A' });
  assert.throws(() => fromCommonsSearch({}, { canonicalId: 'x', route: 'geosearch' }));
  const ii = parseImageInfo(iiResp([iiPage('P180 photo.jpg'), iiPage('Name only 阪南タワー.jpg'), iiPage('Name addr 阪南タワー.jpg', { desc: '住吉区南住吉' }), iiPage('Near.jpg')]));
  const { candidates } = enrichRefs([].concat(p180.refs, nm.refs, geo.refs), ii, BLD);
  const r = importCandidates(candidates, { byCanonicalId: {} });
  assert.deepEqual(r.adopted.map((a) => a.file).sort(), ['Name addr 阪南タワー.jpg', 'P180 photo.jpg']);
  const why = Object.fromEntries(r.held.map((h) => [h.file, h.reason]));
  assert.equal(why['Near.jpg'], 'distance-only');
  assert.equal(why['Name only 阪南タワー.jpg'], 'insufficient-evidence');
  assert.equal(r.stats.byRoute.geosearch.adopted, 0);
});

test('[fixture] OSM 明示タグ: File は直接候補、Category は参照のみ、Commons 以外の image=URL は権利未確認で採用しない、未対応要素は無視', async () => {
  const { fromOverpassElements, parseImageInfo, enrichRefs } = await ada();
  const { importCandidates } = await imp();
  const ov = { elements: [
    { type: 'way', id: 1, tags: { wikimedia_commons: 'File:Osm tagged.jpg', building: 'yes' } },
    { type: 'way', id: 2, tags: { wikimedia_commons: 'Category:阪南タワー', wikidata: 'Q1' } },
    { type: 'way', id: 3, tags: { image: 'https://example.com/photo.jpg' } },
    { type: 'way', id: 4, tags: { image: 'https://commons.wikimedia.org/wiki/File:Via image tag.jpg' } },
    { type: 'way', id: 5, tags: { wikimedia_commons: 'File:Unmapped.jpg' } },
    { type: 'node', id: 6, tags: { name: 'no photo tags' } }] };
  const out = fromOverpassElements(ov, { 'way/1': 'cg_A', 'way/2': 'cg_A', 'way/3': 'cg_B', 'way/4': 'cg_B' });
  assert.deepEqual(out.refs.map((r) => r.file), ['Osm tagged.jpg', 'Via image tag.jpg']);
  assert.deepEqual(out.categoryRefs, [{ canonicalId: 'cg_A', category: '阪南タワー', osm: 'way/2' }]);
  assert.deepEqual(out.wikidataRefs, [{ qid: 'Q1', canonicalId: 'cg_A', osm: 'way/2' }]);
  assert.deepEqual(out.skipped.map((s) => s.reason).sort(), ['external-image-url-rights-unverified', 'osm-element-unmapped']);
  const ii = parseImageInfo(iiResp([iiPage('Osm tagged.jpg'), iiPage('Via image tag.jpg', { license: 'CC BY-NC 4.0' })]));
  const r = importCandidates(enrichRefs(out.refs, ii, BLD).candidates, { byCanonicalId: {} });
  assert.deepEqual(r.adopted.map((a) => a.file), ['Osm tagged.jpg']);
  assert.equal(r.held[0].reason, 'license-restricted', 'image= 経由でも個別ライセンスを確認する');
});

test('[fixture] 同じ Commons ファイルを複数経路で数えない / ライセンスURLを推測しない / 撮影日は日付形式のときだけ', async () => {
  const { fromWikidataEntities, fromCommonsSearch, parseImageInfo, enrichRefs } = await ada();
  const { importCandidates } = await imp();
  const a = fromWikidataEntities({ entities: { Q1: { claims: { P18: [{ mainsnak: { datavalue: { value: 'Same.jpg' } } }] } } } }, { Q1: 'cg_A' }).refs;
  const b = fromCommonsSearch({ query: { search: [{ ns: 6, title: 'File:Same.jpg' }] } }, { canonicalId: 'cg_A', route: 'commons-p180' }).refs;
  const ii = parseImageInfo(iiResp([iiPage('Same.jpg', { licenseUrl: null, taken: 'sometime in 2020' })]));
  assert.equal(ii.get('Same.jpg').licenseUrl, null, '名称 CC BY-SA 4.0 からURLを補わない');
  assert.equal(ii.get('Same.jpg').takenAt, null);
  const r = importCandidates(enrichRefs([].concat(a, b), ii, BLD).candidates, { byCanonicalId: {} });
  assert.equal(r.adopted.length, 0, 'ライセンスURLなし → 保留');
  const ii2 = parseImageInfo(iiResp([iiPage('Same.jpg')]));
  const r2 = importCandidates(enrichRefs([].concat(a, b), ii2, BLD).candidates, { byCanonicalId: {} });
  assert.equal(r2.adopted.length, 1); assert.equal(r2.duplicates.length, 1);
  assert.equal(r2.stats.byRoute['wikidata-p18'].adopted, 1); assert.equal(r2.stats.byRoute['commons-p180'].adopted, 0);
});

test('[fixture] 阪和病院の新旧: 移転後の写真は旧IDに採用されず、索引接続後も旧IDの代表は旧病棟の写真のまま', async () => {
  const { importCandidates, mergeIntoIndex } = await imp();
  const idx = JSON.parse(fs.readFileSync(path.join(root, 'public/map-data/osaka-city/derived/building-photo-index.json'), 'utf8'));
  const OLD = 'cg_bldg_bldg_ec74351a-f344-4b61-b2e6-04b660b05aa0';
  const f = 'Hanwa_memorial_hospital_2023-12_2.jpg';
  const c = { canonicalId: OLD, route: 'commons-p180', thumbnailUrl: T + f, sourcePageUrl: 'https://commons.wikimedia.org/wiki/File:' + f, license: 'CC BY-SA 4.0', licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0', author: 'Taro', evidence: { explicitLink: true, subject: true } };
  const r = importCandidates([c], idx, { relocated: { [OLD]: ['Hanwa memorial hospital 2023-12 2.jpg'] } });
  assert.equal(r.adopted.length, 0); assert.equal(r.held[0].reason, 'relocation-excluded');
  const m = mergeIntoIndex(idx, r.adopted).index;
  assert.equal(PP.buildModel(m.byCanonicalId[OLD], { okConfidence: idx.policy.clickShows, exclude: [f] }, PS).primary.file, 'Hanwa_hospital-01.jpg');
});

// ── 取得器の制限
test('[fixture] safe-fetch: 許可ホスト/パス/action 以外とリダイレクト先を拒否、リトライ上限・キャッシュ・オフライン', async () => {
  const { validateUrl, createFetcher, MAX_RETRIES } = await sf();
  const ok = 'https://commons.wikimedia.org/w/api.php?action=query&format=json&titles=File:A.jpg';
  assert.equal(validateUrl(ok).ok, true);
  assert.equal(validateUrl('https://www.wikidata.org/w/api.php?action=wbgetentities&ids=Q1&format=json').ok, true);
  for (const [u, why] of [['http://commons.wikimedia.org/w/api.php?action=query', 'not-https'], ['https://evil.example/w/api.php?action=query', 'host-not-allowed'],
    ['https://commons.wikimedia.org.evil.example/w/api.php?action=query', 'host-not-allowed'], ['https://upload.wikimedia.org/a.jpg', 'host-not-allowed'],
    ['https://commons.wikimedia.org/w/api.php?action=edit', 'action-not-allowed'], ['https://www.wikidata.org/w/api.php?action=wbeditentity', 'action-not-allowed'],
    ['https://commons.wikimedia.org/w/index.php?title=x', 'path-not-allowed'], ['https://u:p@commons.wikimedia.org/w/api.php?action=query', 'credentials-in-url'],
    ['https://commons.wikimedia.org:8443/w/api.php?action=query', 'port-not-allowed'], ['nonsense', 'invalid-url']])
    assert.equal(validateUrl(u).reason, why, u);
  const res = (status, body, loc) => ({ status, headers: { get: (h) => (h.toLowerCase() === 'location' ? loc : null) }, json: async () => body });
  const noSleep = async () => {};
  // リダイレクト先が許可外 → 追わない
  let calls = [];
  let f = createFetcher({ fetchImpl: async (u) => { calls.push(u); return res(302, null, 'https://evil.example/steal'); }, sleepImpl: noSleep, minIntervalMs: 0 });
  await assert.rejects(f.getJson(ok), /blocked-redirect:host-not-allowed/); assert.equal(calls.length, 1);
  // 許可内リダイレクトは追う（3回まで）
  calls = [];
  f = createFetcher({ fetchImpl: async (u) => { calls.push(u); return calls.length < 3 ? res(301, null, 'https://commons.wikimedia.org/w/api.php?action=query&n=' + calls.length) : res(200, { ok: 1 }); }, sleepImpl: noSleep, minIntervalMs: 0 });
  assert.deepEqual(await f.getJson(ok), { ok: 1 }); assert.equal(f.stats.redirects, 2);
  f = createFetcher({ fetchImpl: async () => res(302, null, 'https://commons.wikimedia.org/w/api.php?action=query'), sleepImpl: noSleep, minIntervalMs: 0 });
  await assert.rejects(f.getJson(ok), /too-many-redirects/);
  // リトライ上限
  calls = [];
  f = createFetcher({ fetchImpl: async (u) => { calls.push(u); return res(429, null); }, sleepImpl: noSleep, minIntervalMs: 0 });
  await assert.rejects(f.getJson(ok), /retry-limit:429/); assert.equal(calls.length, MAX_RETRIES + 1);
  // 許可外 URL は fetch を呼ばない
  calls = [];
  f = createFetcher({ fetchImpl: async (u) => { calls.push(u); return res(200, {}); }, sleepImpl: noSleep, minIntervalMs: 0 });
  await assert.rejects(f.getJson('https://evil.example/x'), /blocked-url:host-not-allowed/); assert.equal(calls.length, 0);
  // キャッシュ → 再開 / オフライン
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-'));
  calls = [];
  f = createFetcher({ fetchImpl: async (u, init) => { calls.push(init); return res(200, { v: 1 }); }, sleepImpl: noSleep, minIntervalMs: 0, cacheDir: dir });
  await f.getJson(ok); await f.getJson(ok);
  assert.equal(calls.length, 1); assert.equal(f.stats.cacheHits, 1);
  assert.equal(calls[0].method, 'GET'); assert.equal(calls[0].redirect, 'manual');
  assert.match(calls[0].headers['User-Agent'], /^LiveCity-photo-index/); assert.ok(!/@/.test(calls[0].headers['User-Agent']), 'UA に連絡先メール等を入れない');
  const off = createFetcher({ fetchImpl: async () => { throw new Error('no network'); }, offline: true, cacheDir: dir });
  assert.deepEqual(await off.getJson(ok), { v: 1 });
  await assert.rejects(off.getJson(ok + '&x=1'), /offline-cache-miss/);
  // 要求間隔（ミリ秒）
  const waits = [];
  f = createFetcher({ fetchImpl: async () => res(200, {}), sleepImpl: async (ms) => { waits.push(ms); }, minIntervalMs: 1000 });
  await f.getJson(ok); await f.getJson(ok + '&a=1');
  assert.ok(waits.length >= 1 && waits.every((w) => w > 0 && w <= 1000), 'minIntervalMs はミリ秒: ' + waits);
});

test('[fixture] fetch-issue52-routes.run: 記録済みレスポンス（偽 getJson）で P18 取得→imageinfo→照合→採用/保留。URL は許可ホストのみ', async () => {
  const { run, wikidataUrl, imageInfoUrl } = await import('../tools/photos/fetch-issue52-routes.mjs');
  const { validateUrl } = await sf();
  const index = { byCanonicalId: {
    cg_A: { wikidataId: 'Q1', buildingName: '阪南タワー', matchConfidence: 'HIGH', photos: [] },
    cg_B: { wikidataId: 'Q2', buildingName: '南海ビル', matchConfidence: 'HIGH', photos: [ph('Have.jpg')] },
    cg_C: { buildingName: 'Wikidataなし', photos: [] } } };
  const urls = [];
  const getJson = async (u) => {
    urls.push(u);
    if (u.includes('wikidata.org')) return { entities: { Q1: { claims: { P18: [{ mainsnak: { datavalue: { value: 'Hannan Tower.jpg' } } }] } }, Q2: { claims: { P18: [{ mainsnak: { datavalue: { value: 'Have.jpg' } } }, { mainsnak: { datavalue: { value: 'NC thing.jpg' } } }] } } } };
    return iiResp([iiPage('Hannan Tower.jpg', { desc: '阪南タワー' }), iiPage('Have.jpg'), iiPage('NC thing.jpg', { license: 'CC BY-NC 4.0' })]);
  };
  const out = await run(index, getJson, { fetchedAt: '2026-11-10' });
  assert.equal(out.targets, 2);
  assert.ok(urls.length === 2 && urls.every((u) => validateUrl(u).ok), urls.join('\n'));
  assert.ok(validateUrl(wikidataUrl(['Q1', 'Q2'])).ok && validateUrl(imageInfoUrl(['A b.jpg', 'C.jpg'])).ok);
  const s = out.result.stats;
  assert.equal(s.adopted, 1); assert.equal(s.duplicates, 1); assert.equal(s.held, 1);
  assert.equal(s.netNewBuildings, 1); assert.equal(s.buildingsWithPhotoBefore, 1); assert.equal(s.buildingsWithPhotoAfter, 2);
  assert.equal(out.result.held[0].reason, 'license-restricted');
});
