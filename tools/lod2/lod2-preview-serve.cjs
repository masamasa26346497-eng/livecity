#!/usr/bin/env node
'use strict';
// Mission 161: localhost 限定・読み取り専用の LOD2 プレビュー用静的サーバ(token 不要・外部公開なし)。
//   node tools/lod2/lod2-preview-serve.cjs [--port 8152] [--lod2-dir temp/lod2-preview] [--ext-root <45D out-root の ext-3dtiles 相当ディレクトリ>]
// 配信:  /            -> public/            (既存 Live City。変更なし)
//        /lod2-preview/ -> temp/lod2-preview (生成物 + overlay.js = tools/lod2/lod2-overlay.js)
//        /ext-3dtiles/  -> --ext-root       (指定時のみ。ユーザーの 24 区 LOD1 を同一オリジンで見せる)
// 127.0.0.1 にだけ bind。パストラバーサルは拒否。
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const port = Number(opt('port', 8152));
// Mission 170: --ext-root 未指定でも、既存の 24区 LOD1 出力(%LOCALAPPDATA%\LiveCity-3DTiles-Out-24 等)を読み取り専用で検出し、互換なら自動接続する。
//   --no-auto-ext で自動検出を止める。互換性が不明なら接続せず、理由を diag.json / 画面に出す。
const A = require('./lod2-ext-attach.cjs');
const ATTACH = argv.includes('--no-auto-ext') ? { chosen: null, inspected: [], off: true } : A.discover(opt('ext-root'));
const EXT = ATTACH.chosen; // { dir, kind, wards, servable, verified, reasons } | null
const extStatic = EXT && EXT.kind === 'ext-index' ? EXT.dir : null;
const mounts = [
  ['/lod2-preview/', path.resolve(ROOT, opt('lod2-dir', 'temp/lod2-preview'))],
  ['/ext-3dtiles/', extStatic],
  ['/', path.join(ROOT, 'public')],
].filter((m) => m[1]);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.glb': 'model/gltf-binary',
  '.b3dm': 'application/octet-stream', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml' };

function resolve(urlPath) {
  if (EXT && EXT.kind === '45d-root' && urlPath.startsWith('/ext-3dtiles/') && urlPath !== '/ext-3dtiles/index.json') return A.resolveFromServable(EXT.servable, urlPath.slice('/ext-3dtiles/'.length));
  for (const [prefix, dir] of mounts) {
    if (!urlPath.startsWith(prefix)) continue;
    let rel = decodeURIComponent(urlPath.slice(prefix.length));
    if (prefix === '/lod2-preview/' && rel === 'overlay.js') return path.join(__dirname, 'lod2-overlay.js');
    const full = path.resolve(dir, rel);
    if (full !== dir && !full.startsWith(dir + path.sep)) return null;
    return full;
  }
  return null;
}

// Mission 162: 診断(ファイル存在・37G HTML の attach フック等)。秘密情報・絶対パスは含めない。
function diagnose() {
  const lodDir = mounts[0][1];
  const f = (n) => { const p = path.join(lodDir, n); return fs.existsSync(p) ? { ok: true, bytes: fs.statSync(p).size } : { ok: false }; };
  const htmlP = path.join(ROOT, 'public', 'mission37g-osaka-24ward-mvp.html');
  const html = fs.existsSync(htmlP) ? fs.readFileSync(htmlP, 'utf8') : '';
  let report = null; try { report = JSON.parse(fs.readFileSync(path.join(lodDir, 'report.json'), 'utf8')); } catch (e) { /* none */ }
  return {
    server: 'lod2-preview-serve', port, lod2Dir: path.relative(ROOT, lodDir) || lodDir,
    files: { 'tileset.json': f('tileset.json'), 'lod2.glb': f('lod2.glb'), 'footprints.json': f('footprints.json'), 'report.json': f('report.json') },
    overlayJs: fs.existsSync(path.join(__dirname, 'lod2-overlay.js')),
    html37g: { exists: !!html, hasLod2Hook: html.includes('/lod2-preview/overlay.js') && html.includes('LC152.attach') },
    extRoot: opt('ext-root') ? { ok: fs.existsSync(path.resolve(opt('ext-root'))) } : null,
    extAttach: extSummary(),
    converted: report ? report.converted : null, lod1Remaining: report ? report.lod1Remaining : null,
    data: dataStatus(), extCandidates: extCandidates(),
  };
}

