#!/usr/bin/env node
// ══════════════════════════════════════════════════════════════
// tools/split-building-tiles.js (v2: 複数区対応)
// ══════════════════════════════════════════════════════════════
// 建物データを都市共通のグローバルタイルグリッド(既定500m・原点(0,0))へ分割し、
// BuildingTileLayer v2 のデータセット形式で出力する。区専用のハードコードは持たない。
//
// 出力:
//   {output}/manifest.json            … 区manifest（件数・タイル一覧・bounds・座標系・出典・LOD・版）
//   {output}/index.json               … 旧v1互換エイリアス
//   {output}/tile_{tx}_{tz}.json      … タイル本体
//   {root}/manifest.json              … 上位manifest（dataset一覧へ本datasetを追記/更新）
//
// 入力(どちらか):
//   --html  <path>  正規版HTMLの const BLDGS = [...] を抽出（既存埋め込みからの移行用）
//   --input <path>  建物JSON配列ファイル [{id, fp:[[x,z],...], z0, dz, h, usage, ulabel, ward, town}, ...]
//                   ※座標は「既存データセットと同一原点・同一縮尺の都市共通ローカルXZ(m)」であること。
//                     区ごとの原点変更・縮尺変更・手動オフセットは禁止（区境が接続しなくなる）。
//
// 実行例:
//   node tools/split-building-tiles.js --html public/osaka_3d_buildings.html \
//     --dataset osaka-sumiyoshi --ward 住吉区 --output public/data/buildings/osaka-sumiyoshi
//   node tools/split-building-tiles.js --input data/source/osaka-higashisumiyoshi-buildings.json \
//     --dataset osaka-higashisumiyoshi --ward 東住吉区 --output public/data/buildings/osaka-higashisumiyoshi

// ── ES Module形式（package.jsonの "type": "module" に対応）──
// v3: 低メモリ化。--jsonl-dir でconvertのチャンクをストリーム読みし、タイル別の一時ファイルへ
//     追記していく（全建物を配列に載せない）。従来の --input <JSON配列> / --html も互換維持。
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { safeReplace } from './lib/path-config.js';
import { IdStore } from './lib/id-store.js';

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k.startsWith('--')) { a[k.slice(2)] = argv[i + 1]; i++; }
  }
  return a;
}

// 建物1件をタイルへ振り分ける共通ロジック。重心→タイル座標。無効・重複を弾く。
function classify(b, tileSize, seen, bounds) {
  if (!b || !b.id || !Array.isArray(b.fp) || b.fp.length < 3) return { skip: 'invalid' };
  if (seen.has(b.id)) return { skip: 'dup' };
  let sx = 0, sz = 0;
  for (const p of b.fp) {
    if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) return { skip: 'invalid' };
    sx += p[0]; sz += p[1];
    if (p[0] < bounds.minX) bounds.minX = p[0]; if (p[0] > bounds.maxX) bounds.maxX = p[0];
    if (p[1] < bounds.minZ) bounds.minZ = p[1]; if (p[1] > bounds.maxZ) bounds.maxZ = p[1];
  }
  seen.add(b.id);
  const tx = Math.floor((sx / b.fp.length) / tileSize);
  const tz = Math.floor((sz / b.fp.length) / tileSize);
  return { tx, tz, key: tx + '_' + tz };
}

