// tests/mission35z-building-photo-preview.test.js
// [Mission 35Z §15] 建物写真の hover / click。
//   守りたいのは「実行時にネットを引かない」「ライセンス不明を出さない」
//   「推測で別建物の写真を出さない」。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEV = path.join(ROOT, 'public', 'osaka_3d_buildings.ward-ux-v1.html');
const PROD = path.join(ROOT, 'public', 'osaka_3d_buildings.html');
const PROT = path.join(ROOT, 'public', 'osaka_3d_buildings.fullward-v3.html');
const INDEX = path.join(ROOT, 'public', 'map-data', 'osaka-city', 'derived', 'building-photo-index.json');
const CURATED = path.join(ROOT, 'data', 'photos', 'building-photo-curated.json');
const REPORT = path.join(ROOT, 'data', 'reports', 'mission35z-building-photo-preview');
const html = fs.readFileSync(DEV, 'utf-8');
const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };
const layer = () => html.match(/const BuildingPhoto = \(function \(\) \{[\s\S]*?\n\}\)\(\);/)[0];

// ── §1 索引の形 ────────────────────────────────────────────────
test('[35Z §1] photo index のスキーマ', { skip: !fs.existsSync(INDEX) && 'no index' }, () => {
  const idx = rj(INDEX);
  assert.equal(idx.coordinateConvention, 'znorth-neg-v1');
  assert.deepEqual(idx.sources, ['wikidata', 'wikimedia-commons']);
  assert.ok(idx.byCanonicalId && typeof idx.byCanonicalId === 'object');
  assert.ok(idx.byLandmarkId && typeof idx.byLandmarkId === 'object');
  assert.ok(Array.isArray(idx.records) && idx.records.length > 0);
  for (const r of idx.records) {
    for (const k of ['curatedName', 'wikidataId', 'matchConfidence', 'photos']) {
      assert.ok(k in r, 'record に ' + k + ' が無い');
    }
    assert.ok(['high', 'medium', 'unresolved'].includes(r.matchConfidence), r.matchConfidence);
    assert.match(r.wikidataId, /^Q\d+$/);
    for (const p of r.photos) {
      for (const k of ['thumbnailUrl', 'imageUrl', 'source', 'title', 'license', 'sourcePageUrl']) {
        assert.ok(p[k], 'photo に ' + k + ' が無い（' + r.curatedName + '）');
      }
      assert.equal(p.source, 'wikimedia-commons');
    }
  }
});

