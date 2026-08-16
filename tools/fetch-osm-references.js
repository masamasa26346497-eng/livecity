#!/usr/bin/env node
// ══════════════════════════════════════════════════════════════
// tools/fetch-osm-references.js
// ══════════════════════════════════════════════════════════════
// 座標原点推定に使う参照点を「自動取得」する。手入力は一切不要。
//
// 原理: landuse.json は各地物に OSM way ID とローカルXZポリゴンの両方を持つ。
//   同じ way を OSM から取得して緯度経度ポリゴンを得れば、
//   「同一実体のローカル座標 ↔ 実在緯度経度」の対応が自動的に手に入る。
//   突き合わせは重心（頂点順序・回転・反転に不変）で行うため、
//   ノード順の一致を仮定する必要がない。
//
// 入力の優先順位（landuse.jsonが無くても動作する）:
//   1. --html <正規版HTML>（既定 public/osaka_3d_buildings.html）
//      HTML埋め込みの OSM_PARKING / OSM_CEMETERY / OSM_WATER から
//      「OSM way ID + ローカルXZポリゴン」の対応を取り出す（107件規模）。
//   2. --landuse <landuse.json>（存在する場合のみ併用。無くてもよい）
//
// 使い方:
//   node tools/fetch-osm-references.js \
//     --html public/osaka_3d_buildings.html \
//     --out data/buildings/references.auto.json [--limit 60] [--cache .cache/osm-ways.json]
//
// 出力: { generatedAt, source, endpoint, references:[{name, osmId, localX, localZ, lat, lon, source, nodeCount}] }
// この出力をそのまま estimate-origin.js が受け取る（references.json 手入力は不要）。
//
// ネットワーク不可の環境では明確なエラーで停止する（推測値の生成はしない）。

// ── ES Module形式（package.jsonの "type": "module" に対応）──
import fs from 'node:fs';
import path from 'node:path';

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter'
];
const BATCH = 40;          // 1クエリあたりのway数（Overpassの負荷配慮）
const RETRY = 3;
const RETRY_WAIT_MS = 3000;

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) { a[argv[i].slice(2)] = argv[i + 1]; i++; }
  return a;
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function centroid2(points, ix, iy) {
  let sx = 0, sy = 0;
  for (const p of points) { sx += p[ix]; sy += p[iy]; }
  return [sx / points.length, sy / points.length];
}

