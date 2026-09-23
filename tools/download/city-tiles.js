#!/usr/bin/env node
// tools/download/city-tiles.js
// P1-6: 大阪市24区の都市レイヤーを共通タイルグリッド単位で Overpass から取得する。
//   一括 bbox 取得はタイムアウト・メモリの両面で非現実的なため、必ずタイル単位で取得する。
//
// ネットワーク必須。Claude Code サンドボックスでは実行不可（fetch が失敗する）。
// ローカル PC / GitHub Actions で実行すること。手順は MAP24_P1-6_RUNBOOK.md 参照。
//
// 実行:
//   node tools/download/city-tiles.js --layer roads --area osaka-city            (全156タイル、resume対応)
//   node tools/download/city-tiles.js --layer all --area osaka-city
//   node tools/download/city-tiles.js --layer waterways --tiles -2_-1,0_-1,1_-1  (特定タイルのみ)
//   node tools/download/city-tiles.js --layer roads --endpoint https://overpass-api.de/api/interpreter
//   node tools/download/city-tiles.js --help
//
// 特性:
//   - 複数 Overpass endpoint failover … tools/lib/overpass-failover.js（429/5xx/timeout で早めに別endpointへ）
//   - endpoint health / cooldown（連続3回失敗で 60〜180秒休止）/ 429 Retry-After 尊重 / request 間隔
//   - request cache … data/raw/osaka-city/_cache/<layer>/tile_<tx>_<tz>.json
//   - resume … キャッシュがある(かつ壊れていない)タイルは絶対に再取得しない。失敗タイルのみ resume
//   - 全タイル取得後、raw を id で dedup してマージ → data/raw/osaka-city/<layer>-osm.json

import fs from 'node:fs';
import path from 'node:path';
import { loadAreaConfig } from '../lib/area.js';
import { resolveProjectPath, toProjectRelativePath, isMainModule } from '../lib/paths.js';
import { createCityTileGrid } from '../lib/city-tile-grid.js';
import { createOverpassClient, DEFAULT_ENDPOINTS } from '../lib/overpass-failover.js';

const LAYERS = ['roads', 'parks', 'railways', 'waterways'];

const HELP = `tools/download/city-tiles.js — 大阪市24区 都市レイヤーの Overpass タイル取得

使い方:
  node tools/download/city-tiles.js [オプション]

オプション:
  --layer <name>        roads | parks | railways | waterways | all（既定: all）
  --area <id>           エリア（既定: osaka-city）
  --tiles <tx_tz,...>   特定タイルのみ取得（例: --tiles -2_-1,0_-1）
  --endpoint <url>      使用する Overpass endpoint（複数指定可。省略時は失敗時に自動 failover）
                        既定: ${DEFAULT_ENDPOINTS.join(' , ')}
  --cache-dir <path>    request cache の場所（既定: data/raw/osaka-city/_cache）
  --timeout <sec>       Overpass-QL の [timeout:N]（既定: 90。HTTP timeout はこれ+30s）
  --print-query, --dry-run  ネットワークなしで tile/WGS84 bbox/query 全文/bytes/filters を表示して exit 0
  --smoke              全タイル前に「未取得の先頭1タイルだけ」取得（成功しなければ全取得へ進まない）
  --abort-after <n>   連続 n タイル失敗かつ成功 0 件で全取得を中断（既定 5。0 で無効）
  --no-merge            全タイル取得後の raw マージをしない
  --help, -h            この使い方を表示して終了（ネットワークアクセスなし）

例:
  node tools/download/city-tiles.js --layer roads --tiles -1_-5 --print-query   # まず query を確認
  node tools/download/city-tiles.js --layer roads --tiles -1_-5                 # 1タイル smoke（error-body 確認）
  node tools/download/city-tiles.js --layer all --area osaka-city               # 全取得（failover / resume）
`;