test('[35Z §10] ライセンス不明の写真は入っていない', { skip: !fs.existsSync(INDEX) && 'no index' }, () => {
  const idx = rj(INDEX);
  for (const r of idx.records) for (const p of r.photos) {
    assert.ok(p.license && !/^unknown$/i.test(p.license), 'ライセンス不明: ' + r.curatedName);
    // 出典を辿れること（§10）
    assert.match(p.sourcePageUrl, /^https:\/\/commons\.wikimedia\.org\//);
  }
  assert.equal(idx.policy.rejectsWithoutLicense, true);
  // 生成側でも落としている
  const b = fs.readFileSync(path.join(ROOT, 'tools', 'photos', 'build-building-photo-index.mjs'), 'utf-8');
  assert.match(b, /if \(!license \|\| \/\^unknown\$\/i\.test\(license\)\) return null;/);
});

test('[35Z §3] 索引に載るのは名前が一致した building だけ（近いだけでは載せない）',
  { skip: !fs.existsSync(INDEX) && 'no index' }, () => {
    const idx = rj(INDEX);
    for (const [cid, r] of Object.entries(idx.byCanonicalId)) {
      assert.equal(r.matchConfidence, 'high', cid + ' が high でない');
      assert.ok(r.canonicalId === cid);
    }
    // 生成側: 近さだけで建物を決める経路が無い
    const b = fs.readFileSync(path.join(ROOT, 'tools', 'photos', 'build-building-photo-index.mjs'), 'utf-8');
    assert.match(b, /「近いから」で建物を決めない/);
    assert.ok(!/out\.confidence = 'medium'/.test(b), '近さだけで medium を付ける経路が残っている');
    // 同じ建物を 2 件が主張したら落とす
    assert.match(b, /同じ canonicalId を 2 件以上が主張したら/);
  });

test('[35Z §3] 同じ建物に 2 つの写真記録がぶら下がっていない',
  { skip: !fs.existsSync(INDEX) && 'no index' }, () => {
    const idx = rj(INDEX);
    const seen = new Set();
    for (const r of idx.records) {
      if (!r.canonicalId) continue;
      assert.ok(!seen.has(r.canonicalId), '同じ建物を複数が主張: ' + r.canonicalId);
      seen.add(r.canonicalId);
    }
  });

test('[35Z §2/§3] Wikidata の対応は手で固定してあり、座標で検証している', () => {
  const c = rj(CURATED);
  assert.ok(c.entries.length >= 20);
  for (const e of c.entries) {
    assert.match(e.wikidataId, /^Q\d+$/, e.name);
    assert.ok(typeof e.expectLat === 'number' && typeof e.expectLon === 'number', e.name + ' に検証用座標が無い');
  }
  const b = fs.readFileSync(path.join(ROOT, 'tools', 'photos', 'build-building-photo-index.mjs'), 'utf-8');
  // curation の座標と食い違えば採用しない
  assert.match(b, /Wikidata の座標が curation と食い違う。採用しない/);
  // 検索結果をそのまま採らない
  assert.ok(!/wbsearchentities/.test(b), '生成時に名前検索して自動確定している');
});

// ── §2 実行時にネットを引かない ────────────────────────────────
test('[35Z §2] hover のたびにネットへ検索しない', () => {
  const b = layer();
  // 読むのは事前生成した索引 1 本だけ
  assert.match(b, /const URL_ = 'map-data\/osaka-city\/derived\/building-photo-index\.json';/);
  assert.equal((b.match(/fetch\(/g) || []).length, 1, 'fetch が 1 か所でない');
  // 検索 API を叩いていない
  assert.ok(!/wikidata\.org\/w\/api|commons\.wikimedia\.org\/w\/api|google|bing/i.test(b),
    '実行時に外部 API を叩いている');
  // §9 索引は一度だけ読み、直近ぶんはメモリに持つ
  assert.match(b, /if \(index \|\| loading\) return loading \|\| Promise\.resolve\(index\);/);
  assert.match(b, /const recent = new Map\(\);/);
  assert.match(b, /const MEM_CACHE = \d+;/);
});

// ── §4 hover UX ───────────────────────────────────────────────
test('[35Z §4] hover は dwell してから出す', () => {
  const b = layer();
  const m = b.match(/const DWELL_MS = (\d+);/);
  assert.ok(m, 'DWELL_MS が無い');
  const ms = Number(m[1]);
  assert.ok(ms >= 300 && ms <= 500, 'dwell が 300〜500ms でない: ' + ms);
  assert.match(b, /dwellTimer = setTimeout\(\(\) => \{/);
  // 同じ建物なら作り直さない / 移ったら捨てる
  assert.match(b, /if \(id === shownFor\) return;/);
  assert.match(b, /if \(pendingFor !== id\) return;/);
  assert.match(b, /if \(dwellTimer\) clearTimeout\(dwellTimer\);/);
});

test('[35Z §12] hover 写真は picking が返した建物 ID と完全一致のときだけ', () => {
  const b = layer();
  // 索引に無ければ出さない（近い建物で代用しない）
  assert.match(b, /const rec = lookup\(id, isLandmark \? 'landmark' : 'building'\);/);
  assert.match(b, /if \(!rec\) \{ stats\.hoverSkippedNoPhoto\+\+; hide\(\); return; \}/);
  // §3 hover は high だけ
  assert.match(b, /if \(!isLandmark && rec\.matchConfidence !== 'high'\)/);
  // 35Y の picking が返した id を使う
  assert.match(html, /BuildingPhoto\.onHover\(h \? h\.d : null, lbl\);/);
});

test('[35Z §11] 写真が無くても壊さない', () => {
  const b = layer();
  assert.match(b, /写真は未登録です/);
  assert.match(b, /この建物の写真は未登録です/);
  // 画像が読めなかったときの代替
  assert.match(b, /img\.addEventListener\('error'/);
  assert.match(b, /写真を読み込めませんでした/);
  // hover が落ちても建物 hover 自体は動く
  assert.match(html, /\} catch \(err\) \{ \/\* 写真が出せなくても hover は壊さない \*\/ \}/);
});

// ── §5/§10 click と attribution ───────────────────────────────
test('[35Z §5/§10] click では出典・ライセンス・著者・出典ページを出す', () => {
  const b = layer();
  assert.match(b, /function sectionHtml\(rec\)/);
  assert.match(b, /rec\.photos\.slice\(0, 3\)/, 'click で 1〜3 枚に絞っていない');
  assert.match(b, /pc-photo-lic/);
  assert.match(b, /pc-photo-by/);
  assert.match(b, /pc-photo-attr/);
  assert.match(b, /esc\(p\.sourcePageUrl\)/);
  assert.match(b, /rel="noopener noreferrer"/);
  // hover は短縮、click は全文
  assert.match(b, /shorten\(p\.author, 46\)/);
  assert.match(html, /BuildingPhoto\.fillCard\(d\);/);
  assert.match(html, /id="pc-photo-section"/);
});

test('[35Z §6] hover カードは幅 240〜320px で、パネルに隠れない位置にある', () => {
  const m = html.match(/#bldg-photo-card\{[^}]*\}/);
  assert.ok(m, 'hover カードの CSS が無い');
  const css = m[0];
  // 右上はレイヤーパネル、右側は建物カードが占める。実機で右側に置くと隠れて見えなかったので左下。
  assert.match(css, /left:20px/);
  assert.match(css, /bottom:20px/);
  const w = Number((css.match(/width:(\d+)px/) || [])[1]);
  assert.ok(w >= 240 && w <= 320, '幅が 240〜320px でない: ' + w);
  assert.match(css, /display:none/);
  assert.match(css, /pointer-events:none/, 'カードがクリックを奪う');
});

// ── §0 production / protected ─────────────────────────────────
test('[35Z §0] production / protected は変更していない', () => {
  for (const [n, p] of [['production', PROD], ['protected', PROT]]) {
    const s = fs.readFileSync(p, 'utf-8');
    assert.ok(!/BuildingPhoto/.test(s), n + ' に 35Z が入っている');
    assert.ok(!/bldg-photo-card/.test(s), n + ' に 35Z の DOM が入っている');
  }
});

test('[35Z] 既存レイヤーを壊していない', () => {
  for (const sym of ['const RoadDetail = (function () {', 'const UrbanDetail = (function () {',
    'function pickBuilding(rayObj) {', 'const BuildingNameStore = (function ()']) {
    assert.equal(html.split(sym).length - 1, 1, sym + ' が 1 つでない');
  }
});

// ── §13 実機 QA ───────────────────────────────────────────────
test('[35Z §13] 実機: dwell して出る / 誤写真を出さない / JS 例外 0',
  { skip: !fs.existsSync(path.join(REPORT, 'photo-qa.json')) && 'no report' }, () => {
    const q = rj(path.join(REPORT, 'photo-qa.json')).summary;
    assert.equal(q.jsErrors, 0, 'JS 例外がある');
    // 標本が 0 だと every() が true になってしまうので、必ず件数を見る
    assert.ok(q.spotsWithPhotoTarget > 0, '写真つき建物を 1 つも掴めていない（判定が空振り）');
    assert.equal(q.noShowBeforeDwell, true, 'dwell 前に出ている');
    assert.equal(q.showsAfterDwell, true, 'dwell 後に出ていない');
    assert.equal(q.imagesActuallyLoaded, true, '画像が実際に読めていない');
    assert.equal(q.licenseShown, true, 'ライセンス表記が出ていない');
    assert.equal(q.noWrongPhotoOnOthers, true, '別の建物で写真が出たままになっている');
    assert.equal(q.clickSectionShown, true, 'click の写真欄が出ていない');
  });
