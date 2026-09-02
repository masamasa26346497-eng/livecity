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
//
// 特性:
//   - retry / exponential backoff / rate limit … tools/lib/overpass.js の runOverpassQuery に委譲
//   - request cache … data/raw/osaka-city/_cache/<layer>/tile_<tx>_<tz>.json
//   - resume … キャッシュがある(かつ壊れていない)タイルは再取得しない
//   - 途中失敗しても取得済みタイルは温存。失敗タイルだけ再実行すればよい
//   - 全タイル取得後、raw を id で dedup してマージ → data/raw/osaka-city/<layer>-osm.json

import fs from 'node:fs';
import path from 'node:path';
import { loadAreaConfig } from '../lib/area.js';
import { resolveProjectPath, toProjectRelativePath, isMainModule } from '../lib/paths.js';
import { createCityTileGrid } from '../lib/city-tile-grid.js';
import { runOverpassQuery } from '../lib/overpass.js';

const LAYERS = ['roads', 'parks', 'railways', 'waterways'];

function parseArgs(argv) {
  const a = { layer: null, area: 'osaka-city', tiles: null, cacheDir: null, timeout: 90, merge: true };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--layer') a.layer = argv[++i];
    else if (argv[i] === '--area') a.area = argv[++i];
    else if (argv[i] === '--tiles') a.tiles = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (argv[i] === '--cache-dir') a.cacheDir = argv[++i];
    else if (argv[i] === '--timeout') a.timeout = parseInt(argv[++i], 10) || 90;
    else if (argv[i] === '--no-merge') a.merge = false;
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

async function downloadLayer(layer, areaConfig, grid, opts) {
  const layerCfg = areaConfig.layers[layer];
  if (!layerCfg || !layerCfg.osmFilter) { console.error(`[stop] config に layers.${layer}.osmFilter がありません`); return { layer, status: 'no-config' }; }

  const cacheDir = resolveProjectPath(path.join(opts.cacheDir || path.join('data', 'raw', 'osaka-city', '_cache'), layer));
  fs.mkdirSync(cacheDir, { recursive: true });

  const tileList = opts.tiles
    ? opts.tiles.map((t) => { const [tx, tz] = t.split('_').map(Number); return { tx, tz }; })
    : grid.allTiles();

  console.log(`[${layer}] ${tileList.length} タイルを取得（cache: ${toProjectRelativePath(cacheDir)}）`);
  let fetched = 0, cached = 0, failed = 0;
  const responses = [];
  const failedTiles = [];

  for (const { tx, tz } of tileList) {
    const cacheFile = path.join(cacheDir, `tile_${tx}_${tz}.json`);
    if (isValidCache(cacheFile)) {
      cached++;
      responses.push(JSON.parse(fs.readFileSync(cacheFile, 'utf-8')));
      continue;
    }
    const bbox = grid.latLonBboxForTile(tx, tz);
    const q = buildTileQuery(layerCfg.osmFilter, bbox.str, opts.timeout);
    try {
      const data = await runOverpassQuery(q, {
        onRetry: (n, why) => console.log(`  [retry ${n}] tile ${tx}_${tz}: ${why}`),
      });
      fs.writeFileSync(cacheFile, JSON.stringify(data));
      responses.push(data);
      fetched++;
      console.log(`  [ok] tile ${tx}_${tz}: ${(data.elements || []).length} elements`);
    } catch (e) {
      failed++;
      failedTiles.push(`${tx}_${tz}`);
      console.error(`  [fail] tile ${tx}_${tz}: ${e.message}（このタイルだけ再実行で resume できます）`);
    }
  }

  if (opts.merge && failed === 0) {
    const merged = mergeRawElements(responses);
    const outPath = resolveProjectPath(path.join('data', 'raw', 'osaka-city', `${layer}-osm.json`));
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify({ elements: merged, _meta: { layer, tiles: tileList.length, mergedAt: new Date().toISOString() } }));
    console.log(`[${layer}] マージ完了: ${merged.length} elements → ${toProjectRelativePath(outPath)}`);
    console.log(`  次: node tools/build-city-layer-tiles.js --layer ${layer} --public`);
  } else if (failed > 0) {
    console.warn(`[${layer}] ${failed} タイル失敗（${failedTiles.join(', ')}）。全タイル成功後にマージされます。`);
  }
  return { layer, status: failed ? 'partial' : 'done', fetched, cached, failed, failedTiles };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const areaConfig = await loadAreaConfig(args.area);
  const grid = createCityTileGrid({
    bbox: areaConfig.bbox, projection: areaConfig.projection,
    tileSizeMeters: (areaConfig.tiling && areaConfig.tiling.tileSizeMeters) || 2000,
  });
  console.log(`grid: ${grid.tileSize}m / ${grid.cols}×${grid.rows} = ${grid.tileCount} tiles`);
  console.log('注意: 一括 bbox 取得はしません（タイル単位のみ）。');

  const layers = !args.layer || args.layer === 'all' ? LAYERS : [args.layer];
  const summary = [];
  for (const layer of layers) summary.push(await downloadLayer(layer, areaConfig, grid, args));
  console.log('\n=== サマリ ===');
  for (const s of summary) console.log(`  ${s.layer}: ${s.status} (fetched ${s.fetched || 0} / cache ${s.cached || 0} / failed ${s.failed || 0})`);
  if (summary.some((s) => s.failed)) process.exitCode = 1;
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => { console.error('取得でエラー:', e.message); process.exit(1); });
}