async function overpassQuery(ids) {
  const q = `[out:json][timeout:60];way(id:${ids.join(',')});out geom;`;
  let lastErr = null;
  for (const endpoint of ENDPOINTS) {
    for (let attempt = 1; attempt <= RETRY; attempt++) {
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'LiveCity/1.0 (origin-calibration)' },
          body: 'data=' + encodeURIComponent(q)
        });
        if (res.status === 429 || res.status === 504) { // レート制限・タイムアウトは待って再試行
          await sleep(RETRY_WAIT_MS * attempt);
          continue;
        }
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return { data: await res.json(), endpoint };
      } catch (e) {
        lastErr = e;
        await sleep(RETRY_WAIT_MS);
      }
    }
  }
  throw new Error('Overpass取得に失敗しました（ネットワーク不通の可能性）: ' + (lastErr && lastErr.message));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const outPath = args.out || 'data/buildings/references.auto.json';
  const limit = parseInt(args.limit || '60', 10);
  const cachePath = args.cache || '.cache/osm-ways.json';

  // ── 参照点候補の収集（HTML埋め込み定数を第一入力とする）──
  const raw = [];
  const htmlPath = args.html || 'public/osaka_3d_buildings.html';
  if (fs.existsSync(htmlPath)) {
    const html = fs.readFileSync(htmlPath, 'utf8');
    const pick = (constName, getPoly) => {
      const line = html.split('\n').find(l => l.startsWith('const ' + constName + ' = '));
      if (!line) return 0;
      let arr;
      try { arr = JSON.parse(line.slice(line.indexOf('['), line.lastIndexOf(']') + 1)); }
      catch (e) { return 0; }
      let n = 0;
      for (const x of (arr || [])) {
        const outer = getPoly(x);
        if (!x || !x.id || !Array.isArray(outer) || outer.length < 5) continue;
        raw.push({ id: x.id, outer, category: constName, name: x.name || '' });
        n++;
      }
      return n;
    };
    const a = pick('OSM_PARKING', x => x.polygons && x.polygons[0] && x.polygons[0].outer);
    const b = pick('OSM_CEMETERY', x => x.p);
    const c = pick('OSM_WATER', x => (x.kind === 'area' ? x.p : null));
    console.log(`HTML埋め込みから参照点候補: 駐車場 ${a} / 墓地 ${b} / 水域 ${c} 件 (${htmlPath})`);
  }
  // landuse.json は存在する場合のみ併用（無くても動作する）
  const landusePath = args.landuse;
  if (landusePath && fs.existsSync(landusePath)) {
    const landuse = JSON.parse(fs.readFileSync(landusePath, 'utf8'));
    let n = 0;
    for (const x of landuse) {
      if (x.osmType !== 'way' || !Array.isArray(x.polygons) || !x.polygons[0]) continue;
      const outer = x.polygons[0].outer;
      if (!Array.isArray(outer) || outer.length < 5) continue;
      raw.push({ id: x.id, outer, category: x.category, name: (x.tags && x.tags.name) || '' });
      n++;
    }
    console.log('landuse.jsonから参照点候補:', n, '件');
  } else if (landusePath) {
    console.log('注意: --landuse で指定された', landusePath, 'が見つからないため、HTML埋め込みのみを使用します。');
  }

  // ID重複を除去し、頂点数が多い＝形状が安定した地物を優先（測定精度が高い）
  const seen = new Set();
  const cands = raw
    .map(x => ({ ...x, numId: parseInt(String(x.id).replace('way/', ''), 10) }))
    .filter(x => Number.isFinite(x.numId) && !seen.has(x.numId) && seen.add(x.numId))
    .sort((a, b) => b.outer.length - a.outer.length)
    .slice(0, limit);
  if (cands.length < 3) {
    console.error('参照点候補が3件未満です。入力を確認してください:');
    console.error('  --html', htmlPath, fs.existsSync(htmlPath) ? '(存在するがOSM ID付きポリゴンが不足)' : '(見つかりません)');
    if (landusePath) console.error('  --landuse', landusePath, fs.existsSync(landusePath) ? '(存在)' : '(見つかりません)');
    process.exit(1);
  }
  console.log('参照点候補:', cands.length, '件（OSM way ID付きポリゴンから自動選定）');

  // キャッシュ（再実行時のOverpass負荷軽減。--no-cacheで無効化）
  let cache = {};
  if (args['no-cache'] === undefined && fs.existsSync(cachePath)) {
    try { cache = JSON.parse(fs.readFileSync(cachePath, 'utf8')); } catch (e) { cache = {}; }
  }
  const need = cands.filter(c => !cache[c.numId]);
  console.log('キャッシュ済み:', cands.length - need.length, '件 / 取得対象:', need.length, '件');

  let endpointUsed = null;
  for (let i = 0; i < need.length; i += BATCH) {
    const batch = need.slice(i, i + BATCH).map(c => c.numId);
    console.log(`  Overpass取得 ${i + 1}〜${Math.min(i + BATCH, need.length)} / ${need.length} …`);
    const { data, endpoint } = await overpassQuery(batch);
    endpointUsed = endpoint;
    for (const el of (data.elements || [])) {
      if (el.type === 'way' && Array.isArray(el.geometry)) {
        cache[el.id] = el.geometry.map(g => [g.lat, g.lon]);
      }
    }
    if (i + BATCH < need.length) await sleep(1000); // Overpassへの礼儀
  }
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, JSON.stringify(cache));

  const references = [];
  let missing = 0, nodeMismatch = 0;
  for (const c of cands) {
    const geom = cache[c.numId];
    if (!geom || geom.length < 3) { missing++; continue; }
    // OSMは閉リング（先頭=末尾）。ローカル側は開リングなので末尾を除いて比較する
    const g = (geom.length > 1 && geom[0][0] === geom[geom.length - 1][0] && geom[0][1] === geom[geom.length - 1][1])
      ? geom.slice(0, -1) : geom;
    if (g.length !== c.outer.length) nodeMismatch++; // 編集で頂点数が変化 → 重心はずれ得るが外れ値除去で弾く
    const [lat, lon] = centroid2(g, 0, 1);
    const [lx, lz] = centroid2(c.outer, 0, 1);
    references.push({
      name: (c.name || c.category) + ' ' + c.id,
      osmId: c.id,
      localX: +lx.toFixed(3), localZ: +lz.toFixed(3),
      lat: +lat.toFixed(8), lon: +lon.toFixed(8),
      nodeCount: g.length, localNodeCount: c.outer.length,
      source: 'OpenStreetMap way geometry via Overpass API (' + new Date().toISOString().slice(0, 10) + ')'
    });
  }
  if (references.length < 3) {
    console.error('有効な参照点が3件未満です。--limitを増やすか、landuse.jsonのway IDを確認してください。');
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    source: 'auto-fetched (no manual input)',
    endpoint: endpointUsed || 'cache',
    landuse: landusePath,
    matching: 'polygon centroid (order/rotation/reflection invariant)',
    references
  }, null, 1));
  console.log('参照点を自動生成:', references.length, '件 →', outPath);
  console.log('  取得失敗(way削除等):', missing, '/ 頂点数不一致(OSM編集の可能性、外れ値除去で処理):', nodeMismatch);
  console.log('次: node tools/estimate-origin.js --refs ' + outPath + ' --emit-config data/buildings/coordinate-config.json');
}

main().catch(e => { console.error('[fetch-osm-references] 失敗:', e.message); process.exit(1); });