// 低メモリ経路: JSONLチャンク群 → タイル別一時JSONL → タイルJSON統合。全建物を配列に載せない。
async function mainStreaming(args) {
  const { dataset, ward, output } = args;
  const wardCode = args['ward-code'] ? String(args['ward-code']) : null;
  const tileSize = parseInt(args['tile-size'] || '500', 10);
  const root = args.root || (output ? path.dirname(output) : null);
  const jsonlDir = args['jsonl-dir'];

  // 入力JSONLファイル一覧（convertのchunks/*.jsonl、または単一JSONL）
  let jsonlFiles = [];
  if (fs.statSync(jsonlDir).isDirectory()) {
    jsonlFiles = fs.readdirSync(jsonlDir).filter(f => f.endsWith('.jsonl')).map(f => path.join(jsonlDir, f)).sort();
  } else jsonlFiles = [jsonlDir];
  if (!jsonlFiles.length) { console.error('JSONLが見つかりません:', jsonlDir); process.exit(1); }

  fs.mkdirSync(output, { recursive: true });
  const tmpTileDir = path.join(output, '.tmp-tiles');
  fs.rmSync(tmpTileDir, { recursive: true, force: true });
  fs.mkdirSync(tmpTileDir, { recursive: true });

  // タイル別WriteStreamをLRUで管理（開きっぱなしのfd数に上限）
  const MAX_OPEN = 64;
  const openStreams = new Map(); // key -> {stream}
  const tileCounts = new Map();  // key -> 累計件数（全タイル）
  const closing = new Map();     // key -> Promise（追い出し中の閉じ完了。再オープン前に待つ）
  const lru = [];
  // 追い出し時は stream.end() の完了をawaitしてから削除。同一タイルの再オープンは
  // closing[key] を待ってから行い、追記の順序が崩れないようにする。
  const streamFor = async (key) => {
    // このキーが追い出し中なら、閉じ切るまで待つ（順序保証）
    if (closing.has(key)) { await closing.get(key); closing.delete(key); }
    let e = openStreams.get(key);
    if (e) { const i = lru.indexOf(key); if (i >= 0) lru.splice(i, 1); lru.push(key); return e.stream; }
    if (openStreams.size >= MAX_OPEN) {
      const evict = lru.shift();
      const ev = openStreams.get(evict);
      if (ev) {
        openStreams.delete(evict);
        const p = new Promise(r => ev.stream.end(r)); // end完了を必ず待てるようにする
        closing.set(evict, p);
        await p; closing.delete(evict);
      }
    }
    const p = path.join(tmpTileDir, key + '.jsonl');
    const stream = fs.createWriteStream(p, { flags: 'a' }); // 追記（再オープンでも末尾に続く）
    openStreams.set(key, { stream });
    lru.push(key);
    return stream;
  };

  const seen = new IdStore({ maxMemory: 2_000_000, dir: path.join(tmpTileDir, '.idindex') });
  const bounds = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
  let invalid = 0, dup = 0, total = 0;
  let peakHeap = 0, peakRss = 0;
  const touch = () => { const m = process.memoryUsage(); if (m.heapUsed > peakHeap) peakHeap = m.heapUsed; if (m.rss > peakRss) peakRss = m.rss; };

  for (const jf of jsonlFiles) {
    const rl = readline.createInterface({ input: fs.createReadStream(jf), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line) continue;
      let b; try { b = JSON.parse(line); } catch (e) { invalid++; continue; }
      const c = classify(b, tileSize, seen, bounds);
      if (c.skip) { if (c.skip === 'dup') dup++; else invalid++; continue; }
      const s = await streamFor(c.key);
      const ok = s.write(line + '\n');
      if (!ok) await new Promise(r => s.once('drain', r));
      tileCounts.set(c.key, (tileCounts.get(c.key) || 0) + 1);
      total++;
    }
    touch();
  }
  // 全ストリームを閉じる
  for (const { stream } of openStreams.values()) await new Promise(r => stream.end(r));
  openStreams.clear();

  // タイル別一時JSONL → タイルJSON（tile_{tx}_{tz}.json）へ統合
  const tileList = [];
  let sum = 0, totalBytes = 0, maxFileBytes = 0;
  const keys = [...tileCounts.keys()].sort((a, b) => {
    const [ax, az] = a.split('_').map(Number), [bx, bz] = b.split('_').map(Number);
    return ax - bx || az - bz;
  });
  for (const key of keys) {
    const [tx, tz] = key.split('_').map(Number);
    const src = path.join(tmpTileDir, key + '.jsonl');
    const file = `tile_${tx}_${tz}.json`;
    const outPath = path.join(output, file);
    const ws = fs.createWriteStream(outPath + '.tmp');
    await new Promise(r => ws.write(`{"tx":${tx},"tz":${tz},"tileSize":${tileSize},"lod":1,"count":${tileCounts.get(key)},"buildings":[`, r));
    let first = true, cnt = 0;
    const rl = readline.createInterface({ input: fs.createReadStream(src), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line) continue;
      await new Promise((res, rej) => ws.write((first ? '' : ',') + line, e => e ? rej(e) : res()));
      first = false; cnt++;
    }
    await new Promise(r => ws.write(']}', r));
    await new Promise(r => ws.end(r));
    // 低メモリ検証: 大サイズは全文パースせず、書込件数・先頭末尾・角括弧で検証。小サイズのみ完全パース。
    const tmpPath = outPath + '.tmp';
    const sz = fs.statSync(tmpPath).size;
    const fd = fs.openSync(tmpPath, 'r');
    const head = Buffer.alloc(1); fs.readSync(fd, head, 0, 1, 0);
    const tail = Buffer.alloc(2); fs.readSync(fd, tail, 0, 2, Math.max(0, sz - 2));
    fs.closeSync(fd);
    if (head.toString() !== '{' || !tail.toString().endsWith('}')) throw new Error('タイルJSON構造が不正: ' + file);
    if (cnt !== tileCounts.get(key)) throw new Error('タイル件数不一致: ' + file + ' ' + cnt + '!=' + tileCounts.get(key));
    const TILE_FULL_PARSE_LIMIT = 16 * 1024 * 1024; // 16MB以下は完全パース
    if (sz <= TILE_FULL_PARSE_LIMIT) {
      const parsed = JSON.parse(fs.readFileSync(tmpPath, 'utf8'));
      if (!Array.isArray(parsed.buildings) || parsed.buildings.length !== cnt) throw new Error('タイル検証失敗: ' + file);
    }
    safeReplace(tmpPath, outPath);
    const body = { length: sz }; // 以降のサイズ集計用（全文保持しない）
    totalBytes += body.length; if (body.length > maxFileBytes) maxFileBytes = body.length;
    tileList.push({ tx, tz, file, count: cnt });
    sum += cnt;
    touch();
  }
  fs.rmSync(tmpTileDir, { recursive: true, force: true });

  writeManifests({ output, root, dataset, ward, wardCode, tileSize, tileList, sum,
    tileCount: keys.length, bounds, invalid, dup });

  const fmtMB = b => (b / 1024 / 1024).toFixed(0);
  console.log('入力建物件数:', total + invalid + dup, '(JSONLストリーム)');
  console.log('出力建物件数:', sum, '/ 無効除外:', invalid, '/ ID重複除外:', dup);
  console.log('タイル数:', keys.length, '/ 最大同時オープンStream上限:', MAX_OPEN);
  console.log('総JSONサイズ:', (totalBytes / 1024 / 1024).toFixed(2) + 'MB / 最大タイル:', (maxFileBytes / 1024).toFixed(0) + 'KB');
  console.log('peak heapUsed=' + fmtMB(peakHeap) + 'MB peak rss=' + fmtMB(peakRss) + 'MB');
  if (sum !== [...tileCounts.values()].reduce((a, b) => a + b, 0))
    console.warn('  ⚠ タイル統合後件数とタイル別カウントが不一致');
}

