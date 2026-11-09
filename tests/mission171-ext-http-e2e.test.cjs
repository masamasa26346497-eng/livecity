'use strict';
// Mission 171: 24区 LOD1 が「接続」と出るのに住吉区以外が空白、の切り分けと再発防止。
// 合成 fixture(実データではない・ユーザーPCのデータは未検証)を 45D/45I の実コードに忠実な形で作り、
// 実サーバ(lod2-preview-serve.cjs)を子プロセスで起動して、37G が行うのと同じ HTTP 取得手順を端から端まで再現する:
//   index.json → 各区 source.json / build-report.json(登録条件) → tileset.json → 全 content URI の GLB → layers/*.json
// Cesium の描画(tileLoad/tileVisible)はこのテストでは検証していない(ブラウザ検証は別。この runner では Chromium 不可)。
const test = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const F = require('./helpers/lc-45d-fixture.cjs');
const A = require('../tools/lod2/lod2-ext-attach.cjs');

const ROOT = path.resolve(__dirname, '..');
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function startServer(env, extraArgs = []) {
  const port = await freePort();
  const p = spawn(process.execPath, [path.join(ROOT, 'tools/lod2/lod2-preview-serve.cjs'), '--port', String(port), '--lod2-dir', 'temp/lc171-none', ...extraArgs],
    { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { out += d; });
  const base = 'http://127.0.0.1:' + port;
  for (let i = 0; i < 50; i++) { try { const r = await fetch(base + '/__lod2/diag.json'); if (r.ok) return { p, base, log: () => out }; } catch (e) { /* retry */ } await sleep(100); }
  p.kill(); throw new Error('server did not start: ' + out);
}
const get = async (base, u) => { const r = await fetch(base + u); const buf = Buffer.from(await r.arrayBuffer()); return { status: r.status, buf, json: () => JSON.parse(buf.toString('utf8')) }; };

const WARDS = ['higashiyodogawa', 'asahi', 'sumiyoshi', 'chuo', 'naniwa', 'kita'];
const SPECIAL = {
  higashiyodogawa: { failedNewerAttempt: true },   // a1 は健全、a2 は変換検証に失敗した残骸(棟数 999)
  chuo: { missingGlb: true },                      // tileset が参照する GLB の 1 枚が無い
  naniwa: { noSource: true },                      // source.json が無い(37G が区として登録できない)
  kita: { uriPrefix: 'tiles/sub/' },               // 配信許可リスト外のパスを参照(404 になる)
};

test('attach: 37G が読めない区は「接続」に数えず、理由つきで brokenWards に出す', () => {
  const root = F.mk45d(WARDS, SPECIAL);
  const r = A.inspect(root);
  assert.deepStrictEqual(r.wards.map((w) => w.ward).sort(), ['asahi', 'higashiyodogawa', 'sumiyoshi']);
  const broken = Object.fromEntries(r.brokenWards.map((b) => [b.ward, b.reasons.map((x) => x.reason).join(' | ')]));
  assert.deepStrictEqual(Object.keys(broken).sort(), ['chuo', 'kita', 'naniwa']);
  assert.match(broken.chuo, /ディスク上に無い/);
  assert.match(broken.naniwa, /source\.json が無い/);
  assert.match(broken.kita, /配信許可リスト外/);
  // 失敗した新しい attempt(a2, 999 棟)ではなく健全な a1(100 棟)を採用する。棟数は build-report の totals.buildings から取る
  assert.strictEqual(r.wards.find((w) => w.ward === 'higashiyodogawa').buildings, 100);
  assert.ok(!/接続成功/.test(r.reasons.join('')));
});

test('layers: マーカー検証済みの区の既知 JSON だけ配信し、それ以外は拒否する', () => {
  const lroot = F.mkLayers(['asahi', 'higashiyodogawa']);
  const L = A.inspectLayers(lroot);
  assert.ok(L.ok); assert.deepStrictEqual(L.wards.map((w) => w.ward).sort(), ['asahi', 'higashiyodogawa']);
  assert.ok(A.resolveLayers(L, 'asahi/layers/roads.json'));
  assert.strictEqual(A.resolveLayers(L, 'asahi/layers/secret.json'), null);
  assert.strictEqual(A.resolveLayers(L, 'chuo/layers/roads.json'), null);
  assert.strictEqual(A.resolveLayers(L, 'asahi/layers/../../x/roads.json'), null);
  const noMarker = require('node:fs').mkdtempSync(path.join(require('node:os').tmpdir(), 'lc171-nm-'));
  assert.strictEqual(A.inspectLayers(noMarker).ok, false);
  assert.match(A.inspectLayers(noMarker).reasons.join(''), /マーカー|\.livecity-45i-layers\.json/);
  assert.match(JSON.stringify(JSON.parse(A.indexJsonFor(A.inspect(F.mk45d(['asahi'])), L)).layersWards), /asahi/);
});

test('HTTP E2E: %LOCALAPPDATA% の既定位置から自動検出 → 37G と同じ取得手順で全 GLB が 200、壊れた区は NG として診断に出る', async () => {
  const la = F.mkLocalAppData({ wards: WARDS, special: SPECIAL, layerWards: ['higashiyodogawa', 'asahi'] });
  const { p, base } = await startServer({ LOCALAPPDATA: la });
  try {
    const dg = (await get(base, '/__lod2/diag.json')).json();
    assert.strictEqual(dg.extAttach.chosen.wards, 3);
    assert.deepStrictEqual(dg.extAttach.chosen.brokenWards.map((b) => b.ward).sort(), ['chuo', 'kita', 'naniwa']);
    assert.strictEqual(dg.layers.attached, true); assert.strictEqual(dg.layers.wards.length, 2);
    assert.ok(!JSON.stringify(dg).includes(la), 'diag.json に絶対パスを出さない');

    // --- 37G loadExt45Defs ---
    const idx = (await get(base, '/ext-3dtiles/index.json')).json();
    assert.deepStrictEqual(idx.wards.map((w) => w.ward).sort(), ['asahi', 'higashiyodogawa', 'sumiyoshi']);
    assert.ok(idx.wards.every((w) => /^[a-z0-9-]+$/.test(w.ward) && /^271\d\d$/.test(w.wardCode)), 'ward/wardCode は 37G の検証(正規表現)を満たす');
    assert.deepStrictEqual(idx.layersWards.map((x) => x.ward).sort(), ['asahi', 'higashiyodogawa']);
    assert.deepStrictEqual(idx.lod0Wards, []);

    // --- 37G loadExtraMeta + loadCoverage + mountTileset(tileset.json と全 GLB) ---
    const fetched = {};
    for (const w of idx.wards) {
      const b = '/ext-3dtiles/' + w.ward + '/';
      const src = await get(base, b + 'source.json'), rep = await get(base, b + 'build-report.json');
      assert.strictEqual(src.status, 200, w.ward + ' source.json'); assert.strictEqual(rep.status, 200, w.ward + ' build-report.json');
      assert.strictEqual(src.json().wardCode, w.wardCode);                 // m.source.wardCode === wardCode
      assert.ok(rep.json().totals.buildings > 0 && rep.json().selectedTiles > 0);   // loadCoverage: `if (!n || !tiles) continue`
      const ts = await get(base, b + 'tileset.json'); assert.strictEqual(ts.status, 200);
      const uris = []; (function walk(n) { if (n.content) uris.push(n.content.uri); (n.children || []).forEach(walk); })(ts.json().root);
      assert.ok(uris.length >= 1);
      for (const u of uris) {
        const g = await get(base, b + u);
        assert.strictEqual(g.status, 200, w.ward + ' ' + u);
        assert.strictEqual(g.buf.subarray(0, 4).toString(), 'glTF');
      }
      fetched[w.ward] = uris.length;
    }
    assert.deepStrictEqual(Object.keys(fetched).sort(), ['asahi', 'higashiyodogawa', 'sumiyoshi']);
    // 失敗した a2(999棟)ではなく a1 が配信されている
    assert.strictEqual((await get(base, '/ext-3dtiles/higashiyodogawa/build-report.json')).json().totals.buildings, 100);

    // --- layers(道路・河川・公園) ---
    assert.strictEqual((await get(base, '/ext-3dtiles/asahi/layers/roads.json')).status, 200);
    assert.strictEqual((await get(base, '/ext-3dtiles/asahi/layers/secret.json')).status, 404);
    assert.strictEqual((await get(base, '/ext-3dtiles/sumiyoshi/layers/roads.json')).status, 404);

    // --- 壊れた区・許可外 → 404、診断カウンタに現れる ---
    assert.strictEqual((await get(base, '/ext-3dtiles/chuo/tileset.json')).status, 404);
    assert.strictEqual((await get(base, '/ext-3dtiles/asahi/secret.txt')).status, 404);
    assert.strictEqual((await get(base, '/ext-3dtiles/asahi/tiles/..%2f..%2fsecret.txt')).status, 404);
    await sleep(100);
    const dg2 = (await get(base, '/__lod2/diag.json')).json();
    const sv = dg2.extServed.byWard;
    assert.ok(sv.asahi.glb[0] >= 2 && sv.asahi.glb[1] === 0, 'asahi の GLB は 200 のみ');
    assert.ok(sv.chuo.tileset[1] >= 1, '壊れた区の 404 が区ごとに数えられる');
    assert.ok(dg2.extServed.recentFailures.some((f) => f.ward === 'chuo' && f.status === 404));
  } finally { p.kill(); }
});

test('LOD1/レイヤー未検出: 0 件と推測せず理由を診断に出す(ユーザーPCにデータが無い場合の表示)', async () => {
  const empty = require('node:fs').mkdtempSync(path.join(require('node:os').tmpdir(), 'lc171-empty-'));
  const { p, base } = await startServer({ LOCALAPPDATA: empty });
  try {
    const dg = (await get(base, '/__lod2/diag.json')).json();
    assert.strictEqual(dg.extAttach.attached, false); assert.strictEqual(dg.layers.attached, false);
    assert.strictEqual(dg.data.lod1Wards.ok, false); assert.match(dg.data.lod1Wards.msg, /未接続/);
    assert.match(dg.data.roads.msg, /未接続/);
    assert.strictEqual((await get(base, '/ext-3dtiles/index.json')).status, 404);
  } finally { p.kill(); }
});

test('overlay.js: 区ごとの tileLoad/tileVisible/tileFailed と HTTP 結果の表示、全域3D の自動有効化を持つ', () => {
  const src = require('node:fs').readFileSync(path.join(ROOT, 'tools/lod2/lod2-overlay.js'), 'utf8');
  assert.doesNotThrow(() => new (require('node:vm').Script)(src));
  for (const k of ['区ごとの LOD1 状態', 'tileFailed', 'tileVisible', '全域3D', 'lod2auto3d', '出力はあるが 37G が読めない', '--layers-root']) assert.ok(src.includes(k), k);
});
