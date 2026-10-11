'use strict';
/**
 * Mission 37E — Places UI Kit 写真表示のオフラインテスト。
 *   node --test tests/mission37e-places-ui-kit.test.cjs
 *
 * **このテストは Google へ一切通信しない。** fetch は全て差し替え、
 * 照合索引はリポジトリ内の実データを読む。
 *
 * 守りたいこと:
 *   1. 課金ロック: 要素生成（＝課金イベント）が ENABLED=false の間は必ず失敗する
 *   2. ページ・モジュールのどこにも Google のローダー / エンドポイントが無い
 *   3. 照合キーが実データで成立する（Issue 記載の 'cg_' + id は 0 件、'cg_bldg_' + id が正）
 *   4. 住吉区の実データから取った VERIFIED 建物で照合できる
 *   5. 未照合・通信失敗で前の建物の写真が残らない
 *   6. 非同期競合: 連続選択で古い結果が後から表示を書き換えない
 *   7. マークアップが公式ドキュメントのタグ・属性と一致する
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf-8');
const readJson = (p) => JSON.parse(read(p));

// ブラウザと同じクラシックスクリプトとして vm で評価する（理由はモジュール冒頭のコメント）。
const vm = require('node:vm');
function loadKit() {
  const sandbox = { console };
  vm.createContext(sandbox);
  vm.runInContext(read('public/mission37e-places-ui-kit.js'), sandbox,
    { filename: 'mission37e-places-ui-kit.js' });
  assert.deepEqual(Object.keys(sandbox).sort(), ['LiveCityPlacesUiKit37E', 'console'],
    'グローバルを 1 つだけ公開する約束が破れている');
  return sandbox.LiveCityPlacesUiKit37E;
}
const kit = loadKit();
const page = read('public/mission37d-sumiyoshi-mvp.html');
const moduleSrc = read('public/mission37e-places-ui-kit.js');
const INDEX_PATH = 'public/mission37d-data/verified-google-place-ids.json';
const index = readJson(INDEX_PATH);

// ── 住吉区で実際に表示される建物のうち VERIFIED 対応があるものを実データから抽出 ──
function verifiedSumiyoshiCases(limit) {
  const idsDir = path.join(ROOT, 'public/mission37b-3dtiles/osaka-sumiyoshi-9tile/ids');
  const out = [];
  for (const f of fs.readdirSync(idsDir).filter((x) => x.startsWith('t_'))) {
    for (const canonicalId of JSON.parse(fs.readFileSync(path.join(idsDir, f), 'utf-8'))) {
      const placeId = index.byBuildingId[kit.toPlaceIndexKey(canonicalId)];
      if (placeId) out.push({ canonicalId, placeId });
      if (out.length >= limit) return out;
    }
  }
  return out;
}

/** 最小の DOM スタブ。jsdom を足さずにレンダリング結果を確かめる。 */
function makeStubDom() {
  const mk = (tag) => ({
    tagName: tag, children: [], dataset: {}, attributes: {},
    _text: '',
    get textContent() {
      return this.children.length ? this.children.map((c) => c.textContent).join('\n') : this._text;
    },
    set textContent(v) { this._text = String(v); this.children = []; },
    appendChild(c) { this.children.push(c); this._text = ''; return c; },
    replaceChildren() { this.children = []; this._text = ''; },
    setAttribute(k, v) { this.attributes[k] = v; },
  });
  return { documentImpl: { createElement: mk }, container: mk('div') };
}

const okFetch = (data) => () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(data) });

// ══════════════════════════════════════════════════════════════════════
// 1. 課金ロック
// ══════════════════════════════════════════════════════════════════════
test('[37E] ENABLED=false で、要素生成（=課金イベント）が必ず失敗する', () => {
  assert.equal(kit.ENABLED, false);
  const { documentImpl } = makeStubDom();
  const valid = Object.values(index.byBuildingId)[0];
  assert.ok(kit.isValidPlaceId(valid));
  assert.throws(() => kit.createPlaceDetailsElement(documentImpl, valid), (e) => {
    assert.equal(e.code, 'E_BILLING_LOCKED');
    assert.ok(e.blockers.length > 0, '未解決ブロッカーが列挙されていない');
    return true;
  });
});

