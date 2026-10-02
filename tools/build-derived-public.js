#!/usr/bin/env node
// tools/build-derived-public.js
// [Mission 31G] Derived tiles を browser runtime が fetch できる public/ へ配置する。
//   far / mid / near のみ（ultra-near は near と tolM 以外同じで容量 2 倍のため runtime では使わない）。
//   出力: public/map-data/osaka-city/derived/{far,mid,near}/<layer>/{manifest.json, tile_*.json}
//         public/map-data/osaka-city/derived/manifest.json（top index）
//         public/map-data/osaka-city/derived/rail-stations.json
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, toProjectRelativePath, isMainModule } from './lib/paths.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const SRC = P('data', 'processed', 'osaka-city', 'derived');
const DST = P('public', 'map-data', 'osaka-city', 'derived');
const RAIL_STATIONS = P('data', 'processed', 'osaka-city', 'canonical', 'rail', 'stations.json');
const REPORT = P('data', 'reports', 'derived-public-build.json');

const LODS = ['far', 'mid', 'near'];
const LAYERS = ['water', 'roads', 'buildings', 'parks', 'rail'];

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  let files = 0, bytes = 0;
  for (const f of fs.readdirSync(src)) {
    const sp = path.join(src, f), dp = path.join(dst, f);
    const st = fs.statSync(sp);
    if (st.isDirectory()) { const r = copyDir(sp, dp); files += r.files; bytes += r.bytes; }
    else { fs.copyFileSync(sp, dp); files++; bytes += st.size; }
  }
  return { files, bytes };
}

