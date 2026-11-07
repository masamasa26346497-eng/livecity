#!/usr/bin/env node
// Mission 116: 24区の建物＋河川レイヤー検証（ローカルファイル + 任意でHTTP 200）。
//
// 使い方:
//   node tools/verify-ward-layers.js                       # 24区すべて（ファイル検査のみ）
//   node tools/verify-ward-layers.js --ward fukushima,sumiyoshi,nishi --http
//   node tools/verify-ward-layers.js --public D:\livecity\public --strict
//
// 出力: data/reports/mission116/ward-layer-verification.{json,md}
// 注意:
//  - このツールは「ローカルデータの在庫・整合・HTTP配信」まで。WebGL実描画は browserVerified=false のまま
//    （実ブラウザ検証は tools/browser-smoke-ward.js を使う）。
//  - ネットワーク接続・ダウンロード・生成・アップロードは一切行わない（127.0.0.1 のみ）。
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectWard, planWard, urls, urlToFile } from './lib/ward-layer-plan.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const a = { public: path.join(ROOT, 'public'), ward: 'all', http: false, strict: false, out: path.join(ROOT, 'data/reports/mission116') };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--public') a.public = path.resolve(argv[++i]);
    else if (argv[i] === '--ward') a.ward = argv[++i];
    else if (argv[i] === '--http') a.http = true;
    else if (argv[i] === '--strict') a.strict = true;
    else if (argv[i] === '--out') a.out = path.resolve(argv[++i]);
  }
  return a;
}

function startStaticServer(publicDir) {
  const base = path.resolve(publicDir);
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent((req.url || '/').split('?')[0]).replace(/^\/+/, '');
    const abs = path.normalize(path.join(base, rel));
    if (abs !== base && !abs.startsWith(base + path.sep)) { res.writeHead(403); return res.end(); }
    fs.stat(abs, (e, st) => {
      if (e || !st.isFile()) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(); // HEAD相当: 本文は不要（200の確認のみ）
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

async function probeHttp(port, list) {
  const res = {};
  for (const u of list) {
    try { res[u] = (await fetch(`http://127.0.0.1:${port}/${u}`, { method: 'GET' })).status; } catch { res[u] = 'ERR'; }
  }
  return res;
}

/** レイヤー別のHTTP検査対象。道路(manifest+tiles)と水面polygon(water-surface)を独立に扱う。 */
export function httpGroups(plan) {
  return {
    buildings: [plan.buildingManifestUrl],
    roads: [urls.cityManifest('roads'), ...plan.cityTileUrls.roads],
    waterways: [urls.cityManifest('waterways'), ...plan.cityTileUrls.waterways],
    riversV2: [urls.riversV2()],
    waterSurface: [urls.waterSurface()],
  };
}
/** 全体の ok200/checked に加え byLayer で内訳を返す。missing(404)は notOk に明示される。 */
export function summarizeHttp(groups, status) {
  const byLayer = {};
  let checked = 0, ok200 = 0; const notOk = [];
  for (const [layer, list] of Object.entries(groups)) {
    const ok = list.filter((u) => status[u] === 200).length;
    byLayer[layer] = { checked: list.length, ok200: ok, missing: list.filter((u) => status[u] === 404).length, allOk: list.length > 0 && ok === list.length };
    checked += list.length; ok200 += ok;
    for (const u of list) if (status[u] !== 200) notOk.push(`${status[u]} ${u}`);
  }
  return { checked, ok200, byLayer, notOk: notOk.slice(0, 20) };
}

const mark =(l) => (!l ? '-' : l.status === 'ok' ? 'OK' : l.status === 'partial' ? `部分(${l.code})` : `なし(${l.code})`);

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const rootFile = urlToFile(args.public, urls.buildingsRoot());
  if (!fs.existsSync(rootFile)) { console.error(`buildings/manifest.json が見つかりません: ${rootFile}`); process.exit(2); }
  const rootManifest = JSON.parse(fs.readFileSync(rootFile, 'utf8'));
  const polyFile = urlToFile(args.public, urls.wardPolygons());
  const wardPolygons = fs.existsSync(polyFile) ? JSON.parse(fs.readFileSync(polyFile, 'utf8')).wards : [];

  const keys = args.ward === 'all' ? rootManifest.datasets.map((d) => d.wardId) : args.ward.split(',').map((s) => s.trim()).filter(Boolean);
  const results = keys.map((k) => inspectWard({ publicDir: args.public, rootManifest, wardKey: k, wardPolygons }));

  if (args.http) {
    const { server, port } = await startStaticServer(args.public);
    try {
      for (const r of results) {
        if (!r.datasetId) continue;
        const plan = planWard(rootManifest, r.wardKey);
        const groups = httpGroups(plan);
        const st = await probeHttp(port, Object.values(groups).flat());
        r.http = summarizeHttp(groups, st);
      }
    } finally { server.close(); }
  }

  fs.mkdirSync(args.out, { recursive: true });
  fs.writeFileSync(path.join(args.out, 'ward-layer-verification.json'), JSON.stringify({ generatedAt: new Date().toISOString(), publicDir: args.public, wardCount: results.length, results }, null, 2));
  const lines = ['| 区 | 宣言棟数 | 建物 | 河川(waterways) | 水域種別 | rivers-v2 | water-surface | 区内率 | 地表高 | 建物×水面 | HTTP200 | 実ブラウザ |', '|---|---|---|---|---|---|---|---|---|---|---|---|'];
  for (const r of results) {
    const c = r.checks || {};
    lines.push(`| ${r.ward || r.wardKey} | ${r.declared ? r.declared.buildings : '-'} | ${mark(r.layers && r.layers.buildings)} | ${mark(r.layers && r.layers.waterways)} | ${r.waterKind || '-'} | ${mark(r.layers && r.layers.riversV2)} | ${mark(r.layers && r.layers.waterSurface)} | ${c.insideWard && c.insideWard.ratio != null ? (c.insideWard.ratio * 100).toFixed(1) + '%' : '未検証'} | ${c.groundBase ? (c.groundBase.pass ? 'OK' : 'NG') : '未検証'} | ${c.buildingsOverWater ? (c.buildingsOverWater.pass ? 'OK' : '要確認') : '未検証'} | ${r.http ? `${r.http.ok200}/${r.http.checked}` : '未実施'} | 未検証 |`);
  }
  fs.writeFileSync(path.join(args.out, 'ward-layer-verification.md'), lines.join('\n') + '\n');
  console.log(lines.join('\n'));
  const complete = results.filter((r) => r.localData === 'complete').length;
  console.log(`\nローカルデータ完備: ${complete}/${results.length} 区（描画成功ではない。実ブラウザ検証は別工程）`);
  if (args.strict && complete !== results.length) process.exit(1);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((e) => { console.error(e); process.exit(1); });