test('[37E] 課金は「コンポーネント生成ごと」だと明記され、SKU と無料枠を持っている', () => {
  assert.equal(kit.BILLING.billingTrigger, 'per component instantiation');
  assert.equal(kit.BILLING.sku, 'Places UI Kit Pro');
  assert.equal(kit.BILLING.pricePer1000Usd, 5);
  assert.equal(kit.BILLING.freeMonthlyEvents, 5000);
  assert.match(kit.BILLING.billingTriggerQuote, /billed per component instantiation/);
  for (const u of Object.values(kit.BILLING.docs)) assert.match(u, /^https:\/\/developers\.google\.com\//);
});

test('[37E] 100 件テストの見積もりが出せ、上限保証でないと明示している', () => {
  const a = kit.describeActivation(100);
  assert.equal(a.enabled, false);
  assert.equal(a.estimate.billableEvents, 0, '無料枠 5,000 件の内側なので課金対象は 0');
  assert.equal(a.estimate.estimatedUsd, 0);
  assert.match(a.estimate.caveat, /上限保証ではない/);
  assert.ok(a.blockers.length >= 3);
  // 無料枠を超えた場合の単価が正しく効く
  assert.equal(kit.describeActivation(6000).estimate.billableEvents, 1000);
  assert.equal(kit.describeActivation(6000).estimate.estimatedUsd, 5);
});

test('[37E] 非 Google 地図と併用する条件がポリシー原文つきで持たれている', () => {
  const p = kit.DISPLAY_POLICY;
  assert.equal(p.allowedBesideNonGoogleMap, true);
  assert.equal(p.googleLogoRequired, true, '非 Google 地図では Google ロゴが必須');
  assert.equal(p.mustNotPlotOnNonGoogleMap, true, 'Cesium の地図上に結果を描くのは不可');
  assert.match(p.quoteOffMap, /must include the Google logo/);
  assert.match(p.quoteOnMap, /must be shown on a Google Map/);
  assert.match(p.quotePhotoAuthor, /credit the author/);
  // ロゴ未実装はブロッカーに入っている
  assert.ok(kit.ACTIVATION_BLOCKERS.some((b) => /ロゴ/.test(b)));
});

// ══════════════════════════════════════════════════════════════════════
// 2. Google への通信経路が存在しないこと
// ══════════════════════════════════════════════════════════════════════
test('[37E] ページにもモジュールにも Google のローダー / エンドポイントが無い', () => {
  for (const [name, src] of [['page', page], ['module', moduleSrc]]) {
    for (const bad of ['maps.googleapis.com', 'importLibrary(', 'googleapis.com/maps/api/js', 'YOUR_API_KEY']) {
      // ドキュメント URL やコメント内の説明は developers.google.com なので引っかからない
      assert.ok(!src.includes(bad), name + ' に ' + bad + ' がある');
    }
    assert.ok(!/<script[^>]+google/i.test(src), name + ' に Google の script タグがある');
  }
});

test('[37E] API キーらしき文字列がリポジトリの配信物に無い', () => {
  for (const src of [page, moduleSrc]) {
    assert.ok(!/AIza[0-9A-Za-z_-]{20,}/.test(src), 'Google API キーが埋め込まれている');
  }
});

test('[37E] 索引 URL は同一オリジン限定で、外部 URL を拒否する', () => {
  assert.throws(() => new kit.PlacePhotoPanel({ indexUrl: 'https://example.com/a.json' }), /same-origin/);
  assert.throws(() => new kit.PlacePhotoPanel({}), /indexUrl is required/);
});

test('[37E] 照合中に読むのは同一オリジンの索引 1 本だけ', async () => {
  const calls = [];
  const dom = makeStubDom();
  const panel = new kit.PlacePhotoPanel({
    indexUrl: 'mission37d-data/verified-google-place-ids.json',
    fetchImpl: (u) => { calls.push(u); return okFetch(index)(); },
    ...dom,
  });
  const c = verifiedSumiyoshiCases(1)[0];
  await panel.select(c.canonicalId);
  await panel.select(c.canonicalId); // 2 回目は索引を読み直さない
  assert.deepEqual(calls, ['mission37d-data/verified-google-place-ids.json']);
});

// ══════════════════════════════════════════════════════════════════════
// 3. 照合キー（Issue 記載の規則は実データで 0 件）
// ══════════════════════════════════════════════════════════════════════
test('[37E] 照合キーは cg_bldg_ + canonicalId。cg_ + canonicalId では 1 件も当たらない', () => {
  const idsDir = path.join(ROOT, 'public/mission37b-3dtiles/osaka-sumiyoshi-9tile/ids');
  let shown = 0, hitCorrect = 0, hitIssueRule = 0;
  for (const f of fs.readdirSync(idsDir).filter((x) => x.startsWith('t_'))) {
    for (const id of JSON.parse(fs.readFileSync(path.join(idsDir, f), 'utf-8'))) {
      shown++;
      if (index.byBuildingId['cg_bldg_' + id]) hitCorrect++;
      if (index.byBuildingId['cg_' + id]) hitIssueRule++;
    }
  }
  assert.equal(shown, 10546, '住吉区 9 タイルの表示建物数');
  assert.equal(hitIssueRule, 0, "Issue 記載の 'cg_' + canonicalId は 0 件のはず");
  assert.ok(hitCorrect > 200, '正しいキーでの一致が少なすぎる: ' + hitCorrect);
  assert.equal(kit.INDEX_KEY_PREFIX, 'cg_bldg_');
});

test('[37E] toPlaceIndexKey は二重接頭を付けない', () => {
  assert.equal(kit.toPlaceIndexKey('bldg_abc'), 'cg_bldg_bldg_abc');
  assert.equal(kit.toPlaceIndexKey('cg_bldg_bldg_abc'), 'cg_bldg_bldg_abc');
  assert.equal(kit.toPlaceIndexKey(''), null);
  assert.equal(kit.toPlaceIndexKey(null), null);
});

test('[37E] 索引の Place ID は全件が ChIJ 形式', () => {
  const vals = Object.values(index.byBuildingId);
  assert.equal(vals.length, 14112);
  assert.equal(vals.filter((v) => !kit.isValidPlaceId(v)).length, 0);
});

// ══════════════════════════════════════════════════════════════════════
// 4. 実データでの照合
// ══════════════════════════════════════════════════════════════════════
test('[37E] 住吉区の VERIFIED 建物を複数、実データで照合できる', async () => {
  const cases = verifiedSumiyoshiCases(5);
  assert.ok(cases.length >= 5, 'テストケースが足りない: ' + cases.length);
  for (const c of cases) {
    const dom = makeStubDom();
    const panel = new kit.PlacePhotoPanel({ indexUrl: 'x.json', fetchImpl: okFetch(index), ...dom });
    const st = await panel.select(c.canonicalId);
    assert.equal(st.status, 'matched', c.canonicalId);
    assert.equal(st.placeId, c.placeId);
    assert.equal(dom.container.dataset.googlePlaceId, c.placeId);
    assert.match(dom.container.textContent, /照合済み/);
    // 「写真を出している」と誤解させる表示をしない
    assert.match(dom.container.textContent, /準備中/);
  }
});

test('[37E] 未照合の建物では Place ID も写真も出さない', async () => {
  const dom = makeStubDom();
  const panel = new kit.PlacePhotoPanel({ indexUrl: 'x.json', fetchImpl: okFetch(index), ...dom });
  const st = await panel.select('bldg_this-id-does-not-exist');
  assert.equal(st.status, 'unmatched');
  assert.equal(st.placeId, null);
  assert.equal(dom.container.dataset.googlePlaceId, undefined);
  assert.match(dom.container.textContent, /対応データなし/);
});

test('[37E] 通信失敗でもエラー表示だけで、前の状態が残らない', async () => {
  const dom = makeStubDom();
  let fail = false;
  const panel = new kit.PlacePhotoPanel({
    indexUrl: 'x.json',
    fetchImpl: () => (fail ? Promise.reject(new Error('offline')) : okFetch(index)()),
    ...dom,
  });
  const c = verifiedSumiyoshiCases(1)[0];
  await panel.select(c.canonicalId);
  assert.equal(dom.container.dataset.googlePlaceId, c.placeId);

  fail = true;
  panel._indexPromise = null;       // 失敗時は次の選択で読み直す設計
  const st = await panel.select('bldg_other');
  assert.equal(st.status, 'index-error');
  assert.equal(dom.container.dataset.googlePlaceId, undefined, '前の建物の Place ID が残っている');
  assert.match(dom.container.textContent, /読み込めませんでした/);
});

test('[37E] HTTP エラー（404 等）も通信失敗として扱う', async () => {
  const dom = makeStubDom();
  const panel = new kit.PlacePhotoPanel({
    indexUrl: 'x.json',
    fetchImpl: () => Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) }),
    ...dom,
  });
  assert.equal((await panel.select('bldg_x')).status, 'index-error');
});

