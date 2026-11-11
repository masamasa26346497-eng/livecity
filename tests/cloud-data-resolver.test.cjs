'use strict';
// Mission 202: URL 解決・index/manifest 検証・区の分離・fixture 静的配信 + (あれば)実 Chrome での区選択UI。
// ここでの fixture は synthetic であり、PLATEAU 2025 実源の達成を意味しない。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const R = require('../tools/cloud/data-resolver.cjs');
const ROOT = path.join(__dirname, '..');
const reg = require('../config/wards/registry.json').wards;

test('既定は同一origin、外部は https + ホスト完全一致 allowlist のみ', () => {
  assert.deepStrictEqual(R.resolveBase({}).base, 'ext-3dtiles/');
  assert.strictEqual(R.resolveBase({}).external, false);
  const al = ['tiles.example.com'];
  const ok = R.resolveBase({ dataBaseUrl: 'https://tiles.example.com/osaka2025', allowlist: al });
  assert.ok(ok.ok && ok.external && ok.base === 'https://tiles.example.com/osaka2025/');
  const bad = [
    ['http://tiles.example.com/x', al, 'not-https'],
    ['https://evil.example.com/x', al, 'host-not-allowed'],
    ['https://tiles.example.com.evil.com/x', al, 'host-not-allowed'],
    ['https://u:p@tiles.example.com/x', al, 'credentials-in-url'],
    ['https://tiles.example.com/x?token=1', al, 'query-or-hash-in-url'],
    ['https://tiles.example.com/x', [], 'allowlist-empty'],
    ['https://tiles.example.com/x', ['*.example.com'], 'allowlist-invalid'],
    ['https://tiles.example.com:8443/x', al, 'port-not-allowed'],
    ['https://tiles.example.com/a/%2e%2e/b', al, 'path-traversal'],
    ['javascript:alert(1)', al, 'not-https'],
    ['not a url', al, 'bad-url'],
  ];
  for (const [u, a, code] of bad) {
    const r = R.resolveBase({ dataBaseUrl: u, allowlist: a });
    assert.strictEqual(r.ok, false, u); assert.strictEqual(r.code, code, u); assert.strictEqual(r.fallback, 'none');
  }
});

test('content uri は区ディレクトリ内の相対 .glb/.json のみ', () => {
  assert.ok(R.resolveContentUri('b/', 'kita', 'tiles/0.glb').ok);
  for (const u of ['../chuo/tiles/0.glb', '/etc/passwd', 'https://x/y.glb', '//x/y.glb', 'tiles/0.glb?x=1', 'tiles\\0.glb', 'tiles/%2e%2e/a.glb', 'tiles/0.exe', '', 'a//b.glb']) {
    assert.strictEqual(R.resolveContentUri('b/', 'kita', u).ok, false, u);
  }
  assert.strictEqual(R.wardTilesetUrl('b/', '../x').ok, false);
});

test('index: 24区・served/not-served の整合を厳格に検証し、未配信は描画不可', async () => {
  const { buildIndex } = await import('../tools/cloud/ward-plan.mjs');
  const idx = buildIndex(reg, [{ id: 'kita', buildings: 1 }, { id: 'chuo', buildings: 1 }]);
  assert.ok(R.validateIndex(idx).ok);
  assert.strictEqual(R.describeSelection(idx, 'kita').canRender, true);
  const ns = R.describeSelection(idx, 'nishi');
  assert.strictEqual(ns.state, 'not-served'); assert.strictEqual(ns.canRender, false);
  assert.match(ns.message, /2025データ未配信・配信準備中/);
  assert.strictEqual(R.describeSelection(idx, 'nowhere').canRender, false);
  const broken = JSON.parse(JSON.stringify(idx));
  broken.wards[0].status = 'served'; broken.wards[0].tileset = null;
  assert.strictEqual(R.validateIndex(broken).ok, false);
  assert.strictEqual(R.describeSelection(broken, 'kita').canRender, false); // 不正 index では何も描かない
  const old = JSON.parse(JSON.stringify(idx)); old.vintage = 2024;
  assert.strictEqual(R.validateIndex(old).ok, false);
  const short = JSON.parse(JSON.stringify(idx)); short.wards.pop();
  assert.strictEqual(R.validateIndex(short).ok, false);
  const dup = JSON.parse(JSON.stringify(idx)); dup.wards[1] = dup.wards[0];
  assert.strictEqual(R.validateIndex(dup).ok, false);
});