function parseArgs(argv) {
  const a = {
    layer: null, area: 'osaka-city', tiles: null, cacheDir: null, timeout: 90, merge: true,
    endpoints: [], help: false, printQuery: false, smoke: false, abortAfter: 5,
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--help' || k === '-h') a.help = true;
    else if (k === '--layer') a.layer = argv[++i];
    else if (k === '--area') a.area = argv[++i];
    else if (k === '--tiles') a.tiles = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (k === '--cache-dir') a.cacheDir = argv[++i];
    else if (k === '--timeout') a.timeout = parseInt(argv[++i], 10) || 90;
    else if (k === '--endpoint') a.endpoints.push(argv[++i]);
    else if (k === '--no-merge') a.merge = false;
    else if (k === '--print-query' || k === '--dry-run') a.printQuery = true;
    else if (k === '--smoke') a.smoke = true;                     // 全タイル前に1タイルだけ試す
    else if (k === '--abort-after') a.abortAfter = parseInt(argv[++i], 10) || 5;
  }
  return a;
}

/** config の osmFilter（"way[...];node[...]" のセミコロン区切り）と bbox から Overpass QL を組む。 */
export function buildTileQuery(osmFilter, bboxStr, timeoutSec) {
  const statements = String(osmFilter).split(';').map((s) => s.trim()).filter(Boolean)
    .map((s) => `  ${s}(${bboxStr});`).join('\n');
  return `[out:json][timeout:${timeoutSec}];\n(\n${statements}\n);\nout geom;`;
}

function isValidCache(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return j && Array.isArray(j.elements);
  } catch { return false; }
}