// Mission 169: 表示に必要なデータの有無を起動時に検証する(欠落は日本語で明示)。絶対パス・秘密情報は含めない。
function jsonOf(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; } }
// 接続した/しなかった LOD1 の要約(絶対パスなし。出典・検証状態・欠落区を明記)
function extSummary() {
  const slim = (x) => ({ name: x.name || path.basename(x.dir), kind: x.kind, wards: x.wards.length, missingWards: x.missingWards || [], verified: x.verified === true, reasons: x.reasons });
  return {
    attached: !!EXT, auto: !opt('ext-root') && !!EXT, off: !!ATTACH.off,
    chosen: EXT ? { ...slim(EXT), buildings: EXT.wards.reduce((n, w) => n + (w.buildings || 0), 0), buildingsKnown: EXT.wards.every((w) => w.buildings != null) } : null,
    inspected: ATTACH.inspected.map(slim),
  };
}
function dataStatus() {
  const pub = path.join(ROOT, 'public');
  const ext = EXT ? EXT.dir : null;
  const st = jsonOf(path.join(pub, 'mission145-data', 'stations-24.json'));
  const stLocal = jsonOf(path.join(pub, 'mission145-data', 'stations-24.local.json'));
  const stBest = (stLocal && stLocal.operatorData && stLocal.operatorData.connected) ? stLocal : (st || stLocal);
  const townsOk = ['towns-24.local.json', 'towns-24.json'].find((n) => fs.existsSync(path.join(pub, 'mission145-data', n)));
  const idx = EXT ? { wards: EXT.wards, layersWards: (jsonOf(path.join(EXT.dir, 'index.json')) || {}).layersWards } : null;
  const e = (ok, okMsg, ngMsg) => ({ ok: !!ok, msg: ok ? okMsg : ngMsg });
  return {
    lod1Wards: e(idx && idx.wards.length, (idx ? idx.wards.length : 0) + ' 区の LOD1 を接続(' + (EXT && EXT.kind === '45d-root' ? '既存の45D出力・未検証・出典は旧PC変換データの可能性' : 'index.json') + (EXT && EXT.missingWards && EXT.missingWards.length ? '。欠落区: ' + EXT.missingWards.join(',') : '') + ')',
      opt('ext-root') ? '--ext-root の形式を判断できません: ' + ((ATTACH.inspected[0] || {}).reasons || []).join(' / ') : '24区 LOD1 未接続: 既定の場所に互換な出力が見つかりません(--ext-root <フォルダ> で指定)'),
    stations: e(stBest && Array.isArray(stBest.stations) && stBest.stations.length, stBest && stBest.stations ? stBest.stations.length + ' 駅' : '', '駅データ(mission145-data/stations-24.json)がありません'),
    railOperators: e(stBest && stBest.operatorData && stBest.operatorData.connected, '路線・運営会社を接続済み', '路線データ未接続: 駅名は出ますが運営会社・路線は不明です(stations-24.json が路線ソース無しで生成されたため。tools/mission145-build-stations.cjs に路線ソースを渡して再生成が必要)'),
    towns: e(townsOk, '地名データ ' + townsOk, '地名データ(mission145-data/towns-24.json)がありません。地名は出ません(tools/mission145-build-towns.cjs で生成)'),
    roads: e(fs.existsSync(path.join(pub, 'mission49-data')) || (idx && idx.layersWards && idx.layersWards.length), '道路データあり(内蔵サンプル' + (idx && idx.layersWards ? ' + ' + idx.layersWards.length + '区のレイヤー' : '') + ')', '道路データなし'),
    rivers: e(fs.existsSync(path.join(pub, 'mission50-data')), '河川データあり(大川/中之島のサンプル範囲のみ)', '河川データなし'),
  };
}
// 既存の 24区 LOD1 出力がありそうな場所の候補(存在確認のみ。読み書きはしない)。
function extCandidates() {
  const c = [];
  const add = (p) => { try { if (p && fs.existsSync(p)) c.push(p); } catch (e) { /* ignore */ } };
  if (process.env.LOCALAPPDATA) add(path.join(process.env.LOCALAPPDATA, 'LiveCity-3DTiles-Out-24'));
  add(path.join(ROOT, 'ext-3dtiles')); add(path.join(ROOT, 'temp', 'ext-3dtiles')); add(path.join(ROOT, '..', 'ext-3dtiles'));
  return c.map((p) => ({ dir: path.basename(p), hasIndexJson: fs.existsSync(path.join(p, 'index.json')), is45dRoot: fs.existsSync(path.join(p, '.livecity-45d-root.json')) }));
}

const server = http.createServer((req, res) => {
  try {
    const u = new URL(req.url, 'http://localhost');
    if (u.pathname === '/ext-3dtiles/index.json' && EXT && EXT.kind === '45d-root') { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(A.indexJsonFor(EXT)); return; }
    if (u.pathname === '/__lod2/diag.json') { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(diagnose())); return; }
    let f = resolve(u.pathname);
    if (f && fs.existsSync(f) && fs.statSync(f).isDirectory()) f = path.join(f, 'index.html');
    if (!f || !fs.existsSync(f)) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' });
    fs.createReadStream(f).pipe(res);
  } catch (e) { res.writeHead(400); res.end('bad request'); }
});
server.on('error', (e) => {
  console.error(e.code === 'EADDRINUSE' ? '[LOD2] ポート ' + port + ' は既に使用中です。別ポートなら --port 8153 を指定するか、既存のサーバを閉じてください' : '[LOD2] サーバエラー: ' + e.message);
  process.exit(2);
});
if (require.main === module) server.listen(port, '127.0.0.1', () => {
  console.log('LOD2 preview (localhost only): http://localhost:' + port + '/mission37g-osaka-24ward-mvp.html?nobuiltin=1&ext45=1&lod2=1&lod2fly=1');
  console.log('lod2 dir: ' + mounts[0][1]);
  if (EXT) console.log('24区 LOD1: ' + EXT.wards.length + ' 区を読み取り専用で接続 [' + EXT.kind + (EXT.verified ? '' : '・未検証') + '] ' + EXT.reasons.join(' / '));
  else { console.log('24区 LOD1: 未接続(内蔵サンプル区のみ)'); for (const x of ATTACH.inspected) console.log('  検査した候補 ' + x.name + ': ' + x.reasons.join(' / ')); }
});
module.exports = { server, resolve, diagnose, dataStatus, extCandidates };