test('fixture(独立バッチ): 区が混ざらず、vintage 2025・改変検出・同一contentVersion検出', async () => {
  const { makeFixture } = await import('../tools/cloud/make-fixture.mjs');
  const { verifyWardDir, checkWardsDistinct } = await import('../tools/cloud/ward-manifest.mjs');
  const out = fs.mkdtempSync(path.join(ROOT, 'temp-fixture-test-')); // 後で削除
  try {
    const r = await makeFixture({ out, wards: ['kita', 'chuo', 'nishi', 'naniwa'], shard: '1/2' });
    assert.deepStrictEqual(r.served, ['kita', 'nishi']);
    const ms = [];
    for (const w of r.served) {
      const d = path.join(out, 'ext-3dtiles', w);
      const v = await verifyWardDir(d, w); assert.ok(v.ok, v.problems.join());
      const m = JSON.parse(fs.readFileSync(path.join(d, 'manifest.json'), 'utf8'));
      assert.strictEqual(m.vintage, 2025); assert.strictEqual(m.synthetic, true); assert.strictEqual(m.ward, w);
      ms.push(m);
      // 他区の ward を名乗らせると不合格
      assert.strictEqual((await verifyWardDir(d, w === 'kita' ? 'nishi' : 'kita')).ok, false);
    }
    assert.ok(checkWardsDistinct(ms).ok);
    assert.strictEqual(checkWardsDistinct([ms[0], ms[0]]).ok, false);
    // ID 集合は区間で交わらず、LOD1/LOD2 同一IDの重複を検出できる
    const ids = r.served.map((w) => new Set(JSON.parse(fs.readFileSync(path.join(out, 'ext-3dtiles', w, 'ids/0.json'), 'utf8'))));
    assert.strictEqual([...ids[0]].filter((x) => ids[1].has(x)).length, 0);
    // index: 配信は shard の区のみ、synthetic を明示、他は not-served
    const idx = JSON.parse(fs.readFileSync(path.join(out, 'ext-3dtiles/index.json'), 'utf8'));
    assert.ok(R.validateIndex(idx).ok); assert.strictEqual(idx.synthetic, true);
    assert.deepStrictEqual(idx.wards.filter((w) => w.status === 'served').map((w) => w.ward).sort(), ['kita', 'nishi']);
    // 改変(GLB 1バイト書換)を sha256 で検出
    const g = path.join(out, 'ext-3dtiles/kita/tiles/0.glb'); const b = fs.readFileSync(g); b[b.length - 1] ^= 1; fs.writeFileSync(g, b);
    assert.strictEqual((await verifyWardDir(path.join(out, 'ext-3dtiles/kita'), 'kita')).ok, false);
    // vintage 2024 / 出典なし / OSM 混在 の manifest は拒否
    for (const mut of [(x) => { x.vintage = 2024; }, (x) => { x.source.attribution = 'foo'; }, (x) => { x.source.attribution += ' OpenStreetMap'; }]) {
      const c = JSON.parse(JSON.stringify(ms[0])); mut(c); assert.strictEqual(R.validateWardManifest(c, 'kita').ok, false);
    }
    assert.strictEqual(R.validateWardManifest(ms[0], 'kita', { requireNotSynthetic: true }).ok, false);
  } finally { fs.rmSync(out, { recursive: true, force: true }); }
});

test('asset 整合性: size/sha256 不一致を拒否', async () => {
  const bytes = new TextEncoder().encode('hello');
  const sha = await R.sha256Hex(bytes);
  assert.ok((await R.verifyAsset(bytes, { path: 'a.json', bytes: 5, sha256: sha })).ok);
  assert.strictEqual((await R.verifyAsset(bytes, { path: 'a.json', bytes: 4, sha256: sha })).code, 'size-mismatch');
  assert.strictEqual((await R.verifyAsset(bytes, { path: 'a.json', bytes: 5, sha256: '0'.repeat(64) })).code, 'sha-mismatch');
});