// ══════════════════════════════════════════════════════════════════════
// 5. 非同期競合
// ══════════════════════════════════════════════════════════════════════
test('[37E] 連続選択で、古い照合結果が後から表示を書き換えない', async () => {
  const cases = verifiedSumiyoshiCases(2);
  const dom = makeStubDom();
  let release = null;
  const gate = new Promise((r) => { release = r; });
  let first = true;
  const panel = new kit.PlacePhotoPanel({
    indexUrl: 'x.json',
    // 1 回目の索引取得だけを遅らせる
    fetchImpl: () => (first ? (first = false, gate.then(() => okFetch(index)())) : okFetch(index)()),
    ...dom,
  });
  const p1 = panel.select(cases[0].canonicalId);
  const p2 = panel.select(cases[1].canonicalId);   // 先に選び直す
  release();
  const [s1, s2] = await Promise.all([p1, p2]);
  assert.equal(s1.status, 'superseded', '古い選択が確定してしまっている');
  assert.equal(s2.status, 'matched');
  assert.equal(dom.container.dataset.googlePlaceId, cases[1].placeId, '表示が古い建物のまま');
});

test('[37E] 選択解除で表示と Place ID が消える', async () => {
  const dom = makeStubDom();
  const panel = new kit.PlacePhotoPanel({ indexUrl: 'x.json', fetchImpl: okFetch(index), ...dom });
  const c = verifiedSumiyoshiCases(1)[0];
  await panel.select(c.canonicalId);
  const st = panel.clear();
  assert.equal(st.status, 'idle');
  assert.equal(dom.container.dataset.googlePlaceId, undefined);
});

