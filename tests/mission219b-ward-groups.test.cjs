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

// 221B: sseMove ブロックを HTML から切り出し、偽 tileset/camera で「Preview(wardgroups)でも発火 → 400ms 後に元へ復元」を実行して確認する
function runSse({ search, host, EXT45, WG_ON, tilesets }) {
  const a = html.indexOf('const SSE_MOVE_RAW'), b = html.indexOf("if (EXT45 && q.get('perf') === '1')");
  const code = html.slice(a, b);
  const timers = []; let now = 0;
  const L2 = () => { const h = []; return { addEventListener: (f) => h.push(f), fire: () => h.forEach((f) => f()) }; };
  const ev = { moveStart: L2(), changed: L2(), moveEnd: L2() };
  const win = {};
  const ctx = { q: new URLSearchParams(search), EXT45, WG_ON, stats: {}, scene: { requestRender() {} }, viewer: { camera: ev }, allTilesetsNow: () => tilesets.filter((t) => !t.isDestroyed()), performance: { now: () => now }, window: win, Math, Number, Map,
    setTimeout: (f, ms) => { const id = timers.length + 1; timers.push({ f, at: now + ms, id }); return id; }, clearTimeout: (id) => { const t = timers.find((x) => x.id === id); if (t) t.f = null; } };
  vm.runInNewContext(code, ctx);
  const advance = (ms) => { now += ms; for (const t of timers) if (t.f && t.at <= now) { const f = t.f; t.f = null; f(); } };
  return { ev, win, advance, st: ctx.stats };
}
const mkTs = (v) => ({ maximumScreenSpaceError: v, isDestroyed: () => false });
test('221B: Preview(非localhost)でも ?wardgroups=1&sseMove=48 で操作中に SSE が上がり 400ms 後に元値へ戻る', () => {
  const t1 = mkTs(16), t2 = mkTs(24);
  const r = runSse({ search: '?sseMove=48', EXT45: false, WG_ON: true, tilesets: [t1, t2] });
  r.ev.moveStart.fire();
  assert.strictEqual(t1.maximumScreenSpaceError, 48); assert.strictEqual(t2.maximumScreenSpaceError, 48);
  const t3 = mkTs(16); // 操作中に mount された tileset も次のイベントで拾う
  r.ev.changed.fire();
  r.advance(300); r.ev.changed.fire(); r.advance(300);
  assert.strictEqual(t1.maximumScreenSpaceError, 48, '連続操作中は戻さない');
  r.advance(200);
  assert.strictEqual(t1.maximumScreenSpaceError, 16); assert.strictEqual(t2.maximumScreenSpaceError, 24);
  assert.strictEqual(r.st.sseMoveState.raises, 1); assert.strictEqual(r.st.sseMoveState.restores, 1); assert.strictEqual(r.st.sseMoveState.raised, false);
  void t3;
});
test('221B: wardgroups も ext45 も無い場合・不正値は SSE を変えない / 範囲外は 8..128 に丸める', () => {
  for (const [search, WG] of [['?sseMove=48', false], ['?sseMove=abc', true], ['?sseMove=-5', true], ['', true]]) {
    const t = mkTs(16); const r = runSse({ search, EXT45: false, WG_ON: WG, tilesets: [t] }); r.ev.moveStart.fire();
    assert.strictEqual(t.maximumScreenSpaceError, 16, search + ' WG=' + WG);
  }
  const t = mkTs(16); const r = runSse({ search: '?sseMove=99999', EXT45: false, WG_ON: true, tilesets: [t] }); r.ev.moveStart.fire();
  assert.strictEqual(t.maximumScreenSpaceError, 128);
});
test('221B: 引き上げ中に他所で SSE を変更された tileset は復元で上書きしない', () => {
  const t = mkTs(16); const r = runSse({ search: '?sseMove=48', EXT45: false, WG_ON: true, tilesets: [t] });
  r.ev.moveStart.fire(); t.maximumScreenSpaceError = 20; r.advance(500);
  assert.strictEqual(t.maximumScreenSpaceError, 20);
});
test('221B: res=speed の動的解像度は wardgroups+明示 res のときだけ許可 / cachemb は予算で上書きされない', () => {
  assert.ok(/fixed: !\(EXT45 \|\| \(WG_ON && \/\^\(speed\|auto\|balanced\)\$\/\.test\(q\.get\('res'\)/.test(html));
  assert.ok(/!\(\+q\.get\('cachemb'\) > 0\)\) t\.cacheBytes/.test(html));
  assert.ok(/clampOpt\('foveatedConeSize', 0, 1\)/.test(html));
});

test('221C: メタは全区完了を待たず区ごとに mount 再計画 / 未完了を「完了」と言わない / 操作中は道路構築を後送', () => {
  const html = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'public', 'mission37g-osaka-24ward-mvp.html'), 'utf8');
  assert.match(html, /loadGroupMeta\(\)\.catch\(/, 'ensureExtraMeta は loadGroupMeta を await しない');
  assert.match(html, /if \(allMode\) scheduleAll\(\);/, '区のメタ到着ごとに再計画');
  assert.match(html, /wgMeta\.queued > 0 \|\| metaNet\.inflight > 0/, 'メタ未完了の判定');
  assert.match(html, /wgMetaPending\(\)\) \{/, 'wgEvaluate はメタ取得中は loading');
  assert.match(html, /if \(WG_ON && isMoving\(\)\) stats\.wg\.vecDeferred[^\n]*\n\s*else vecTick\(/, '操作中は vecTick を後送');
  assert.match(html, /WGS\.isStale\(tk\) && !WGS\.allows\(/, '対象外になった区のメタは取得しない');
});
