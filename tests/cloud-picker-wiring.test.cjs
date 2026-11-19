'use strict';
// Mission 203: picker は検証OK後に 37G 既存の区ボタン(.lc-wardbtn[data-code])を押す。
// ここでは 37G 本体ではなく「同じ class/data-code を持つスタブボタン」で配線だけを検証する(synthetic fixture)。
// 実 37G 上の建物描画の更新は未検証。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const ROOT = path.join(__dirname, '..');
const reg = require('../config/wards/registry.json').wards;
const chrome = ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => fs.existsSync(p));

test('picker ソースは既存区ボタンを再利用し、3D を再実装せず旧データへ fallback しない', () => {
  const pk = fs.readFileSync(path.join(ROOT, 'tools/cloud/ward-picker.js'), 'utf8');
  assert.ok(pk.includes('.lc-wardbtn[data-code='));
  assert.ok(!/Cesium|osaka_3d_buildings|map-data\//.test(pk));
  assert.ok(pk.includes('移動は未実装'));
  // 37G 側に、picker が押す既存ボタンが実在すること
  const html = fs.readFileSync(path.join(ROOT, 'public/mission37g-osaka-24ward-mvp.html'), 'utf8');
  assert.ok(html.includes("class: 'lc-wardbtn'") && html.includes("'data-code': w.wardCode"));
  assert.ok(html.includes('b.onclick = () => { clearSelection(); select(w, true); }'));
});

test('Chrome: 配信済み区のみ既存区ボタンが押され、未配信では押されない(スタブ。実37G描画は未検証)', { skip: chrome ? false : 'Chrome 無し(未検証)' }, async () => {
  const { makeFixture } = await import('../tools/cloud/make-fixture.mjs');
  const kita = reg.find((w) => w.id === 'kita');
  const fuk = reg.find((w) => w.id === 'fukushima');
  const out = fs.mkdtempSync(path.join(ROOT, 'temp-fixture-chrome-'));
  let srv;
  try {
    await makeFixture({ out, wards: ['kita'] });
    fs.copyFileSync(path.join(ROOT, 'tools/cloud/data-resolver.cjs'), path.join(out, 'cloud-data-resolver.js'));
    fs.copyFileSync(path.join(ROOT, 'tools/cloud/ward-picker.js'), path.join(out, 'cloud-ward-picker.js'));
    const btn = (w) => `<button class="lc-wardbtn" data-code="${w.code}" onclick="document.getElementById('log').textContent+='[clicked:${w.code}]'">${w.id}</button>`;
    const page = '<!doctype html><meta charset="utf-8"><body><div id="log"></div>' + btn(kita) + btn(fuk) +
      '<script src="/cloud-data-resolver.js"></script><script src="/cloud-ward-picker.js"></script>' +
      '<script>function pick(v){var s=document.getElementById("lc202-ward");s.value=v;s.dispatchEvent(new Event("change"))}' +
      `setTimeout(function(){pick("${fuk.id}")},500);setTimeout(function(){pick("kita")},2500);</script></body>`;
    fs.writeFileSync(path.join(out, 'index.html'), page);
    const mime = { '.json': 'application/json', '.js': 'text/javascript', '.html': 'text/html', '.glb': 'model/gltf-binary' };
    srv = http.createServer((req, res) => {
      const p = path.join(out, decodeURIComponent(req.url.split('?')[0]).replace(/\/$/, '/index.html'));
      if (!p.startsWith(out) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'content-type': mime[path.extname(p)] || 'application/octet-stream' });
      res.end(fs.readFileSync(p));
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const r = await new Promise((resolve) => {
      const c = spawn(chrome, ['--headless=new', '--no-sandbox', '--disable-gpu', '--virtual-time-budget=9000', '--dump-dom', `http://127.0.0.1:${srv.address().port}/`], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      c.stdout.on('data', (d) => { stdout += d; });
      c.stderr.on('data', (d) => { stderr += d; });
      const t = setTimeout(() => c.kill('SIGKILL'), 50000);
      c.on('close', (status) => { clearTimeout(t); resolve({ status, stdout, stderr }); });
    });
    assert.strictEqual(r.status, 0, r.stderr.slice(-500));
    const log = (r.stdout.match(/<div id="log">([^<]*)<\/div>/) || [])[1] || '';
    assert.strictEqual(log, `[clicked:${kita.code}]`, 'kita のみ(福島区=未配信は押されない): ' + log);
  } finally { if (srv) srv.close(); fs.rmSync(out, { recursive: true, force: true }); }
});
