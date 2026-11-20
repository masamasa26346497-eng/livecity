'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { execFileSync, spawnSync } = require('child_process');
const C = require('../tools/mission43f-pc-convert.cjs');
const V = require('../tools/mission43g-verify-local.cjs');
const P = require('../tools/mission43g-local-preview.cjs');
const L = require('../tools/mission40b-legacy-tiles-batch.cjs');
const ROOT = path.join(__dirname, '..');
const wards = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/wards/registry.json'), 'utf8')).wards;
const REPO_BLD = path.join(ROOT, 'public/map-data/osaka-city/buildings');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'm43g-'));
const wj = (p, o) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(o)); };
const rj = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
test.afterEach(() => L.setSource(REPO_BLD));

function fixture() {
  const src = tmp(); const ds = [];
  wards.forEach((w, wi) => {
    const dir = path.join(src, 'osaka-' + w.id); const tiles = [];
    for (let t = 0; t < 2; t++) {
      const bs = [0, 1, 2].map((k) => ({ id: 'bldg_' + String(wi).padStart(2, '0') + t + k + '-fixture', fp: [[t * 600, 0], [t * 600 + 10, 0], [t * 600 + 10, 10], [t * 600, 10]], h: 10, repX: 5 + t * 600, repZ: 5 }));
      wj(path.join(dir, 'tile_' + t + '_0.json'), { buildings: bs });
      tiles.push({ tx: t, tz: 0, count: 3, file: 'tile_' + t + '_0.json' });
    }
    wj(path.join(dir, 'manifest.json'), { wardCode: w.code, coordinateConvention: 'znorth-neg-v1', tiles });
    ds.push({ id: 'osaka-' + w.id, wardId: w.id, buildings: 6, tiles: 2 });
  });
  wj(path.join(src, 'manifest.json'), { datasets: ds });
  return src;
}
const PC = wards.map((w) => w.id).filter((id) => id !== 'sumiyoshi');
const W = PC[0];
// converted root with `n` wards, converted by the real 43F code
function converted(n) {
  const src = fixture(); const out = path.join(tmp(), 'out');
  const r = C.runConvert({ src, outRoot: out, execute: true, next: n || 1 });
  assert.strictEqual(r.ok, true, JSON.stringify(r.results));
  return { src, out };
}
function treeFingerprint(dir) {
  const h = crypto.createHash('sha256');
  for (const e of fs.readdirSync(dir, { recursive: true, withFileTypes: true }).sort((a, b) => (a.parentPath + a.name).localeCompare(b.parentPath + b.name))) {
    const p = path.join(e.parentPath || e.path, e.name); h.update(path.relative(dir, p));
    if (e.isFile()) { const s = fs.statSync(p); h.update(String(s.size) + ':' + Math.round(s.mtimeMs)); h.update(fs.readFileSync(p)); }
  }
  return h.digest('hex');
}
const wardDir = (out, id) => path.join(out, id + '-a1');
const only = (r, id) => r.wards.find((w) => w.ward === id);

test('verifies a real 43F ward (structure only, then against the audited source); read-only; anonymous', () => {
  const { src, out } = converted(1);
  const fpOut = treeFingerprint(out), fpSrc = treeFingerprint(src);
  const a = V.verifyRoot({ outRoot: out, wards: W });
  assert.strictEqual(a.ok, true, JSON.stringify(a)); assert.strictEqual(only(a, W).state, 'verified'); assert.strictEqual(only(a, W).buildings, 6);
  const b = V.verifyRoot({ outRoot: out, src, wards: W });
  assert.strictEqual(b.ok, true, JSON.stringify(b)); assert.strictEqual(b.sourceChecked, true); assert.strictEqual(b.auditReadyWards, 24);
  assert.strictEqual(b.complete, false); // only 1 of 23
  assert.strictEqual(treeFingerprint(out), fpOut); assert.strictEqual(treeFingerprint(src), fpSrc); // wrote nothing
  const s = JSON.stringify(a) + JSON.stringify(b);
  assert.ok(!/\/tmp\/|bldg_|OneDrive|[A-Za-z]:\\/.test(s));
  assert.strictEqual(b.uploaded, 0); assert.strictEqual(b.approvedForPublication, false); assert.strictEqual(b.gates.licenceApproved, false);
});

test('complete only when all 23 PC-only wards verify (default scope is all 23)', () => {
  const { out } = converted(1);
  const r = V.verifyRoot({ outRoot: out });
  assert.strictEqual(r.complete, false); assert.strictEqual(r.ok, false); assert.strictEqual(r.verifiedWards, 1);
  assert.strictEqual(r.absentWards, 22); assert.strictEqual(r.pcOnlyWardsExpected, 23);
});