// manifest類の生成（従来と同一フォーマット）
function writeManifests({ output, root, dataset, ward, wardCode, tileSize, tileList, sum, tileCount, bounds, invalid, dup }) {
  const manifest = {
    version: 1, id: dataset, city: 'osaka', ward: ward || '', wardCode: wardCode || null,
    coordinateSystem: 'city-shared local XZ meters (same origin/scale as osaka-sumiyoshi embedded BLDGS; converted upstream from PLATEAU CityGML)',
    origin: { x: 0, z: 0 }, tileSize, lod: 1,
    generatedAt: new Date().toISOString(), source: 'PLATEAU / CityGML',
    attribution: '国土交通省 Project PLATEAU',
    totalBuildings: sum, tileCount,
    bounds: { minX: bounds.minX, maxX: bounds.maxX, minZ: bounds.minZ, maxZ: bounds.maxZ },
    invalidSkipped: invalid, duplicateSkipped: dup, tiles: tileList
  };
  const writeAtomic = (p, text) => { fs.writeFileSync(p + '.tmp', text); safeReplace(p + '.tmp', p); };
  writeAtomic(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 1));
  writeAtomic(path.join(output, 'index.json'), JSON.stringify(manifest, null, 1));
  if (root) {
    fs.mkdirSync(root, { recursive: true });
    const rootPath = path.join(root, 'manifest.json');
    let rootManifest = { version: 1, city: 'osaka', coordinateSystem: manifest.coordinateSystem, tileSize, origin: { x: 0, z: 0 }, datasets: [] };
    if (fs.existsSync(rootPath)) { try { rootManifest = JSON.parse(fs.readFileSync(rootPath, 'utf8')); } catch (e) {} }
    rootManifest.datasets = (rootManifest.datasets || []).filter(d => d.id !== dataset);
    rootManifest.datasets.push({ id: dataset, ward: ward || '', wardCode: wardCode || null, manifest: `./${dataset}/manifest.json`, enabled: true, buildings: sum, tiles: tileCount });
    rootManifest.datasets.sort((a, b) => a.id.localeCompare(b.id));
    writeAtomic(rootPath, JSON.stringify(rootManifest, null, 1));
    console.log('上位manifest更新:', rootPath);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { dataset, ward, output } = args;
  const tileSize = parseInt(args['tile-size'] || '500', 10);
  const root = args.root || (output ? path.dirname(output) : null);
  if (!dataset || !output || (!args.html && !args.input && !args['jsonl-dir'])) {
    console.error('usage: node tools/split-building-tiles.js (--jsonl-dir <chunks> | --input <json> | --html <html>) --dataset <id> --ward <区名> --output <dir> [--tile-size 500] [--root <buildingsルート>]');
    console.error('  --jsonl-dir: convertのチャンク(.jsonl)をストリーム処理（低メモリ・推奨）');
    console.error('  --input    : 従来の建物JSON配列（後方互換）');
    console.error('  --html     : HTML埋め込みBLDGS抽出（移行用）');
    process.exit(1);
  }
  // 低メモリ経路（jsonl-dir）があれば優先
  if (args['jsonl-dir']) { await mainStreaming(args); return; }

  // 入力読み込み
  let buildings;
  if (args.input) {
    buildings = JSON.parse(fs.readFileSync(args.input, 'utf8'));
    if (!Array.isArray(buildings)) { console.error('--input はJSON配列である必要があります'); process.exit(1); }
  } else {
    const html = fs.readFileSync(args.html, 'utf8');
    const line = html.split('\n').find(l => l.startsWith('const BLDGS = '));
    if (!line) { console.error('const BLDGS = ... が見つかりません'); process.exit(1); }
    eval(line.replace('const BLDGS = ', 'buildings = ').replace(/;\s*$/, ';'));
  }
  const inputCount = buildings.length;

  // タイル割当（重心による1建物1タイル・入力内のID重複除外）
  const tiles = new Map();
  const seen = new Set();
  let invalid = 0, dup = 0;
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const b of buildings) {
    if (!b || !b.id || !Array.isArray(b.fp) || b.fp.length < 3) { invalid++; continue; }
    if (seen.has(b.id)) { dup++; continue; }
    let sx = 0, sz = 0, bad = false;
    for (const p of b.fp) {
      if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) { bad = true; break; }
      sx += p[0]; sz += p[1];
      if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0];
      if (p[1] < minZ) minZ = p[1]; if (p[1] > maxZ) maxZ = p[1];
    }
    if (bad) { invalid++; continue; }
    seen.add(b.id);
    const tx = Math.floor((sx / b.fp.length) / tileSize);
    const tz = Math.floor((sz / b.fp.length) / tileSize);
    const key = tx + '_' + tz;
    let t = tiles.get(key);
    if (!t) { t = { tx, tz, buildings: [] }; tiles.set(key, t); }
    t.buildings.push(b);
  }

  // 出力
  fs.mkdirSync(output, { recursive: true });
  const tileList = [];
  let sum = 0, totalBytes = 0, maxFileBytes = 0;
  for (const t of [...tiles.values()].sort((a, b) => a.tx - b.tx || a.tz - b.tz)) {
    const file = `tile_${t.tx}_${t.tz}.json`;
    const body = JSON.stringify({ tx: t.tx, tz: t.tz, tileSize, lod: 1, count: t.buildings.length, buildings: t.buildings });
    fs.writeFileSync(path.join(output, file), body);
    totalBytes += body.length;
    if (body.length > maxFileBytes) maxFileBytes = body.length;
    tileList.push({ tx: t.tx, tz: t.tz, file, count: t.buildings.length });
    sum += t.buildings.length;
  }
  const txs = tileList.map(t => t.tx), tzs = tileList.map(t => t.tz);
  const manifest = {
    version: 1,
    id: dataset,
    city: 'osaka',
    ward: ward || '',
    coordinateSystem: 'city-shared local XZ meters (same origin/scale as osaka-sumiyoshi embedded BLDGS; converted upstream from PLATEAU CityGML)',
    origin: { x: 0, z: 0 },
    tileSize,
    lod: 1,
    generatedAt: new Date().toISOString(),
    source: 'PLATEAU / CityGML',
    attribution: '国土交通省 Project PLATEAU',
    totalBuildings: sum,
    tileCount: tiles.size,
    bounds: { minX, maxX, minZ, maxZ },
    invalidSkipped: invalid,
    duplicateSkipped: dup,
    tiles: tileList
  };
  fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 1));
  fs.writeFileSync(path.join(output, 'index.json'), JSON.stringify(manifest, null, 1)); // v1互換エイリアス

  // 上位manifestの追記/更新
  if (root) {
    fs.mkdirSync(root, { recursive: true });
    const rootPath = path.join(root, 'manifest.json');
    let rootManifest = { version: 1, city: 'osaka',
      coordinateSystem: manifest.coordinateSystem, tileSize, origin: { x: 0, z: 0 }, datasets: [] };
    if (fs.existsSync(rootPath)) {
      try { rootManifest = JSON.parse(fs.readFileSync(rootPath, 'utf8')); } catch (e) { /* 壊れていれば再生成 */ }
    }
    rootManifest.datasets = (rootManifest.datasets || []).filter(d => d.id !== dataset);
    rootManifest.datasets.push({
      id: dataset, ward: ward || '', manifest: `./${dataset}/manifest.json`,
      enabled: true, buildings: sum, tiles: tiles.size
    });
    rootManifest.datasets.sort((a, b) => a.id.localeCompare(b.id));
    fs.writeFileSync(rootPath, JSON.stringify(rootManifest, null, 1));
    console.log('上位manifest更新:', rootPath);
  }

  // 統計
  const counts = tileList.map(t => t.count);
  console.log('入力建物件数:', inputCount);
  console.log('出力建物件数:', sum, '/ 無効除外:', invalid, '/ ID重複除外:', dup);
  console.log('タイル数:', tiles.size, '/ タイル座標範囲: tx[' + Math.min(...txs) + ',' + Math.max(...txs) + '] tz[' + Math.min(...tzs) + ',' + Math.max(...tzs) + ']');
  console.log('1タイル建物: 最大', Math.max(...counts), '/ 平均', Math.round(sum / tiles.size));
  console.log('総JSONサイズ:', (totalBytes / 1024 / 1024).toFixed(2) + 'MB', '/ 最大タイル:', (maxFileBytes / 1024).toFixed(0) + 'KB');
  console.log('manifest出力先:', path.join(output, 'manifest.json'));
}

main().catch(e => { console.error("[split-building-tiles] 失敗:", e.message); process.exit(1); });