test('build は区選択UI/解決レイヤーを配備し、vercel.json は4区ビルド(福島区追加)', () => {
  const b = fs.readFileSync(path.join(ROOT, 'tools/cloud/build-cloud-preview.mjs'), 'utf8');
  assert.ok(b.includes('cloud-data-resolver.js') && b.includes('cloud-ward-picker.js') && b.includes('writeWardManifest') && b.includes('verifyWardDir'));
  assert.ok(b.includes("'tools/lod2/lod2-clip-near.cjs'") && b.includes('lc196-umeda')); // LOD2 近景ボタンは維持
  const v = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
  assert.strictEqual(v.buildCommand, 'node tools/cloud/build-cloud-preview.mjs --wards kita,chuo,nishi,fukushima');
  const pk = fs.readFileSync(path.join(ROOT, 'tools/cloud/ward-picker.js'), 'utf8');
  assert.ok(!/osaka_3d_buildings|map-data\//.test(pk)); // 旧データへ fallback しない
  assert.ok(pk.includes('旧データへは切り替えません'));
});

test('plan: Vercel 制限は confirmed/unconfirmed に分離され、1GB 上限を確定扱いしない', async () => {
  const P = await import('../tools/cloud/ward-plan.mjs');
  const L = P.VERCEL_HOBBY_LIMITS;
  assert.strictEqual(L.confirmed.buildMinutes, 45); assert.strictEqual(L.confirmed.teamDeploymentStorageGB, 10);
  assert.strictEqual(L.confirmed.cliSourceUploadMB, 100); assert.strictEqual(L.confirmed.transferGBPerMonth, 100);
  assert.ok(!('deployTotalMB' in L.confirmed));
  assert.match(L.unconfirmed.buildOutputTotal, /推測/);
  const fit = P.fitAgainstLimits(P.estimateTotals(P.planWards(P.loadInputs(), null, ['kita', 'chuo', 'nishi'])));
  assert.ok(fit.undetermined.length === 3 && !JSON.stringify(fit).includes('sameOriginSingleDeploy'));
  assert.strictEqual(P.R2_FREE_TIER.requiresUserApproval, true);
});

// ---- 実 Chrome(あれば)で区選択UIを検証。無ければ skip(未検証)。fixture は synthetic。 ----
const chrome = ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => fs.existsSync(p));
test('Chrome: 24区が列挙され、未配信は「未配信・配信準備中」、配信済みは manifest 検証OK(synthetic fixture)', { skip: chrome ? false : 'Chrome 無し(未検証)' }, async () => {
  const { makeFixture } = await import('../tools/cloud/make-fixture.mjs');
  const out = fs.mkdtempSync(path.join(ROOT, 'temp-fixture-chrome-'));
  let srv;
  try {
    await makeFixture({ out, wards: ['kita', 'chuo'] });
    fs.copyFileSync(path.join(ROOT, 'tools/cloud/data-resolver.cjs'), path.join(out, 'cloud-data-resolver.js'));
    fs.copyFileSync(path.join(ROOT, 'tools/cloud/ward-picker.js'), path.join(out, 'cloud-ward-picker.js'));
    fs.writeFileSync(path.join(out, 'index.html'), '<!doctype html><meta charset="utf-8"><body><script src="/cloud-data-resolver.js"></script><script src="/cloud-ward-picker.js"></script></body>');
    const mime = { '.json': 'application/json', '.js': 'text/javascript', '.html': 'text/html', '.glb': 'model/gltf-binary' };
    srv = http.createServer((req, res) => {
      const p = path.join(out, decodeURIComponent(req.url.split('?')[0]).replace(/\/$/, '/index.html'));
      if (!p.startsWith(out) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'content-type': mime[path.extname(p)] || 'application/octet-stream' }); res.end(fs.readFileSync(p));
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const port = srv.address().port;
    const page = `http://127.0.0.1:${port}/`;
    // サーバーが同一プロセスなので同期 spawn は使えない(イベントループが止まる)。
    const r = await new Promise((resolve) => {
      const c = spawn(chrome, ['--headless=new', '--no-sandbox', '--disable-gpu', '--virtual-time-budget=8000', '--dump-dom', page], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      c.stdout.on('data', (d) => { stdout += d; }); c.stderr.on('data', (d) => { stderr += d; });
      const t = setTimeout(() => c.kill('SIGKILL'), 50000);
      c.on('close', (status) => { clearTimeout(t); resolve({ status, stdout, stderr }); });
    });
    // --dump-dom は選択操作ができないため、初期描画(24区の列挙と件数表示)をここで検証し、選択ロジックは describeSelection のユニットテストで担保する。
    assert.strictEqual(r.status, 0, r.stderr.slice(-500));
    assert.match(r.stdout, /配信済み 2 \/ 24 区/);
    assert.strictEqual((r.stdout.match(/<option value="[a-z0-9-]+">/g) || []).length, 24);
    assert.strictEqual((r.stdout.match(/\(未配信\)/g) || []).length, 22);
    assert.match(r.stdout, /同時に描画できる区数\(上限あり\)は別です/);
  } finally { if (srv) srv.close(); fs.rmSync(out, { recursive: true, force: true }); }
});
