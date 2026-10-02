#!/usr/bin/env node
// tools/build-buildings-v2-corrected-sidecars.js
// [Mission 32N §22 / §16] V2 corrected canonical から、runtime が必要とする付帯データを
//   V2 専用 namespace に作る（V1 の出力には一切触れない）。
//     1. building placement policy（DISPLAY/SUPPRESS/REVIEW/EXEMPT）… 31E 索引（V1 座標由来）は使わず再計算
//     2. building ward index（Ward Mode 用）… V2 placement を前提に作る
//     3. public/map-data/osaka-city/derived-v2-corrected/ へ公開（自分の出力だけを置き換える §14）
//   前提: tools/build-canonical-buildings-v2-corrected.js を先に実行済みであること。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolveProjectPath, toProjectRelativePath, isMainModule } from './lib/paths.js';
import { writeFilesVerified, readFileRetry } from './lib/synced-dir-writer.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const V2C = P('data', 'processed', 'osaka-city', 'canonical', 'buildings-v2-corrected');
const DERIVED_V2 = P('data', 'processed', 'osaka-city', 'derived-v2-corrected');
const PUBLIC_V2 = P('public', 'map-data', 'osaka-city', 'derived-v2-corrected');

function run(label, script, env) {
  console.log('[v2-sidecars] ' + label + ' …');
  const r = spawnSync(process.execPath, ['--max-old-space-size=8192', P('tools', script)], {
    env: { ...process.env, ...env }, stdio: 'inherit',
  });
  if (r.status !== 0) throw new Error(label + ' が失敗 (exit ' + r.status + ')');
}

export function buildV2Sidecars() {
  if (!fs.existsSync(path.join(V2C, 'manifest.json'))) throw new Error('V2 corrected canonical が無い: ' + toProjectRelativePath(V2C));
  const placementDir = path.join(DERIVED_V2, 'building-placement');
  const wardIndex = path.join(DERIVED_V2, 'building-ward-index.json');

  run('placement policy (V2)', 'build-building-placement-policy.js', {
    PLACEMENT_BUILD_DIR: V2C,
    PLACEMENT_ATTR_DIR: path.join(V2C, 'attributes'),
    PLACEMENT_OUT_DIR: placementDir,
    PLACEMENT_REPORT: P('data', 'reports', 'building-placement-policy-v2-corrected.json'),
    PLACEMENT_NO_31E: '1',
    PLACEMENT_SYNCED_WRITE: '1',
  });
  run('ward index (V2)', 'build-ward-building-index.js', {
    WARD_INDEX_BUILD_DIR: V2C,
    WARD_INDEX_ATTR_DIR: path.join(V2C, 'attributes'),
    WARD_INDEX_PLACE_DIR: placementDir,
    WARD_INDEX_OUT: wardIndex,
    WARD_INDEX_REPORT: P('data', 'reports', 'ward-building-index-v2-corrected.json'),
  });

  // 公開（自分が作ったものだけ置き換える §14）。ディレクトリは消さず、上書き＋読み戻し検証。
  const pubPlacement = path.join(PUBLIC_V2, 'building-placement');
  const pm = JSON.parse(readFileRetry(path.join(placementDir, 'manifest.json')));
  const placementFiles = new Map([['manifest.json', readFileRetry(path.join(placementDir, 'manifest.json'))]]);
  for (const t of pm.tiles || []) placementFiles.set(t.file, readFileRetry(path.join(placementDir, t.file)));
  writeFilesVerified(pubPlacement, placementFiles, { label: 'public building-placement' });
  const files = placementFiles.size;
  fs.mkdirSync(PUBLIC_V2, { recursive: true });
  fs.writeFileSync(path.join(PUBLIC_V2, 'building-ward-index.json'), readFileRetry(wardIndex));
  // runtime 用の最小 manifest（V2 namespace の自己記述）
  fs.writeFileSync(path.join(PUBLIC_V2, 'manifest.json'), JSON.stringify({
    version: 1, kind: 'buildings-v2-corrected', generatedAt: new Date().toISOString(),
    coordinateSystem: 'livecity-equirect-znorth-neg-v1',
    note: 'Mission 32N。建物 canonical V2（生 CityGML → Live City 共通座標）の派生物だけを置く。道路等は derived/ を使う。',
    contents: ['{far,mid,near}/buildings', 'building-placement', 'building-ward-index.json'],
  }, null, 2));
  return { placementFiles: files, wardIndex: toProjectRelativePath(wardIndex) };
}

if (isMainModule(import.meta.url)) {
  try { console.log('[v2-sidecars] DONE ' + JSON.stringify(buildV2Sidecars())); }
  catch (e) { console.error('[v2-sidecars] 失敗:', e && e.stack || e); process.exit(1); }
}