test('[37E] 解除後に遅れて届いた照合結果を採用しない', async () => {
  const dom = makeStubDom();
  let release = null;
  const gate = new Promise((r) => { release = r; });
  const panel = new kit.PlacePhotoPanel({
    indexUrl: 'x.json', fetchImpl: () => gate.then(() => okFetch(index)()), ...dom,
  });
  const c = verifiedSumiyoshiCases(1)[0];
  const p = panel.select(c.canonicalId);
  panel.clear();
  release();
  assert.equal((await p).status, 'superseded');
  assert.equal(dom.container.dataset.googlePlaceId, undefined);
});

// ══════════════════════════════════════════════════════════════════════
// 6. マークアップが公式仕様どおりか
// ══════════════════════════════════════════════════════════════════════
test('[37E] マークアップのタグ・属性が公式ドキュメントの実値と一致する', () => {
  const m = kit.MARKUP_SPEC;
  assert.equal(m.container, 'gmp-place-details');
  assert.equal(m.compactContainer, 'gmp-place-details-compact');
  assert.equal(m.placeRequest, 'gmp-place-details-place-request');
  assert.equal(m.placeAttribute, 'place');
  assert.equal(m.contentConfig, 'gmp-place-content-config');
  assert.equal(m.loader.channel, 'weekly', 'alpha/beta ではなく weekly');
  assert.equal(m.loader.library, 'places');
  const tags = m.content.map((c) => c.tag);
  assert.ok(tags.includes('gmp-place-media'), '写真要素が無い');
  assert.ok(tags.includes('gmp-place-attribution'), '帰属表示要素が無い（ポリシー必須）');
});

