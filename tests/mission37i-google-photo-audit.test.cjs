'use strict';
// Mission 37I: Google Places API の Legacy 呼び出しが無いこと、アダプタが一元化されていること、課金ロックを静的に固定する。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const LEGACY = /maps\/api\/place|photo_reference|photoreference|html_attributions|place\/details\/json|findplacefromtext|place\/textsearch|place\/nearbysearch|PlacesService/;

function walk(dir, out) {
  for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) { if (!/node_modules|^data$/.test(e.name)) walk(rel, out); }
    else if (/\.(js|mjs|cjs|html)$/.test(e.name)) out.push(rel);
  }
  return out;
}

test('Legacy Places API の呼び出しがコード中に存在しない', () => {
  const files = [...walk('public', []), ...walk('tools', []), ...walk('tests', [])]
    .filter((f) => f !== path.join('tests', 'mission37i-google-photo-audit.test.cjs')
      && f !== path.join('tools', 'mission37i-audit-google-photo-api.cjs'));
  const hits = files.filter((f) => LEGACY.test(read(f)));
  assert.deepEqual(hits, []);
});

test('Cesium ページ(37D/37G)は建物選択イベントのリスナーと PlacePhotoPanel を 1 つずつだけ持つ（二重実行なし）', () => {
  for (const f of ['public/mission37d-sumiyoshi-mvp.html', 'public/mission37g-osaka-24ward-mvp.html']) {
    const s = read(f);
    assert.equal((s.match(/addEventListener\('livecity:37d-building-selected'/g) || []).length, 1, f);
    assert.equal((s.match(/new window\.LiveCityPlacesUiKit37E\.PlacePhotoPanel\(/g) || []).length, 1, f);
    assert.ok(!/loadPlacesLibrary\s*:/.test(s), f + ': ローダーを渡していない');
    assert.ok(!/maps\.googleapis\.com|places\.googleapis\.com/.test(s), f);
  }
});

test('37E モジュールは ENABLED=false、SKU 対応は未検証としてブロッカーに載っている', () => {
  const s = read('public/mission37e-places-ui-kit.js');
  assert.match(s, /const ENABLED = false;/);
  assert.match(s, /skuVerification: 'unverified-possible-mixup'/);
  assert.ok(!/places\.googleapis\.com|maps\.googleapis\.com/.test(s.replace(/\/\*[\s\S]*?\*\//g, '')), 'Google へのエンドポイント参照なし');
});

test('旧 36L 橋渡しの有料ロックはブランチ上に持ち込んでいない（API キー設定も無い）', () => {
  assert.ok(!fs.existsSync(path.join(root, 'public/livecity-building-photo-bridge.js')));
  for (const f of ['public/mission37d-sumiyoshi-mvp.html', 'public/mission37g-osaka-24ward-mvp.html']) {
    assert.ok(!/googlePlacesApiKey|LIVECITY_CONFIG/.test(read(f)), f);
  }
});

test('verified Place ID 索引は ChIJ 形式のみで、Google 写真 URL/photo resource を含まない', () => {
  const p = path.join(root, 'public/mission37d-data/verified-google-place-ids.json');
  if (!fs.existsSync(p)) return; // 未配置なら skip 相当
  const doc = JSON.parse(fs.readFileSync(p, 'utf8'));
  const text = JSON.stringify(doc);
  assert.ok(!/googleusercontent|\/photos\/|photoUri|photo_reference/.test(text));
  for (const id of Object.values(doc.byBuildingId || {})) assert.match(id, /^ChIJ[-_A-Za-z0-9]{8,}$/);
});
