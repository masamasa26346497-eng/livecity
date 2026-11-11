// [Mission 47-Retry] 建物(GLB)・道路(road bundle) が同じ局所座標で同じ Cesium 地表位置に描画されるかを実 Chrome で検証する。
// 建物: 真上から見て、元 tile の代表点(repX/repZ, 屋根高)を投影 → その画面点の depth(屋根)を pickPosition で読み戻し、元座標との差(m)を測る。
// 道路: 道路 bundle の頂点を投影し、道路 ON/OFF の画面差分がその画素付近にあるかを測る。補正は一切しない。headless はソフトウェア描画。
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { launchBrowser } from '../lib/cdp-browser.js';

const OUT = 'data/reports/mission47-position';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.glb': 'model/gltf-binary' };
const root = path.resolve('public');
const srv = http.createServer((req, res) => {
  const p = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.statusCode = 404; res.end('nf'); return; }
  res.setHeader('Content-Type', MIME[path.extname(p)] || 'application/octet-stream');
  fs.createReadStream(p).pipe(res);
});
await new Promise((r) => srv.listen(8148, r));
fs.mkdirSync(OUT, { recursive: true });

const dir = 'public/map-data/osaka-city/buildings/osaka-sumiyoshi';
const glbDir = 'public/mission37b-3dtiles/osaka-sumiyoshi-9tile/tiles/';
const area = (fp) => { let a = 0; for (let i = 0; i < fp.length; i++) { const p = fp[i], q = fp[(i + 1) % fp.length]; a += p[0] * q[1] - q[0] * p[1]; } return Math.abs(a / 2); };
const cand = [];
for (const f of fs.readdirSync(dir).filter((n) => /^tile_.*\.json$/.test(n))) {
  if (!fs.existsSync(glbDir + f.replace(/^tile_/, 't_').replace('.json', '.glb'))) continue;
  const t = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  for (const b of t.buildings) if ((b.z0 + b.h) >= 20 && area(b.fp) > 400 && b.fp.length >= 4) cand.push({ id: b.id, x: b.repX, z: b.repZ, top: b.z0 + b.h, area: area(b.fp) });
}
cand.sort((a, b) => b.area - a.area);
const picks = [];
for (const c of cand) { if (picks.every((p) => Math.hypot(p.x - c.x, p.z - c.z) > 250)) picks.push(c); if (picks.length >= 12) break; }