test('status says ok but a GLB is gone => not-ready (status is never trusted alone)', () => {
  const { out } = converted(1);
  const glb = fs.readdirSync(path.join(wardDir(out, W), 'tiles')).find((f) => f.endsWith('.glb'));
  fs.unlinkSync(path.join(wardDir(out, W), 'tiles', glb));
  assert.strictEqual(rj(path.join(out, 'status.json')).wards[W].state, 'ok');
  const r = V.verifyRoot({ outRoot: out, wards: W });
  assert.strictEqual(only(r, W).state, 'not-ready'); assert.strictEqual(r.ok, false);
});

test('missing attrs / truncated GLB / tampered ids / duplicate ids / wrong wardCode => not-ready', () => {
  const cases = {
    'attrs-missing': (d) => fs.rmSync(path.join(d, 'attrs'), { recursive: true }),
    'glb-truncated': (d) => { const g = path.join(d, 'tiles', fs.readdirSync(path.join(d, 'tiles')).find((f) => f.endsWith('.glb'))); fs.writeFileSync(g, fs.readFileSync(g).subarray(0, 40)); },
    'ids-tampered': (d) => { const f = path.join(d, 'ids', 't_0_0.json'); const a = rj(f); a[0] = 'bldg_forged-id'; fs.writeFileSync(f, JSON.stringify(a)); },
    'ids-duplicate': (d) => { const f = path.join(d, 'ids', 't_0_0.json'); const a = rj(f); a[1] = a[0]; fs.writeFileSync(f, JSON.stringify(a)); },
    'wardcode': (d) => { const f = path.join(d, 'source.json'); const s = rj(f); s.wardCode = '27999'; fs.writeFileSync(f, JSON.stringify(s)); },
    'report-forged': (d) => { const f = path.join(d, 'verify-report.json'); const s = rj(f); s.approvedForPublication = true; fs.writeFileSync(f, JSON.stringify(s)); },
    'report-missing': (d) => fs.unlinkSync(path.join(d, 'verify-report.json')),
  };
  for (const [name, mutate] of Object.entries(cases)) {
    const { out } = converted(1);
    mutate(wardDir(out, W));
    const r = V.verifyRoot({ outRoot: out, wards: W });
    assert.strictEqual(only(r, W).state, 'not-ready', name); assert.strictEqual(r.ok, false, name);
    assert.ok(!/bldg_|forged/.test(JSON.stringify(r)), name + ' leaked an id');
  }
});

test('with --src: output ids that differ from the source, or a count differing from the audit => not-ready', () => {
  const { src, out } = converted(1);
  // swap one id consistently in ids + attrs so the output is self-consistent but differs from the source
  const d = wardDir(out, W);
  const f = path.join(d, 'ids', 't_0_0.json'); const a = rj(f); const old = a[0]; a[0] = 'bldg_swapped'; fs.writeFileSync(f, JSON.stringify(a));
  const af = path.join(d, 'attrs', 't_0_0.json'); const t = rj(af); t.byId.bldg_swapped = t.byId[old]; delete t.byId[old]; fs.writeFileSync(af, JSON.stringify(t));
  // a self-consistent swap is invisible to the structural check alone; only the source comparison can catch it
  assert.strictEqual(only(V.verifyRoot({ outRoot: out, wards: W }), W).state, 'verified');
  const r = V.verifyRoot({ outRoot: out, src, wards: W });
  assert.strictEqual(only(r, W).state, 'not-ready');
});