async function main() {
  if (!fs.existsSync(path.join(SRC, 'manifest.json'))) { console.error('[derived-public] derived が無い。先に build-derived-geometry.js'); process.exit(1); }
  fs.rmSync(DST, { recursive: true, force: true });
  fs.mkdirSync(DST, { recursive: true });

  const perLodLayer = {};
  let totalFiles = 0, totalBytes = 0;
  for (const lod of LODS) {
    for (const layer of LAYERS) {
      const s = path.join(SRC, lod, layer);
      if (!fs.existsSync(s)) continue;
      const r = copyDir(s, path.join(DST, lod, layer));
      perLodLayer[`${lod}/${layer}`] = { files: r.files, bytes: r.bytes };
      totalFiles += r.files; totalBytes += r.bytes;
    }
  }

  // top index（runtime が最初に読む。far manifest だけ startup で parse）
  const srcTop = JSON.parse(fs.readFileSync(path.join(SRC, 'manifest.json'), 'utf-8'));
  const index = {
    version: 1, kind: 'derived-runtime-index', coordinateConvention: 'znorth-neg-v1',
    generatedAt: new Date().toISOString(),
    lods: LODS,
    lodTolerances: { far: srcTop.lodTolerances.far, mid: srcTop.lodTolerances.mid, near: srcTop.lodTolerances.near },
    tileSizes: srcTop.tileSizes,
    layers: LAYERS,
    // runtime が distance→lod を決める境界（既存 Mission13/24/26 の band に整合）
    lodDistanceBands: { farM: 9000, midM: 3500, nearM: 1200 },
    perLayerLod: Object.fromEntries(LODS.map((lod) => {
      const byLayer = Object.fromEntries(LAYERS.map((l) => {
        const mp = path.join(SRC, lod, l, 'manifest.json');
        if (!fs.existsSync(mp)) return [l, null];
        const m = JSON.parse(fs.readFileSync(mp, 'utf-8'));
        return [l, { featureCount: m.featureCount, tiles: (m.tiles || []).length, tileSize: m.tileSize, toleranceM: m.simplificationToleranceM }];
      }));
      return [lod, byLayer];
    })),
  };
  fs.writeFileSync(path.join(DST, 'manifest.json'), JSON.stringify(index));

  // rail stations（§17: station label は別 payload）
  if (fs.existsSync(RAIL_STATIONS)) fs.copyFileSync(RAIL_STATIONS, path.join(DST, 'rail-stations.json'));

  // [Mission 31G-FIX6] building placement policy（road/water 上の建物の render visibility）。
  //   DISPLAY 既定・tile には SUPPRESS/REVIEW/EXEMPT のみ。runtime は buildings tile と同じ tx/tz で lookup。
  const PLACEMENT_SRC = P('data', 'processed', 'osaka-city', 'derived', 'building-placement');
  let placementFiles = 0;
  if (fs.existsSync(path.join(PLACEMENT_SRC, 'manifest.json'))) {
    const r = copyDir(PLACEMENT_SRC, path.join(DST, 'building-placement'));
    placementFiles = r.files; totalFiles += r.files; totalBytes += r.bytes;
    perLodLayer['building-placement'] = { files: r.files, bytes: r.bytes };
  }

  // [Mission 31G-FIX9] Ward Mode で一区の全建物 tile を確定するインデックス（runtime が Ward 選択時に全 tile pin）。
  const WARD_IDX_SRC = P('data', 'processed', 'osaka-city', 'derived', 'building-ward-index.json');
  if (fs.existsSync(WARD_IDX_SRC)) {
    const st = fs.statSync(WARD_IDX_SRC);
    fs.copyFileSync(WARD_IDX_SRC, path.join(DST, 'building-ward-index.json'));
    totalFiles++; totalBytes += st.size;
    perLodLayer['building-ward-index'] = { files: 1, bytes: st.size };
  }

  // [Mission 31G-FIX12] Road Visual Surface classMap（Canonical Road polygon ≠ 描画する道路面）。
  //   runtime は primary 以外の renderClass の道路面を薄く/低く描く。source geometry は不変。
  //   FIX12 版は FIX13 の refined-road-surface.json が無い場合の fallback として配信し続ける。
  const ROAD_RC_SRC = P('data', 'processed', 'osaka-city', 'derived', 'road-render-class.json');
  if (fs.existsSync(ROAD_RC_SRC)) {
    const st = fs.statSync(ROAD_RC_SRC);
    fs.copyFileSync(ROAD_RC_SRC, path.join(DST, 'road-render-class.json'));
    totalFiles++; totalBytes += st.size;
    perLodLayer['road-render-class'] = { files: 1, bytes: st.size };
  }

  // [Mission 31G-FIX13] Road Visual Surface 精密化（CARRIAGEWAY/SIDEWALK/MEDIAN 等 §17 taxonomy）。
  //   runtime はこちらを優先 fetch。source geometry / 建物 x/z は不変（precompute のみ）。
  const REFINED_RC_SRC = P('data', 'processed', 'osaka-city', 'derived', 'refined-road-surface.json');
  if (fs.existsSync(REFINED_RC_SRC)) {
    const st = fs.statSync(REFINED_RC_SRC);
    fs.copyFileSync(REFINED_RC_SRC, path.join(DST, 'refined-road-surface.json'));
    totalFiles++; totalBytes += st.size;
    perLodLayer['refined-road-surface'] = { files: 1, bytes: st.size };
  }

  // [Mission 31G-ALIGNMENT-RESET §8/§27/§31] GSI Road Edge を道路境界の authoritative outline として
  //   常時配信する（開発用サンプルオーバーレイとは別物）。tile化済み(500mグリッド・derived/gsi-road-edge/)
  //   のため city-wide でも camera 近傍タイルだけ fetch すればよく、全大阪一括ロードにはならない。
  const GSI_TILES_SRC = P('data', 'processed', 'osaka-city', 'derived', 'gsi-road-edge');
  if (fs.existsSync(path.join(GSI_TILES_SRC, 'manifest.json'))) {
    const r = copyDir(GSI_TILES_SRC, path.join(DST, 'gsi-road-edge'));
    totalFiles += r.files; totalBytes += r.bytes;
    perLodLayer['gsi-road-edge'] = { files: r.files, bytes: r.bytes };
  }

  // [Mission 32B §23/§36] Visual Building Geometry（GSI polygon優先+PLATEAU fallback）を
  //   opt-in devトグル用に配信する。デフォルトruntimeはCanonical near/buildingsのまま
  //   （§0: データ品質の懸念が実測で判明したため、今回はdefault採用しない。§39参照）。
  const VB_SRC = P('data', 'processed', 'osaka-city', 'derived-visual-buildings');
  if (fs.existsSync(path.join(VB_SRC, 'near', 'manifest.json'))) {
    let vbFiles = 0, vbBytes = 0;
    for (const lod of LODS) {
      const s = path.join(VB_SRC, lod);
      if (!fs.existsSync(s)) continue;
      const r = copyDir(s, path.join(DST, 'visual-buildings', lod));
      vbFiles += r.files; vbBytes += r.bytes;
    }
    totalFiles += vbFiles; totalBytes += vbBytes;
    perLodLayer['visual-buildings'] = { files: vbFiles, bytes: vbBytes };
  }

  // [Mission ALIGNMENT-VISIBILITY-FINAL §3/§11] GSI Building Outline を Reference Alignment の
  //   magenta overlay として常時配信する（開発用サンプルオーバーレイ(alignment-pairs-sample.json)
  //   とは別物・city-wide・tile化済み）。
  const GSI_BLD_TILES_SRC = P('data', 'processed', 'osaka-city', 'derived', 'gsi-building-outline');
  if (fs.existsSync(path.join(GSI_BLD_TILES_SRC, 'manifest.json'))) {
    const r = copyDir(GSI_BLD_TILES_SRC, path.join(DST, 'gsi-building-outline'));
    totalFiles += r.files; totalBytes += r.bytes;
    perLodLayer['gsi-building-outline'] = { files: r.files, bytes: r.bytes };
  }

  // [Mission 31G-FIX15/FIX16] GSI Road Edge prototype overlay（開発用・既定 OFF）。
  //   §27: 全大阪版 road-edge-lines.json（実データで ~150MB 級）は配信しない（fetch コストが大きすぎる）。
  //   runtime toggle は sample エリア（10地区）限定の road-edge-lines-sample.json のみ fetch する。
  const GSI_SRC = P('data', 'processed', 'osaka-city', 'gsi-road-edge');
  const GSI_SAMPLE_SRC = path.join(GSI_SRC, 'road-edge-lines-sample.json');
  if (fs.existsSync(GSI_SAMPLE_SRC)) {
    const GSI_DST = path.join(path.dirname(DST), 'gsi-road-edge');
    fs.mkdirSync(GSI_DST, { recursive: true });
    const st = fs.statSync(GSI_SAMPLE_SRC);
    fs.copyFileSync(GSI_SAMPLE_SRC, path.join(GSI_DST, 'road-edge-lines-sample.json'));
    totalFiles++; totalBytes += st.size;
    perLodLayer['gsi-road-edge-sample'] = { files: 1, bytes: st.size };
  }

  const report = {
    generatedAt: new Date().toISOString(),
    dst: toProjectRelativePath(DST),
    lods: LODS, layers: LAYERS,
    files: totalFiles, bytes: totalBytes, mb: +(totalBytes / 1048576).toFixed(1),
    placementFiles,
    perLodLayer,
    note: 'ultra-near は runtime で使わない（near で tolM=2m 十分・容量 2 倍回避）。picking 用属性は derived feature の attributes に内包。',
    RESULT: 'PUBLISHED',
  };
  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  fs.writeFileSync(REPORT, JSON.stringify(report, null, 2));
  console.log('[derived-public] published ' + totalFiles + ' files / ' + report.mb + 'MB → ' + toProjectRelativePath(DST));
  for (const lod of LODS) {
    const rows = LAYERS.map((l) => l + ':' + ((perLodLayer[`${lod}/${l}`] || {}).files || 0));
    console.log('  ' + lod.padEnd(5) + ' ' + rows.join(' '));
  }
  console.log('保存: ' + toProjectRelativePath(REPORT));
}

if (isMainModule(import.meta.url)) main().catch((e) => { console.error('[derived-public] 失敗:', e && e.stack || e); process.exit(1); });