const br = await launchBrowser({ width: 1400, height: 900 });
const page = br.page; const ev = (js) => page.evaluate(js);
const rec = { browser: br.version, jsErrors: [], buildings: [], roads: {} };
page.on('Runtime.exceptionThrown', (e) => { try { rec.jsErrors.push(String(e.exceptionDetails?.exception?.description || e.exceptionDetails?.text).slice(0, 300)); } catch { /* noop */ } });
try {
  await page.send('Page.navigate', { url: 'http://localhost:8148/mission37g-osaka-24ward-mvp.html?qa=1&imagery=0&fac=0&bw=27120' });
  for (let i = 0; i < 60; i++) { await sleep(1500); if ((await ev("!!(window.__mission37dQA && document.getElementById('lc-loading').classList.contains('done'))").catch(() => false)) === true) break; }
  await sleep(3000);
  for (const c of picks) {
    await ev('window.__mission37dQA.lookAtLocal(' + [c.x + 110, c.z - 70, 0, 250, -90, 0].join(',') + ')');
    await sleep(3500);
    const pr = await ev('JSON.stringify(window.__mission37dQA.project(' + [c.x, c.z, c.top].join(',') + '))').then(JSON.parse);
    const got = pr && pr.inCanvas ? await ev('JSON.stringify(window.__mission37dQA.pickLocal(' + pr.x + ',' + pr.y + '))').then(JSON.parse) : null;
    const id = pr && pr.inCanvas ? await ev('window.__mission37dQA.pickId(' + pr.x + ',' + pr.y + ')') : null;
    rec.buildings.push({ id: c.id, topM: c.top, screen: pr, pickedId: id, idMatch: id === c.id, pickedLocal: got,
      errXm: got ? +(got.x - c.x).toFixed(2) : null, errZm: got ? +(got.z - c.z).toFixed(2) : null, errHm: got ? +(got.h - c.top).toFixed(2) : null });
  }
  const roads = JSON.parse(fs.readFileSync('public/mission37c-layers/osaka-sumiyoshi-9tile/roads.json', 'utf8')).features.filter((f) => f.tier === 'major' || f.tier === 'mid');
  const cx = -2250, cz = -750;
  await ev('window.__mission37dQA.lookAtLocal(' + [cx, cz, 0, 1500, -90, 0].join(',') + ')'); await sleep(4000);
  const shot = async () => (await page.send('Page.captureScreenshot', { format: 'png' })).data;
  await ev("window.__mission37dQA.setLayer('roads', true)"); await sleep(1500); const on = await shot();
  await ev("window.__mission37dQA.setLayer('roads', false)"); await sleep(1500); const off = await shot();
  await ev("window.__mission37dQA.setLayer('roads', true)");
  fs.writeFileSync(path.join(OUT, 'roads-on.png'), Buffer.from(on, 'base64'));
  const pts = [];
  for (const f of roads) for (const q of f.p) if (Math.hypot(q[0] - cx, q[1] - cz) < 1000) pts.push(q);
  const sample = pts.filter((_, i) => i % Math.max(1, Math.floor(pts.length / 600)) === 0);
  const proj = await ev('JSON.stringify(' + JSON.stringify(sample) + '.map(q=>window.__mission37dQA.project(q[0],q[1],1.4)))').then(JSON.parse);
  const dpr = await ev('window.devicePixelRatio');
  const js = '(async()=>{const L=(s)=>new Promise(r=>{const i=new Image();i.onload=()=>r(i);i.src="data:image/png;base64,"+s});'
    + 'const [a,c]=await Promise.all([L("' + on + '"),L("' + off + '")]);const cv=document.createElement("canvas");cv.width=a.width;cv.height=a.height;const x=cv.getContext("2d");'
    + 'x.drawImage(a,0,0);const da=x.getImageData(0,0,cv.width,cv.height);x.clearRect(0,0,cv.width,cv.height);x.drawImage(c,0,0);const db=x.getImageData(0,0,cv.width,cv.height);'
    + 'const P=' + JSON.stringify(proj) + ';let n=0,hit=0;const rr=Math.round(3*' + dpr + ');'
    + 'for(const p of P){if(!p||!p.inCanvas)continue;n++;const px=Math.round(p.x*' + dpr + '),py=Math.round(p.y*' + dpr + ');let d=false;'
    + 'for(let dy=-rr;dy<=rr&&!d;dy++)for(let dx=-rr;dx<=rr;dx++){const xx=px+dx,yy=py+dy;if(xx<0||yy<0||xx>=a.width||yy>=a.height)continue;const i=(yy*a.width+xx)*4;'
    + 'if(Math.abs(da.data[i]-db.data[i])+Math.abs(da.data[i+1]-db.data[i+1])+Math.abs(da.data[i+2]-db.data[i+2])>24){d=true;break}}'
    + 'if(d)hit++}return {n,hit}})()';
  const res = await ev(js);
  rec.roads = { sampledVertices: res.n, verticesWithRoadPixelWithin3px: res.hit, ratio: res.n ? +(res.hit / res.n).toFixed(3) : null };
} catch (e) { rec.fatal = String((e && e.stack) || e); }
try { await br.close(); } catch { /* noop */ }
const ok = rec.buildings.filter((x) => x.pickedLocal);
const hz = ok.map((x) => Math.hypot(x.errXm, x.errZm));
rec.summary = { requested: picks.length, measured: ok.length, idMatch: rec.buildings.filter((x) => x.idMatch).length,
  horizontalErrMax: hz.length ? +Math.max(...hz).toFixed(2) : null, horizontalErrMean: hz.length ? +(hz.reduce((a, c) => a + c, 0) / hz.length).toFixed(2) : null,
  heightErrAbsMax: ok.length ? +Math.max(...ok.map((x) => Math.abs(x.errHm))).toFixed(2) : null, jsErrors: rec.jsErrors.length };
fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(rec, null, 2));
console.log(JSON.stringify({ summary: rec.summary, roads: rec.roads, fatal: rec.fatal }, null, 1));
srv.close(); process.exit(0);
