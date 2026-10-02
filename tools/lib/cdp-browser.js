// tools/lib/cdp-browser.js
// [Mission 32P §19] 実ブラウザ（Edge / Chrome）を Chrome DevTools Protocol で操作する最小クライアント。
//   追加依存なし（Node 22+ の global WebSocket / fetch を使う）。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const BROWSER_CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function launchBrowser({ executable, port = 9300 + Math.floor(Math.random() * 500), width = 1600, height = 1000, headless = true, extraArgs = [] } = {}) {
  const exe = executable || BROWSER_CANDIDATES.find((p) => fs.existsSync(p));
  if (!exe) throw new Error('Edge / Chrome が見つからない');
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'livecity-cdp-'));
  const args = [
    ...(headless ? ['--headless=new'] : []),
    `--remote-debugging-port=${port}`, `--user-data-dir=${userDir}`, `--window-size=${width},${height}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--mute-audio',
    '--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    ...extraArgs, 'about:blank',
  ];
  const proc = spawn(exe, args, { stdio: 'ignore' });
  let version = null;
  for (let i = 0; i < 60 && !version; i++) {
    await sleep(500);
    try { version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); } catch { /* 起動待ち */ }
  }
  if (!version) { proc.kill(); throw new Error('CDP に接続できない'); }
  const cdp = await connect(version.webSocketDebuggerUrl);
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const page = {
    send: (method, params = {}) => cdp.send(method, params, sessionId),
    on: (method, fn) => cdp.on(method, fn, sessionId),
    async evaluate(expr, { timeoutMs = 120000 } = {}) {
      const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, timeout: timeoutMs }, sessionId, timeoutMs + 5000);
      if (r.exceptionDetails) throw new Error('evaluate: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
      return r.result.value;
    },
  };
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  return {
    exe, version: version.Browser, page,
    async close() { try { await cdp.send('Browser.close'); } catch { /* */ } cdp.close(); setTimeout(() => { try { proc.kill(); } catch { /* */ } try { fs.rmSync(userDir, { recursive: true, force: true }); } catch { /* */ } }, 1500); },
  };
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let id = 0;
    const pending = new Map();
    const listeners = [];
    ws.onmessage = (ev) => {
      const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString());
      if (msg.id != null && pending.has(msg.id)) {
        const p = pending.get(msg.id); pending.delete(msg.id); clearTimeout(p.timer);
        if (msg.error) p.reject(new Error(msg.error.message)); else p.resolve(msg.result);
      } else if (msg.method) {
        for (const l of listeners) if (l.method === msg.method && (!l.sessionId || l.sessionId === msg.sessionId)) l.fn(msg.params);
      }
    };
    ws.onerror = (e) => reject(e);
    ws.onopen = () => resolve({
      send(method, params = {}, sessionId, timeoutMs = 60000) {
        const mid = ++id;
        return new Promise((res, rej) => {
          const timer = setTimeout(() => { pending.delete(mid); rej(new Error('CDP timeout: ' + method)); }, timeoutMs);
          pending.set(mid, { resolve: res, reject: rej, timer });
          ws.send(JSON.stringify({ id: mid, method, params, ...(sessionId ? { sessionId } : {}) }));
        });
      },
      on(method, fn, sessionId) { listeners.push({ method, fn, sessionId }); },
      close() { try { ws.close(); } catch { /* */ } },
    });
  });
}