test('forged / stale / hostile status', () => {
  const { out } = converted(1);
  const sp = path.join(out, 'status.json'); const good = rj(sp);
  // forged ok for a ward that was never converted
  const forged = JSON.parse(JSON.stringify(good)); forged.wards[PC[1]] = { state: 'ok', attempt: 1, buildings: 6 };
  fs.writeFileSync(sp, JSON.stringify(forged));
  let r = V.verifyRoot({ outRoot: out, wards: PC[1] });
  assert.strictEqual(only(r, PC[1]).state, 'not-ready'); assert.ok(only(r, PC[1]).reasons.includes('status-claims-ok-but-dir-missing'));
  // wrong attempt number
  const wrong = JSON.parse(JSON.stringify(good)); wrong.wards[W].attempt = 3; fs.writeFileSync(sp, JSON.stringify(wrong));
  assert.strictEqual(only(V.verifyRoot({ outRoot: out, wards: W }), W).state, 'not-ready');
  // count lie
  const lie = JSON.parse(JSON.stringify(good)); lie.wards[W].buildings = 999; fs.writeFileSync(sp, JSON.stringify(lie));
  assert.ok(only(V.verifyRoot({ outRoot: out, wards: W }), W).reasons.includes('status-count-differs-from-disk'));
  // old schema / broken json / missing
  fs.writeFileSync(sp, JSON.stringify({ schema: 'old', wards: good.wards }));
  assert.ok(V.verifyRoot({ outRoot: out, wards: W }).rootProblems.includes('status-wrong-schema'));
  fs.writeFileSync(sp, '{broken');
  assert.ok(V.verifyRoot({ outRoot: out, wards: W }).rootProblems.includes('status-broken-json'));
  fs.unlinkSync(sp);
  const r2 = V.verifyRoot({ outRoot: out, wards: W });
  assert.ok(r2.rootProblems.includes('status-missing')); assert.strictEqual(r2.ok, false);
  // failed ward is not ready
  const failed = JSON.parse(JSON.stringify(good)); failed.wards[W].state = 'failed'; fs.writeFileSync(sp, JSON.stringify(failed));
  assert.strictEqual(only(V.verifyRoot({ outRoot: out, wards: W }), W).state, 'not-ready');
});

test('root fail-closed: missing, file, inside repo/public, no marker, foreign marker, unrelated entry, broken marker', () => {
  const { out } = converted(1);
  const code = (fn) => { try { fn(); } catch (e) { return e.code; } return null; };
  assert.strictEqual(code(() => V.verifyRoot({})), 2);
  assert.strictEqual(code(() => V.verifyRoot({ outRoot: path.join(tmp(), 'nope') })), 4);
  const f = path.join(tmp(), 'file'); fs.writeFileSync(f, 'x');
  assert.strictEqual(code(() => V.verifyRoot({ outRoot: f })), 4);
  assert.strictEqual(code(() => V.verifyRoot({ outRoot: path.join(ROOT, 'public') })), 4);
  assert.strictEqual(code(() => V.verifyRoot({ outRoot: ROOT })), 4);
  const bare = path.join(tmp(), 'bare'); fs.mkdirSync(bare);
  assert.strictEqual(code(() => V.verifyRoot({ outRoot: bare })), 4);
  const foreign = path.join(tmp(), 'f'); fs.mkdirSync(foreign); fs.writeFileSync(path.join(foreign, C.MARKER), '{"schema":"other"}');
  assert.strictEqual(code(() => V.verifyRoot({ outRoot: foreign })), 4);
  const broken = path.join(tmp(), 'b'); fs.mkdirSync(broken); fs.writeFileSync(path.join(broken, C.MARKER), '{nope');
  assert.strictEqual(code(() => V.verifyRoot({ outRoot: broken })), 4);
  fs.writeFileSync(path.join(out, 'notes.txt'), 'x');
  assert.strictEqual(code(() => V.verifyRoot({ outRoot: out })), 4);
});

test('links are refused: root, root entry, link inside a ward dir', { skip: process.platform === 'win32' }, () => {
  const code = (fn) => { try { fn(); } catch (e) { return e.code; } return null; };
  const { out } = converted(1);
  const lnk = path.join(tmp(), 'lnk'); fs.symlinkSync(out, lnk);
  assert.strictEqual(code(() => V.verifyRoot({ outRoot: lnk })), 4);
  fs.symlinkSync(os.tmpdir(), path.join(out, PC[1] + '-a1'));
  assert.strictEqual(code(() => V.verifyRoot({ outRoot: out })), 4);
  fs.unlinkSync(path.join(out, PC[1] + '-a1'));
  fs.symlinkSync(path.join(wardDir(out, W), 'source.json'), path.join(wardDir(out, W), 'tiles', 'planted.glb'));
  const r = V.verifyRoot({ outRoot: out, wards: W });
  assert.strictEqual(only(r, W).state, 'not-ready'); assert.deepStrictEqual(only(r, W).reasons, ['link-in-output']);
});

test('43F audit: a link planted in a resumed output root is refused (no write through status.json.tmp)', { skip: process.platform === 'win32' }, () => {
  const { src, out } = converted(1);
  const victim = path.join(tmp(), 'victim.txt'); fs.writeFileSync(victim, 'keep');
  fs.symlinkSync(victim, path.join(out, 'status.json.tmp'));
  assert.throws(() => C.runConvert({ src, outRoot: out, execute: true, next: 2 }), (e) => e.code === 4);
  assert.strictEqual(fs.readFileSync(victim, 'utf8'), 'keep');
});