test('[37E] buildMarkupSpec は公式の入れ子と属性を組み立て、課金対象だと明示する', () => {
  const placeId = Object.values(index.byBuildingId)[0];
  const spec = kit.buildMarkupSpec(placeId);
  assert.equal(spec.tag, 'gmp-place-details');
  assert.equal(spec.billableOnInstantiation, true);
  const req = spec.children[0];
  assert.equal(req.tag, 'gmp-place-details-place-request');
  assert.equal(req.attributes.place, placeId);
  const cfg = spec.children[1];
  assert.equal(cfg.tag, 'gmp-place-content-config');
  const media = cfg.children.find((c) => c.tag === 'gmp-place-media');
  assert.ok('lightbox-preferred' in media.attributes, '公式属性 lightbox-preferred が無い');
  // 公式に無い属性を勝手に足していない
  for (const c of cfg.children) {
    for (const a of Object.keys(c.attributes)) {
      assert.ok(['lightbox-preferred', 'preferred-size', 'light-scheme-color', 'dark-scheme-color'].includes(a),
        '公式ドキュメントに無い属性: ' + a);
    }
  }
  assert.throws(() => kit.buildMarkupSpec('not-a-place-id'), /Invalid verified Place ID/);
});

// ══════════════════════════════════════════════════════════════════════
// 7. 既存機能を壊していないこと
// ══════════════════════════════════════════════════════════════════════
test('[37E] 既存の Wikimedia（36L）写真の経路は残っている', () => {
  assert.match(page, /PHOTO_INDEX_URL\s*=\s*'map-data\/osaka-city\/derived\/building-photo-index\.json'/);
  assert.match(page, /lc-photo-slot/);
  assert.match(page, /Mission 36L の写真索引/);
});

test('[37E] 建物選択イベントと canonicalId の経路は不変', () => {
  assert.match(page, /livecity:37d-building-selected/);
  assert.match(page, /picked\.getProperty\('canonicalId'\)/);
});

test('[37E] 共通モジュールは本体より前に読み込まれ、1 回だけ', () => {
  const loader = page.indexOf('mission37e-places-ui-kit.js');
  assert.ok(loader > 0, 'モジュールが読み込まれていない');
  assert.equal(page.split('mission37e-places-ui-kit.js').length - 1, 2,
    '読み込みは 1 箇所（コメント内の言及 1 件を含めて 2 出現）');
  assert.ok(loader < page.indexOf('PlacePhotoPanel'), 'モジュールの読み込みが使用箇所より後ろ');
});

test('[37E] 共通モジュールは地区固有の文字列を持たない（24 区展開できる）', () => {
  // 見るのは実行されるコードだけ。根拠を書いたコメント（測定した区名など）は残してよい。
  const code = moduleSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const w of ['住吉', 'sumiyoshi', 'mission37d-data', 'osaka', '37d']) {
    assert.ok(!code.toLowerCase().includes(w.toLowerCase()),
      '地区固有の文字列がモジュールのコードに入っている: ' + w);
  }
  assert.ok(!/indexUrl\s*=\s*['"]/.test(code), '索引 URL をモジュール内で決め打ちしている');
});

test('[37E] 本番 HTML / 37B / 37C に 37E の記述が無い', () => {
  for (const f of ['public/osaka_3d_buildings.html', 'public/osaka_3d_buildings.fullward-v3.html',
    'public/mission37b-3dtiles-poc.html', 'public/mission37b-livecity-cesium-tiles.html',
    'public/mission37c-livecity-theme.html']) {
    assert.ok(!/mission37e|Mission 37E|PlacePhotoPanel/.test(read(f)), f);
  }
});
