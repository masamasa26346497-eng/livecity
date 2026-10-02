#!/usr/bin/env node
// tools/build-hybrid-sample-status.js
// [Mission 31G-FIX19B §13] Hybrid Runtime Visual Cutover — 右下 status UI 用の軽量サマリを作る。
//
//   §0 遵守: geometry / algorithm には一切触れない。data/processed/osaka-city/gsi-road-hybrid-v1/samples/
//   （FIX19 で既に生成済み）から `surfaces` 配列（重い geometry 本体）を除いた数値サマリだけを
//   抽出して 1 ファイルへまとめる、純粋なパッケージングのみ。新しい計算は一切行わない。
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, toProjectRelativePath, isMainModule } from './lib/paths.js';
import { writeJson } from './lib/area.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const SAMPLES_DIR = P('data', 'processed', 'osaka-city', 'gsi-road-hybrid-v1', 'samples');
const OUT_PROCESSED = P('data', 'processed', 'osaka-city', 'gsi-road-hybrid-v1', 'sample-status.json');
const OUT_PUBLIC = P('public', 'map-data', 'osaka-city', 'gsi-road-hybrid-v1', 'sample-status.json');

async function main() {
  if (!fs.existsSync(SAMPLES_DIR)) {
    console.log('[build-hybrid-sample-status] samples/ が無い（先に data:gsi-road-edge:hybrid-v1）。何もしない。');
    return;
  }
  const files = fs.readdirSync(SAMPLES_DIR).filter((f) => f.endsWith('.json'));
  const samples = {};
  for (const f of files) {
    const j = JSON.parse(fs.readFileSync(path.join(SAMPLES_DIR, f), 'utf-8'));
    const name = j.area || path.basename(f, '.json');
    samples[name] = {
      surfaceCount: j.surfaceCount,
      gsiHighPct: j.coverage ? j.coverage.GSI_HIGH_pct : null,
      gsiMediumPct: j.coverage ? j.coverage.GSI_MEDIUM_pct : null,
      fix13FallbackPct: j.coverage ? j.coverage.FIX13_FALLBACK_pct : null,
      unresolvedPct: j.coverage ? j.coverage.UNRESOLVED_pct : null,
      centerWorld: j.centerWorld,
    };
  }
  const out = { version: 1, kind: 'gsi-road-hybrid-v1-sample-status', generatedAt: new Date().toISOString(), sampleCount: Object.keys(samples).length, samples };
  await writeJson(OUT_PROCESSED, out);
  fs.mkdirSync(path.dirname(OUT_PUBLIC), { recursive: true });
  await writeJson(OUT_PUBLIC, out);
  console.log('[build-hybrid-sample-status] samples:', Object.keys(samples).length, '→', toProjectRelativePath(OUT_PUBLIC));
}

if (isMainModule(import.meta.url)) main().catch((e) => { console.error('[build-hybrid-sample-status] 失敗:', e && e.stack || e); process.exit(1); });