test('43F audit: attempts never reuse or clear an existing attempt dir (force:true only ever sees a fresh dir)', () => {
  const src = fixture(); const out = path.join(tmp(), 'out');
  const seenOut = [];
  const spy = (id, o) => { seenOut.push(fs.readdirSync(o.out).length); return L.convertWard(id, o); };
  C.runConvert({ src, outRoot: out, execute: true, convert: spy });
  assert.deepStrictEqual(seenOut, [0]); // the dir handed to the converter (which rm -rf's it) was brand new and empty
  fs.writeFileSync(path.join(wardDir(out, W), 'keep.txt'), 'x');
  fs.rmSync(path.join(out, 'status.json')); // lost status: must not reuse a-1
  C.runConvert({ src, outRoot: out, execute: true, convert: spy });
  assert.ok(fs.existsSync(path.join(wardDir(out, W), 'keep.txt'))); assert.ok(fs.existsSync(path.join(out, W + '-a2')));
});

test('end-to-end: Git-tracked Sumiyoshi 43D rebuild = 35,031 buildings, 37B 9-tile GLBs byte identical', () => {
  const T = require('../tools/mission43-ward-rebuild.cjs');
  const r = T.regress(path.join(tmp(), 'sumi'));
  assert.strictEqual(r.ok, true); assert.strictEqual(r.rebuilt.buildings, 35031);
  assert.strictEqual(r.vsCommitted9Tile.glbByteIdentical, r.vsCommitted9Tile.refTiles); assert.strictEqual(r.vsCommitted9Tile.refTiles, 9);
});

// ---- preview ----------------------------------------------------------------------------------------------------------------
function get(port, urlPath, headers, method) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method: method || 'GET', headers: Object.assign({ Host: '127.0.0.1:' + port }, headers || {}) }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject); req.end();
  });
}

test('preview plan (default) verifies and serves nothing; nothing verified => cannot serve', async () => {
  const { out } = converted(1);
  const p = P.plan({ outRoot: out, wards: W });
  assert.deepStrictEqual(p.servable.map((s) => s.ward), [W]);
  const cli = spawnSync(process.execPath, [path.join(ROOT, 'tools/mission43g-local-preview.cjs'), '--out-root', out, '--wards', W], { encoding: 'utf8', timeout: 20000 });
  assert.strictEqual(cli.status, 0); const j = JSON.parse(cli.stdout); assert.strictEqual(j.serving, false); assert.strictEqual(j.mode, 'plan');
  assert.ok(!/\/tmp\/|bldg_/.test(cli.stdout));
  fs.unlinkSync(path.join(wardDir(out, W), 'verify-report.json'));
  await assert.rejects(P.serve({ outRoot: out, wards: W }), (e) => e.code === 3);
});

test('preview server: loopback only, verified wards only, whitelist only, traversal/host/origin/method/listing/links rejected', async () => {
  const { out } = converted(2);
  // ward 2 becomes unverified => must not be served
  fs.rmSync(path.join(wardDir(out, PC[1]), 'attrs'), { recursive: true });
  const { server, port, servable } = await P.serve({ outRoot: out, port: 0 });
  try {
    assert.strictEqual(server.address().address, '127.0.0.1');
    assert.deepStrictEqual(servable.map((s) => s.ward), [W]);
    const base = '/ext-3dtiles/' + W + '/';
    let r = await get(port, base + 'tileset.json'); assert.strictEqual(r.status, 200); assert.ok(JSON.parse(r.body).root);
    assert.strictEqual(r.headers['access-control-allow-origin'], undefined); // no CORS
    r = await get(port, base + 'source.json'); assert.strictEqual(r.status, 200);
    r = await get(port, base + 'ids/t_0_0.json'); assert.strictEqual(r.status, 200);
    r = await get(port, base + 'tiles/' + fs.readdirSync(path.join(wardDir(out, W), 'tiles'))[0]); assert.strictEqual(r.status, 200);
    r = await get(port, base + 'tileset.json', null, 'HEAD'); assert.strictEqual(r.status, 200); assert.strictEqual(r.body.length, 0);
    // not whitelisted / outside
    for (const u of [base + 'verify-report.json', base + '', base + 'tiles/', base + 'ids/', '/ext-3dtiles/', '/ext-3dtiles/' + PC[1] + '/tileset.json', '/ext-3dtiles/' + PC[2] + '/tileset.json',
      base + '../' + PC[1] + '-a1/tileset.json', base + '..%2f..%2fstatus.json', '/ext-3dtiles/%2e%2e/status.json', base + '%00', base + 'tiles/..%5cx.glb', '/ext-3dtiles/' + W + '-a1/tileset.json',
      '/..%2f..%2fetc/passwd', '/.git/config', '/%2e%2e/package.json', '/map-data/../../package.json']) {
      r = await get(port, u); assert.ok([400, 403, 404].includes(r.status), u + ' -> ' + r.status);
    }
    // method / host / origin
    assert.strictEqual((await get(port, base + 'tileset.json', null, 'POST')).status, 405);
    assert.strictEqual((await get(port, base + 'tileset.json', { Host: 'evil.example' })).status, 403);
    assert.strictEqual((await get(port, base + 'tileset.json', { Host: 'evil.example:' + port })).status, 403);
    assert.strictEqual((await get(port, base + 'tileset.json', { Origin: 'http://evil.example' })).status, 403);
    assert.strictEqual((await get(port, base + 'tileset.json', { Origin: 'http://127.0.0.1:' + port })).status, 200);
    // viewer page is the repo's own and is served unchanged
    r = await get(port, '/'); assert.strictEqual(r.status, 200); assert.ok(/Cesium/.test(r.body.toString('utf8')));
    r = await get(port, '/mission37g-osaka-24ward-mvp.html'); assert.strictEqual(r.status, 200);
  } finally { await new Promise((res) => server.close(res)); }
});

