'use strict';
// Mission 219B: 地域グループ(24区→6グループ)の検証 / 起動時に詳細3D要求0の保証 / 世代トークン / HTML 配線。ネットワーク不要。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const pub = (p) => path.join(__dirname, '..', 'public', p);
// package.json は type:module のため、ブラウザ用 UMD は vm で読み込む(既存の 45F テストと同じ方式)
const sb = { self: {} }; vm.runInNewContext(fs.readFileSync(pub('mission219b-ward-groups.js'), 'utf8'), sb);
const L = sb.self.LC219B;
const wardsData = JSON.parse(fs.readFileSync(pub('mission37g-data/osaka-24-wards.json'), 'utf8'));
const def = JSON.parse(fs.readFileSync(pub('mission37g-data/ward-groups.json'), 'utf8'));
const html = fs.readFileSync(pub('mission37g-osaka-24ward-mvp.html'), 'utf8');

test('24区が欠落・重複なく 4〜6 グループに属し、各グループは実ポリゴン上で連結している', () => {
  assert.strictEqual(wardsData.wards.length, 24);
  assert.ok(def.groups.length >= 4 && def.groups.length <= 6, 'groups=' + def.groups.length);
  const v = L.validateGroups(def, wardsData.wards);
  assert.strictEqual(JSON.stringify(v.problems), '[]');
  assert.strictEqual(v.assigned, 24);
  for (const g of def.groups) { assert.ok(g.wards.length >= 3 && g.wards.length <= 6, g.id + ' 区数 ' + g.wards.length); assert.strictEqual(v.connectivity[g.id], true, g.id); }
});
test('欠落・重複・非連結を検出できる(検証器自体のテスト)', () => {
  const dup = JSON.parse(JSON.stringify(def)); dup.groups[1].wards.push(dup.groups[0].wards[0]);
  assert.ok(L.validateGroups(dup, wardsData.wards, { skipAdjacency: true }).problems.some((p) => /重複/.test(p)));
  const miss = JSON.parse(JSON.stringify(def)); miss.groups[0].wards.pop();
  assert.ok(L.validateGroups(miss, wardsData.wards, { skipAdjacency: true }).problems.some((p) => /欠落/.test(p)));
  const bad = JSON.parse(JSON.stringify(def)); const a = bad.groups[0].wards.pop(), b = bad.groups[2].wards.pop(); bad.groups[0].wards.push(b); bad.groups[2].wards.push(a);
  assert.strictEqual(L.validateGroups(bad, wardsData.wards).ok, false, '湾岸と北部を入替えると非連結/不整合');
});
test('起動直後(未選択)は許可区が空: どの区も詳細ロード対象にならない', () => {
  const s = L.createSelector(def);
  for (const w of wardsData.wards) assert.strictEqual(s.allows(w.wardCode), false);
  assert.strictEqual(s.selected, null);
});
test('グループ選択: 所属区のみ許可 / 急速切替で旧トークンは stale / clear で全て不許可', () => {
  const s = L.createSelector(def);
  const t1 = s.select('north'); const t2 = s.select('south'); const t3 = s.select('core');
  assert.ok(s.isStale(t1) && s.isStale(t2) && !s.isStale(t3));
  const core = def.groups.find((g) => g.id === 'core').wards;
  for (const w of wardsData.wards) assert.strictEqual(s.allows(w.wardCode), core.indexOf(w.wardCode) >= 0);
  assert.strictEqual(s.log.switches, 2);
  const t4 = s.clear(); assert.ok(s.isStale(t3) && !s.isStale(t4)); assert.strictEqual(s.allowed.size, 0);
  assert.throws(() => s.select('nope'));
});
test('ネットワーク分類: 詳細GLB/tileset/メタ/LOD0/LOD2/道路を区別し、起動時アサートは詳細0件のみ pass', () => {
  assert.strictEqual(L.classifyUrl('https://x/ext-3dtiles/sumiyoshi/tiles/a.glb').kind, 'detail-glb');
  assert.strictEqual(L.classifyUrl('/ext-3dtiles/sumiyoshi/tileset.json').kind, 'detail-tileset');
  assert.strictEqual(L.classifyUrl('/ext-3dtiles/sumiyoshi/source.json').kind, 'detail-meta');
  assert.strictEqual(L.classifyUrl('/ext-3dtiles/sumiyoshi/layers/roads.json').kind, 'vec');
  assert.strictEqual(L.classifyUrl('/ext-3dtiles/_lod0/27120/tileset.json').kind, 'lod0');
  assert.strictEqual(L.classifyUrl('/lod2-preview/tiles/x.glb').kind, 'lod2-glb');
  const startup = ['/ext-3dtiles/index.json', '/ext-3dtiles/sumiyoshi/source.json', '/ext-3dtiles/sumiyoshi/build-report.json', '/ext-3dtiles/_lod0/27120/tileset.json', '/mission37g-data/ward-groups.json'];
  assert.strictEqual(L.assertNoInitialDetail(startup).pass, true);
  for (const bad of ['/ext-3dtiles/sumiyoshi/tiles/a.glb', '/ext-3dtiles/abeno/tileset.json', '/lod2-preview/tileset.json', '/ext-3dtiles/abeno/layers/roads.json']) assert.strictEqual(L.assertNoInitialDetail(startup.concat(bad)).pass, false, bad);
  assert.strictEqual(L.summarizeNet(['/ext-3dtiles/a/x.glb', '/ext-3dtiles/b/tileset.json']).wardsWithDetail.join(','), 'a,b');
});
test('HTML 配線: 詳細ロードは WG_ON で選択グループに限定され、未指定時の既定経路は不変', () => {
  assert.match(html, /const WG_ON = q\.get\('wardgroups'\) === '1'/);
  assert.match(html, /extCodes\.has\(w\.wardCode\) && \(!WG_ON \|\| WGS\.allows\(w\.wardCode\)\)/, 'allTick の候補区');
  assert.match(html, /vecWards\.has\(w\.wardId\) && \(!WG_ON \|\| WGS\.allows\(w\.wardCode\)\)/, 'vecTick の候補区');
  assert.match(html, /if \(!WG_ON\) window\.__lcLod2Start\(\)/, 'LOD2 オーバーレイはグループ選択まで遅延');
  assert.match(html, /else if \(WG_ON\) \{ await wgStart\(\); \}/);
  assert.match(html, /if \(WG_ON && isMoving\(\)\)/, '操作中は新規 mount を見送る');
  // wgSelect は世代トークンを進め、旧グループの区を破棄する
  const sel = html.slice(html.indexOf('function wgSelect('), html.indexOf('function wgClear('));
  assert.ok(/WGS\.select\(id\)/.test(sel) && /\+\+bldgGen/.test(sel) && /wgPrune\(\)/.test(sel));
  // 既存の 3 つの opt-in フラグを既定ONにしていない
  assert.match(html, /q\.get\('citylod0'\) === '1'/); assert.match(html, /q\.get\('lblidle'\) === '1'/);
  // スクリプト読込順: モジュールが本体より前
  assert.ok(html.indexOf('mission219b-ward-groups.js') < html.indexOf('const WG_ON'));
});
test('vercel.json の既定リダイレクトは変更されていない(旧モードは回帰比較用に残す)', () => {
  const v = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'vercel.json'), 'utf8'));
  assert.strictEqual(v.redirects[0].destination, '/mission37g-osaka-24ward-mvp.html?nobuiltin=1&ext45=1&lod2=1&lod2ov=1');
});
