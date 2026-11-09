#!/usr/bin/env node
// Mission 38E: 実Chrome(CDP)QA。node 22 組み込み WebSocket のみ使用（依存追加なし）。
// 使い方: node tools/mission38e-cdp-qa.cjs <preview-url> [out.json]
// 事前: chromium --headless=new --remote-debugging-port=9333 --use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader --no-sandbox about:blank
const fs = require('fs');
const url = process.argv[2];
const out = process.argv[3];
const PORT = process.env.CDP_PORT || 9333;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const target = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0;
  const pending = new Map();
  const log = { exceptions: [], consoleErrors: [], http4xx: [], failed: [], paidOrGoogleHosts: [], hosts: {} };
  const reqUrl = {};
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); return; }
    const p = d.params || {};
    if (d.method === 'Runtime.exceptionThrown') log.exceptions.push(p.exceptionDetails.text + ' ' + ((p.exceptionDetails.exception || {}).description || ''));
    if (d.method === 'Runtime.consoleAPICalled' && p.type === 'error') log.consoleErrors.push((p.args || []).map((a) => a.value || a.description).join(' ').slice(0, 300));
    if (d.method === 'Network.requestWillBeSent') {
      reqUrl[p.requestId] = p.request.url;
      try {
        const h = new URL(p.request.url).hostname;
        log.hosts[h] = (log.hosts[h] || 0) + 1;
        if (/google|gstatic|cesium\.com/.test(h)) log.paidOrGoogleHosts.push(p.request.url);
      } catch (e) { /* data: URL 等 */ }
    }
    if (d.method === 'Network.responseReceived' && p.response.status >= 400) log.http4xx.push(p.response.status + ' ' + p.response.url);
    if (d.method === 'Network.loadingFailed') log.failed.push((reqUrl[p.requestId] || p.requestId) + ' ' + p.errorText);
  };
  const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expr) => ((await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result.result || {}).value;
  await send('Runtime.enable'); await send('Network.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url });
  const t0 = Date.now();
  let st = null;
  for (let i = 0; i < 120; i++) {
    await sleep(1000);
    st = await ev('window.__mission38e && window.__mission38e.status');
    if (st === 'ready' || st === 'error') break;
  }
  const res = { url, status: st, loadSeconds: (Date.now() - t0) / 1000 };
  res.tilesetBuildings = await ev('window.__mission38e && window.__mission38e.tilesetBuildings');
  await sleep(8000); // タイル読み込み待ち

  // 360度回転: heading を 45度ずつ一周
  res.rotation = [];
  for (let k = 0; k < 8; k++) {
    const r = await ev(`(async()=>{const v=window.__mission38eViewer;const c=v.camera;
      c.setView({destination:c.positionWC,orientation:{heading:${k}*Math.PI/4,pitch:c.pitch,roll:0}});
      await new Promise(r=>setTimeout(r,600));v.scene.render();
      return {heading:+Cesium.Math.toDegrees(c.heading).toFixed(1),pitch:+Cesium.Math.toDegrees(c.pitch).toFixed(1)}})()`);
    res.rotation.push(r);
  }
  res.tiles = await ev('(()=>{const t=window.__mission38eViewer.scene.primitives.get(0);return {loaded:t.tilesLoaded,ready:t.statistics.numberOfTilesWithContentReady,pending:t.statistics.numberOfPendingRequests}})()');

  // 実マウスクリック: 建物に当たる座標を探し、CDP の実入力でクリック
  res.clicks = [];
  for (let y = 250; y <= 650 && res.clicks.length < 3; y += 50) {
    for (let x = 300; x <= 1000 && res.clicks.length < 3; x += 50) {
      const hit = await ev(`(()=>{const v=window.__mission38eViewer;const p=v.scene.pick(new Cesium.Cartesian2(${x},${y}));return !!(p&&p.getProperty&&p.getProperty('canonicalId'))})()`);
      if (!hit) continue;
      for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
        await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, buttons: type === 'mousePressed' ? 1 : 0 });
      }
      await sleep(1500);
      const s2 = await ev('JSON.stringify({id:window.__mission38e.lastPickedCanonicalId,match:window.__mission38e.lastPickMatchesSidecar,text:document.getElementById("picked").textContent})');
      res.clicks.push(Object.assign({ x, y }, JSON.parse(s2)));
    }
  }
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  if (process.env.SHOT) fs.writeFileSync(process.env.SHOT, Buffer.from(shot.result.data, 'base64'));

  const json = JSON.stringify({ res, log }, null, 2);
  if (out) fs.writeFileSync(out, json);
  console.log(json);
  ws.close();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