test('preview server: a link planted inside a served ward dir is not followed', { skip: process.platform === 'win32' }, async () => {
  const { out } = converted(1);
  const secret = path.join(tmp(), 'secret.json'); fs.writeFileSync(secret, '{"secret":1}');
  const { server, port } = await P.serve({ outRoot: out, port: 0, wards: W });
  try {
    fs.mkdirSync(path.join(wardDir(out, W), 'ids'), { recursive: true });
    fs.symlinkSync(secret, path.join(wardDir(out, W), 'ids', 'planted.json'));
    const r = await get(port, '/ext-3dtiles/' + W + '/ids/planted.json'); assert.strictEqual(r.status, 404);
  } finally { await new Promise((res) => server.close(res)); }
});

test('safety: new tools have no network client / child_process / delete / copy; ps1 is ASCII, read-only, Out-Host + LASTEXITCODE', () => {
  const v = fs.readFileSync(path.join(ROOT, 'tools/mission43g-verify-local.cjs'), 'utf8');
  const p = fs.readFileSync(path.join(ROOT, 'tools/mission43g-local-preview.cjs'), 'utf8');
  assert.ok(!/require\(['"](https?|net|dns|child_process)['"]\)|fetch\(|rmSync|unlinkSync|rmdirSync|writeFileSync|copyFileSync|renameSync|mkdirSync|createWriteStream/.test(v));
  assert.ok(!/require\(['"](https|net|dns|child_process)['"]\)|fetch\(|rmSync|unlinkSync|rmdirSync|writeFileSync|copyFileSync|renameSync|mkdirSync|createWriteStream|Access-Control|0\.0\.0\.0/.test(p));
  assert.ok(/listen\(port, '127\.0\.0\.1'/.test(p));
  assert.ok(/--serve/.test(p) && /mode: 'plan'/.test(p));
  const ps = fs.readFileSync(path.join(ROOT, 'tools/mission43g-verify.ps1'), 'utf8');
  assert.ok(![...ps].some((c) => c.charCodeAt(0) > 127));
  assert.ok(!/Remove-Item|Copy-Item|robocopy|Move-Item|Invoke-WebRequest|Invoke-RestMethod|Set-Content|Out-File/i.test(ps));
  assert.ok(/Out-Host/.test(ps) && /\$LASTEXITCODE/.test(ps)); assert.ok(!/\$LASTEXITCODE[^\n]*Out-Host/.test(ps));
});

test('viewer contract untouched: 37G gates, localhost-only ?ext=, generation token, destroy on switch, 6 partial wards', () => {
  const h = fs.readFileSync(path.join(ROOT, 'public/mission37g-osaka-24ward-mvp.html'), 'utf8');
  assert.ok(/approved === true/.test(h)); assert.ok(/\(localhost\|127\\\.0\\\.0\\\.1\)/.test(h)); assert.ok(/gen !== bldgGen/.test(h)); assert.ok(/ts\.destroy\(\)/.test(h));
  const p = path.join(ROOT, 'public/mission40j-3dtiles/published.json');
  if (fs.existsSync(p)) assert.strictEqual((rj(p).wards || []).filter((w) => w && w.approved === true).length, 0);
  const tracked = execFileSync('git', ['ls-files', 'public/mission43g*', 'public/ext-3dtiles'], { cwd: ROOT }).toString().trim();
  assert.strictEqual(tracked, ''); // nothing from the 43F output is tracked under public/
});
