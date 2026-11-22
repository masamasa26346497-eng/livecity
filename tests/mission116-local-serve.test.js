// Mission 116 第3段階: ローカル出力の安全配信（--data-root）と、区切替時の欠落通知スクリプトの自動検証。
// 小型フィクスチャ（福島/住吉/西）のみ使用。実データ・ネットワーク・WebGL は使わない。
// ※ 実ブラウザの WebGL 描画・24区の実データ表示はここでは「未検証」。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import vm from 'node:vm';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateDataRoot, resolveDataRootFile } from '../tools/lib/safe-static-root.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const WARDS = [
  { id: 'osaka-fukushima', wardId: 'fukushima' },
  { id: 'osaka-sumiyoshi', wardId: 'sumiyoshi' },
  { id: 'osaka-nishi', wardId: 'nishi' },
];

function w(file, obj) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof obj === 'string' ? obj : JSON.stringify(obj)); }

function makeFixture(skipWaterFor) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'lc116-'));
  const dataRoot = path.join(base, 'osaka-city');
  w(path.join(dataRoot, 'buildings/manifest.json'), { datasets: WARDS });
  for (const d of WARDS) w(path.join(dataRoot, `buildings/${d.id}/manifest.json`), { coordinateConvention: 'znorth-neg-v1', tiles: [] });
  if (!skipWaterFor) {
    w(path.join(dataRoot, 'waterways/manifest.json'), { coordinateConvention: 'znorth-neg-v1', tiles: [] });
    w(path.join(dataRoot, 'rivers-v2/rivers.json'), { coordinateConvention: 'znorth-neg-v1', rivers: [] });
    w(path.join(dataRoot, 'water-surface/water-surface.json'), { coordinateConvention: 'znorth-neg-v1' });
  }
  w(path.join(base, 'secret.json'), '{"secret":true}');
  w(path.join(dataRoot, 'notes.txt'), 'x');
  return { base, dataRoot };
}

function freePort() {
  return new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
}

async function startPreview(dataRoot) {
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(ROOT, 'tools/preview.js'), '--port', String(port), '--data-root', dataRoot], { stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('preview 起動タイムアウト')), 8000);
    child.stdout.on('data', (d) => { if (String(d).includes('起動しました')) { clearTimeout(t); resolve(); } });
    child.on('exit', (c) => { clearTimeout(t); reject(new Error('preview 異常終了 ' + c)); });
  });
  return { port, stop: () => child.kill() };
}
const get = async (port, p) => { const r = await fetch(`http://127.0.0.1:${port}${p}`); return { status: r.status, text: await r.text() }; };

test('resolveDataRootFile: マウント内の json のみ許可、トラバーサル/非json/ドット/symlink脱出は拒否', (t) => {
  const { base, dataRoot } = makeFixture();
  const real = validateDataRoot(dataRoot);
  const M = '/map-data/osaka-city/';
  assert.equal(resolveDataRootFile(real, M + 'buildings/manifest.json').ok, true);
  assert.equal(resolveDataRootFile(real, M + 'buildings/manifest.json?x=1').ok, true);
  assert.equal(resolveDataRootFile(real, '/other/buildings/manifest.json').reason, 'not-mounted');
  for (const bad of ['../secret.json', '..%2Fsecret.json', '%2e%2e/secret.json', 'buildings/../../secret.json', 'notes.txt', '.hidden.json', 'a\\b.json', 'C:/x.json', 'a%00.json']) {
    const r = resolveDataRootFile(real, M + bad);
    assert.equal(r.ok, false, bad);
    assert.ok(['forbidden', 'not-found'].includes(r.reason), bad);
  }
  assert.equal(resolveDataRootFile(real, M + 'buildings').ok, false); // ディレクトリ
  // symlink による脱出（作成できない環境では skip）
  try {
    fs.symlinkSync(base, path.join(dataRoot, 'link'), 'dir');
    assert.equal(resolveDataRootFile(real, M + 'link/secret.json').reason, 'forbidden');
  } catch (e) { if (e.code !== 'EPERM') throw e; t.diagnostic('symlink 作成不可: 脱出テストを skip'); }
});

test('validateDataRoot: 未指定/存在しない/ファイル/FSルートは拒否', () => {
  assert.throws(() => validateDataRoot(''));
  assert.throws(() => validateDataRoot('/definitely/not/here-lc116'));
  assert.throws(() => validateDataRoot(path.join(ROOT, 'package.json')));
  assert.throws(() => validateDataRoot(path.parse(process.cwd()).root));
});

