'use strict';
// Mission 59: GSI 淡色地図タイルの 404 切り分け。大阪の実地点で z=0,1,5,10,14〜17 を各1回 GET（1秒間隔、計 ≤12 件）。
const fs = require('fs');
const UA = 'livecity-mission59-qa/1.0 (read-only, <=12 GET)';
const lat = 34.6044, lon = 135.5051; // 阪和病院付近（Wikidata Q97173758）
const tile = (z) => { const n = 2 ** z, x = Math.floor((lon + 180) / 360 * n); const r = lat * Math.PI / 180; const y = Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n); return { x, y }; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
(async () => {
  const res = [];
  const cases = [['pale', 0], ['pale', 1], ['pale', 5], ['pale', 10], ['pale', 14], ['pale', 15], ['pale', 16], ['pale', 17], ['blank', 14], ['std', 16]];
  for (const [layer, z] of cases) {
    const { x, y } = tile(z); const url = `https://cyberjapandata.gsi.go.jp/xyz/${layer}/${z}/${x}/${y}.png`;
    const o = { layer, z, x, y, url };
    try { const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) }); o.status = r.status; o.type = r.headers.get('content-type'); o.bytes = (await r.arrayBuffer()).byteLength; }
    catch (e) { o.error = String(e && e.cause && e.cause.code || e.message); }
    res.push(o); console.log(JSON.stringify(o)); await sleep(1000);
  }
  fs.mkdirSync('data/reports/mission59', { recursive: true });
  fs.writeFileSync('data/reports/mission59/gsi-tile-probe.json', JSON.stringify({ point: { lat, lon }, results: res }, null, 1));
})();