/** raw キャッシュ群を id で dedup してマージ。 */
export function mergeRawElements(tileResponses) {
  const seen = new Set();
  const out = [];
  for (const resp of tileResponses) {
    for (const el of (resp.elements || [])) {
      const key = `${el.type}/${el.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(el);
    }
  }
  return out;
}

function makeLogger() {
  return (evt) => {
    if (evt.type === 'fetch') console.log(`  [fetch] tile=${evt.tile} endpoint=${evt.endpoint} httpTimeout=${Math.round(evt.httpTimeoutMs / 1000)}s qlTimeout=${evt.qlTimeoutSec}s`);
    else if (evt.type === 'failover') console.log(`  [failover] from=${evt.from} to=${evt.to} reason=${evt.reason}`);
    else if (evt.type === 'retry') console.log(`  [retry] tile=${evt.tile} endpoint=${evt.endpoint} round=${evt.round} reason=${evt.reason}`);
    else if (evt.type === 'cooldown') console.log(`  [cooldown] endpoint=${evt.endpoint} ${Math.round(evt.ms / 1000)}s (連続失敗 ${evt.consecutiveFailures})`);
    else if (evt.type === 'ok') console.log(`  [ok] tile=${evt.tile} endpoint=${evt.endpoint}`);
    else if (evt.type === 'errorBody') {
      const b = (evt.body || '').replace(/\s+/g, ' ').trim().slice(0, 600);
      console.error(`  [error-body] tile=${evt.tile} endpoint=${evt.endpoint} status=${evt.status} httpMs=${Math.round(evt.httpMs || 0)}`);
      if (b) console.error(`             ${b}`);
    }
  };
}

// tile 用の Overpass QL を組み立てて内訳も返す（--print-query 用に共通化）。
export function tileQueryInfo(layer, areaConfig, grid, tx, tz, timeoutSec) {
  const filter = areaConfig.layers[layer].osmFilter;
  const bbox = grid.latLonBboxForTile(tx, tz);
  const q = buildTileQuery(filter, bbox.str, timeoutSec);
  return {
    tile: `${tx}_${tz}`,
    localBounds: grid.tileBounds(tx, tz),
    wgs84Bbox: { south: bbox.south, west: bbox.west, north: bbox.north, east: bbox.east },
    bboxOrder: 'south,west,north,east',
    bboxStr: bbox.str,
    bboxOrderOk: bbox.south < bbox.north && bbox.west < bbox.east,
    filters: String(filter).split(';').map((s) => s.trim()).filter(Boolean),
    query: q,
    queryBytes: Buffer.byteLength(q, 'utf-8'),
    qlTimeoutSec: timeoutSec,
    recursiveExpansion: /\(\._;>;\)|\(\._;<;\)/.test(q),
    outMode: (q.match(/\bout\s+([a-z ]+);/) || [])[1] || 'unknown',
  };
}

export async function downloadLayer(layer, areaConfig, grid, opts, client) {
  const layerCfg = areaConfig.layers[layer];
  if (!layerCfg || !layerCfg.osmFilter) { console.error(`[stop] config に layers.${layer}.osmFilter がありません`); return { layer, status: 'no-config' }; }

  const cacheDir = resolveProjectPath(path.join(opts.cacheDir || path.join('data', 'raw', 'osaka-city', '_cache'), layer));
  fs.mkdirSync(cacheDir, { recursive: true });

  let tileList = opts.tiles
    ? opts.tiles.map((t) => { const [tx, tz] = t.split('_').map(Number); return { tx, tz }; })
    : grid.allTiles();
  // --smoke: 全タイル前に最初の1タイルだけ（先頭が cache 済みなら未取得の先頭を選ぶ）
  if (opts.smoke && tileList.length > 1) {
    const firstUncached = tileList.find(({ tx, tz }) => !isValidCache(path.join(cacheDir, `tile_${tx}_${tz}.json`))) || tileList[0];
    tileList = [firstUncached];
    console.log(`[${layer}] --smoke: tile ${firstUncached.tx}_${firstUncached.tz} だけ試します（成功したら --smoke を外して全取得）`);
  }

  console.log(`[${layer}] ${tileList.length} タイルを取得（cache: ${toProjectRelativePath(cacheDir)}）`);
  let downloaded = 0, cached = 0, failed = 0;
  const responses = [];
  const failedTiles = [];
  let consecutiveFail = 0;
  let aborted = false;

  for (const { tx, tz } of tileList) {
    const label = `${tx}_${tz}`;
    const cacheFile = path.join(cacheDir, `tile_${tx}_${tz}.json`);
    if (isValidCache(cacheFile)) {
      cached++;
      console.log(`  [cache] tile=${label}（既取得。再取得しない）`);
      responses.push(JSON.parse(fs.readFileSync(cacheFile, 'utf-8')));
      continue;
    }
    const bbox = grid.latLonBboxForTile(tx, tz);
    const q = buildTileQuery(layerCfg.osmFilter, bbox.str, opts.timeout);
    try {
      const data = await client.run(q, label);
      fs.writeFileSync(cacheFile, JSON.stringify(data));
      responses.push(data);
      downloaded++;
      consecutiveFail = 0;
      console.log(`  [done] tile=${label}: ${(data.elements || []).length} elements`);
    } catch (e) {
      failed++;
      consecutiveFail++;
      failedTiles.push(label);
      console.error(`  [fail] tile=${label}: ${e.message}（このタイルだけ --tiles ${label} で resume 可）`);
      // 連続失敗が閾値に達したら全156タイルを回さず中断する（サーバー障害中に churn しない）。
      if (opts.abortAfter > 0 && consecutiveFail >= opts.abortAfter && downloaded === 0) {
        aborted = true;
        console.error(`\n[abort] ${consecutiveFail} タイル連続失敗・成功 0 件。全タイル取得を中断します。`);
        console.error(`  まず 1 タイルで診断してください:`);
        console.error(`    node tools/download/city-tiles.js --layer ${layer} --tiles ${label} --print-query`);
        console.error(`    node tools/download/city-tiles.js --layer ${layer} --tiles ${label}   # error-body を確認`);
        console.error(`  endpoint 障害なら時間をおくか --endpoint で別サーバーを指定してください。`);
        break;
      }
    }
  }

  if (opts.merge && failed === 0 && !aborted) {
    const merged = mergeRawElements(responses);
    const outPath = resolveProjectPath(path.join('data', 'raw', 'osaka-city', `${layer}-osm.json`));
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify({ elements: merged, _meta: { layer, tiles: tileList.length, mergedAt: new Date().toISOString() } }));
    console.log(`[${layer}] マージ完了: ${merged.length} elements → ${toProjectRelativePath(outPath)}`);
    console.log(`  次: node tools/build-city-layer-tiles.js --layer ${layer} --public`);
  } else if (failed > 0) {
    console.warn(`[${layer}] ${failed} タイル失敗（${failedTiles.join(', ')}）。全タイル成功後にマージされます。`);
  }
  return { layer, status: aborted ? 'aborted' : (failed ? 'partial' : 'done'), downloaded, cached, failed, failedTiles, aborted };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(HELP); process.exit(0); }

  const areaConfig = await loadAreaConfig(args.area);
  const grid = createCityTileGrid({
    bbox: areaConfig.bbox, projection: areaConfig.projection,
    tileSizeMeters: (areaConfig.tiling && areaConfig.tiling.tileSizeMeters) || 2000,
  });

  const layers = !args.layer || args.layer === 'all' ? LAYERS : [args.layer];

  // ── --print-query / --dry-run: ネットワークアクセスせず query を表示して exit 0 ──
  if (args.printQuery) {
    const tileArg = (args.tiles && args.tiles[0]) || `${grid.originTx + Math.floor(grid.cols / 2)}_${grid.originTz + Math.floor(grid.rows / 2)}`;
    const [tx, tz] = tileArg.split('_').map(Number);
    for (const layer of layers) {
      if (!areaConfig.layers[layer] || !areaConfig.layers[layer].osmFilter) { console.log(`(${layer}: config に osmFilter なし)`); continue; }
      const info = tileQueryInfo(layer, areaConfig, grid, tx, tz, args.timeout);
      console.log(`\n=== ${layer} / tile ${info.tile} ===`);
      console.log(`local bounds (znorth-neg-v1): ${JSON.stringify(info.localBounds)}`);
      console.log(`WGS84 bbox: ${JSON.stringify(info.wgs84Bbox)}`);
      console.log(`bbox order: ${info.bboxOrder}  → "${info.bboxStr}"  (order OK: ${info.bboxOrderOk})`);
      console.log(`filters (${info.filters.length}): ${JSON.stringify(info.filters)}`);
      console.log(`QL timeout: ${info.qlTimeoutSec}s   recursive expansion (._;>;): ${info.recursiveExpansion}   out: ${info.outMode}`);
      console.log(`query (${info.queryBytes} bytes):`);
      console.log(info.query);
    }
    process.exit(0);
  }

  const client = createOverpassClient({
    endpoints: args.endpoints.length ? args.endpoints : DEFAULT_ENDPOINTS,
    onEvent: makeLogger(),
    qlTimeoutSec: args.timeout,   // HTTP timeout は QL timeout + 30s（overpass-failover.js）
  });
  console.log(`grid: ${grid.tileSize}m / ${grid.cols}×${grid.rows} = ${grid.tileCount} tiles`);
  console.log(`endpoints: ${client.endpoints.join(' , ')}（失敗時 failover）`);
  console.log(`QL timeout: ${args.timeout}s / HTTP timeout: ${args.timeout + 30}s`);
  console.log('注意: 一括 bbox 取得はしません（タイル単位のみ）。');

  const summary = [];
  for (const layer of layers) summary.push(await downloadLayer(layer, areaConfig, grid, args, client));

  console.log('\n[summary]');
  let tCached = 0, tDl = 0, tFailed = 0;
  for (const s of summary) {
    console.log(`  ${s.layer}: ${s.status} (downloaded ${s.downloaded || 0} / cached ${s.cached || 0} / failed ${s.failed || 0})`);
    tCached += s.cached || 0; tDl += s.downloaded || 0; tFailed += s.failed || 0;
  }
  console.log(`  cached=${tCached}  downloaded=${tDl}  failed=${tFailed}`);
  console.log(`  endpointFailures=${JSON.stringify(client.healthSnapshot())}`);
  if (tFailed > 0) process.exitCode = 1;
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => { console.error('取得でエラー:', e.message); process.exit(1); });
}