test('preview --data-root: 福島/住吉/西 の建物manifestと河川・水面が HTTP 200、危険なURLは拒否、HTMLにスクリプト注入', async () => {
  const { base, dataRoot } = makeFixture();
  const p = await startPreview(dataRoot);
  try {
    for (const d of WARDS) assert.equal((await get(p.port, `/map-data/osaka-city/buildings/${d.id}/manifest.json`)).status, 200, d.id);
    for (const u of ['waterways/manifest.json', 'rivers-v2/rivers.json', 'water-surface/water-surface.json']) {
      assert.equal((await get(p.port, `/map-data/osaka-city/${u}`)).status, 200, u);
    }
    assert.equal((await get(p.port, '/map-data/osaka-city/roads/manifest.json')).status, 404); // 無いものは 404（偽装しない）
    assert.equal((await get(p.port, '/map-data/osaka-city/notes.txt')).status, 403);
    assert.notEqual((await get(p.port, '/map-data/osaka-city/..%2f..%2fsecret.json')).status, 200);
    const secret = await get(p.port, '/map-data/osaka-city/%2e%2e/secret.json');
    assert.ok(!secret.text.includes('"secret"'));
    const html = await get(p.port, '/osaka_3d_buildings.ward-ux-v1.html');
    assert.equal(html.status, 200);
    assert.ok(html.text.includes('/livecity-ward-layer-status.js'));
    assert.equal((await get(p.port, '/livecity-ward-layer-status.js')).status, 200);
  } finally { p.stop(); fs.rmSync(base, { recursive: true, force: true }); }
});

// ── 欠落通知スクリプトを vm で実行（DOM/fetch/WardModeManager はモック）──────────
function runStatusScript({ files, wardIdRef }) {
  const el = { style: {}, setAttribute() {}, textContent: '' };
  const aborted = [];
  const sandbox = {
    window: {}, document: { createElement: () => el, body: { appendChild() {} } },
    AbortController, setInterval: () => 0, console,
    fetch: (url, o) => new Promise((resolve, reject) => {
      const done = () => { if (o && o.signal && o.signal.aborted) { aborted.push(url); const e = new Error('abort'); e.name = 'AbortError'; return reject(e); } resolve({ status: files[url] ? 200 : 404, ok: !!files[url], json: async () => files[url] }); };
      setTimeout(done, 5);
    }),
  };
  sandbox.window = sandbox;
  Object.defineProperty(sandbox, 'WardModeManager', { get: () => ({ currentWardId: wardIdRef.id }) });
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'public/livecity-ward-layer-status.js'), 'utf8'), sandbox);
  return { api: sandbox.LiveCityWardLayerStatus, el, aborted };
}

test('ward-layer-status: 河川データ欠落を画面通知し、全揃いなら通知しない', async () => {
  const B = 'map-data/osaka-city';
  const full = { [`${B}/buildings/manifest.json`]: { datasets: WARDS }, [`${B}/buildings/osaka-fukushima/manifest.json`]: {}, [`${B}/waterways/manifest.json`]: {}, [`${B}/rivers-v2/rivers.json`]: {}, [`${B}/water-surface/water-surface.json`]: {} };
  let s = runStatusScript({ files: full, wardIdRef: { id: 'fukushima' } });
  let r = await s.api.check('fukushima');
  assert.equal(r.ok, true);
  assert.equal(s.el.style.display, 'none');

  const noWater = { ...full }; delete noWater[`${B}/waterways/manifest.json`]; delete noWater[`${B}/rivers-v2/rivers.json`];
  s = runStatusScript({ files: noWater, wardIdRef: { id: 'fukushima' } });
  r = await s.api.check('fukushima');
  assert.equal(r.ok, false);
  assert.equal(s.el.style.display, 'block');
  assert.match(s.el.textContent, /河川\(waterways\).*データ未配置/);
  assert.match(s.el.textContent, /--data-root/);

  r = await s.api.check('unknown-ward');
  assert.equal(r.ok, false); // 建物定義が無い区も成功扱いにしない
});

test('ward-layer-status: 区を素早く切り替えると古いチェックは取消され、結果は最新の区だけ', async () => {
  const B = 'map-data/osaka-city';
  const files = { [`${B}/buildings/manifest.json`]: { datasets: WARDS }, [`${B}/buildings/osaka-sumiyoshi/manifest.json`]: {}, [`${B}/waterways/manifest.json`]: {}, [`${B}/rivers-v2/rivers.json`]: {}, [`${B}/water-surface/water-surface.json`]: {} };
  const s = runStatusScript({ files, wardIdRef: { id: 'x' } });
  await s.api.check('fukushima');                 // root manifest をキャッシュ
  const first = s.api.check('fukushima');          // 福島（建物manifestは無い → 問題あり）
  const second = s.api.check('sumiyoshi');         // すぐ住吉へ切替
  assert.equal(await first, null);                 // 古い方は取消（null）
  assert.equal((await second).ok, true);
  assert.equal(s.api.last.wardId, 'sumiyoshi');
  assert.ok(s.aborted.length >= 1);
  assert.equal(s.el.style.display, 'none');
});

test('HTML本体は無改変の方針: preview 注入のみで、座標系定数・水面高さの既存回帰テストと矛盾しない', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public/osaka_3d_buildings.ward-ux-v1.html'), 'utf8');
  assert.ok(!html.includes('livecity-ward-layer-status.js'), 'HTMLに直接埋め込まない（preview が dev 版にのみ注入）');
  const src = fs.readFileSync(path.join(ROOT, 'public/livecity-ward-layer-status.js'), 'utf8');
  assert.ok(!/geoToThree|position\.(x|z)\s*[+\-]?=|translate/i.test(src), '座標補正・平行移動を含まない');
});
