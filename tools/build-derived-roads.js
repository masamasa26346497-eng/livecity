#!/usr/bin/env node
// tools/build-derived-roads.js
// [Mission 35E §8] **道路だけ** derived tile を作り直して public へ配る。
//
//   build-derived-geometry.js の main() は water / roads / buildings / parks / rail を
//   まとめて作り直す。buildings は V4 が別 namespace（derived-v4-final）を持っているので、
//   ここで一緒に作り直すと V1 canonical の建物で上書きしてしまう。
//   道路だけを対象にする。
//
//   §5 ROAD V3 の意味・設計は変えない。作り直すのは canonical roads から derived への
//   変換結果と、その配信物だけ。
//
//   実行: node --max-old-space-size=12288 tools/build-derived-roads.js
//   出力: data/processed/osaka-city/derived/{far,mid,near}/roads/
//         public/map-data/osaka-city/derived/{far,mid,near}/roads/
//         public/map-data/osaka-city/derived/refined-road-surface.json
//         data/reports/derived-roads-build.json
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, isMainModule } from './lib/paths.js';
import { processDerivedLayer, DERIVED_LOD_ORDER } from './build-derived-geometry.js';

const P = (...s) => resolveProjectPath(path.join(...s));
export const D = {
  canonRoads: P('data', 'processed', 'osaka-city', 'canonical', 'roads'),
  derivedRoot: P('data', 'processed', 'osaka-city', 'derived'),
  publicRoot: P('public', 'map-data', 'osaka-city', 'derived'),
  refinedSrc: P('data', 'processed', 'osaka-city', 'derived', 'refined-road-surface.json'),
  report: P('data', 'reports', 'derived-roads-build.json'),
};
const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };

/**
 * どの LOD で描くか。build-derived-geometry.js の roadVisibleAt と同じ規則を使う
 * （§5: 道路の意味づけを変えない）。lodClass は canonical roads が持っている。
 */
export function roadVisibleAt(lod, attr) {
  const c = attr && attr.lodClass;
  if (lod === 'far') return c === 'major';
  if (lod === 'mid') return c === 'major' || c === 'mid';
  return true;
}

export function run() {
  const t0 = Date.now();
  const m = rj(path.join(D.canonRoads, 'manifest.json'));
  if (!m) throw new Error('canonical roads が無い。先に tools/build-canonical-roads.js');
  const generatedAt = new Date().toISOString();

  const res = processDerivedLayer('roads', {
    srcDir: D.canonRoads,
    generatedAt, sourceVersion: m.generatedAt,
    outRoot: D.derivedRoot, layerDir: 'roads',
    visible: (lod, a) => roadVisibleAt(lod, a),
    pickAttr: (a) => ({ name: a.name || null, highway: a.highway || null,
      lodClass: a.lodClass || null, bridge: a.bridge || null, tunnel: a.tunnel || null }),
  });

  // public へ配る（道路だけ。他レイヤーのディレクトリは触らない）
  const published = {};
  for (const lod of DERIVED_LOD_ORDER) {
    const src = path.join(D.derivedRoot, lod, 'roads');
    const dst = path.join(D.publicRoot, lod, 'roads');
    if (!fs.existsSync(src)) continue;
    fs.mkdirSync(dst, { recursive: true });
    // 古い tile が残らないよう、いま書くもの以外を消す
    const want = new Set(fs.readdirSync(src));
    for (const f of fs.readdirSync(dst)) if (!want.has(f)) fs.rmSync(path.join(dst, f), { force: true });
    let files = 0, bytes = 0;
    for (const f of want) {
      const sp = path.join(src, f);
      fs.copyFileSync(sp, path.join(dst, f));
      files++; bytes += fs.statSync(sp).size;
    }
    published[lod] = { files, bytes };
  }
  // FIX13 の refined-road-surface.json も作り直したので配り直す
  let refined = null;
  if (fs.existsSync(D.refinedSrc)) {
    fs.copyFileSync(D.refinedSrc, path.join(D.publicRoot, 'refined-road-surface.json'));
    refined = { bytes: fs.statSync(D.refinedSrc).size };
  }

  const out = { version: 1, generatedAt, missionId: '35E',
    canonicalRoadCount: m.featureCount, canonicalGeneratedAt: m.generatedAt,
    derived: res.lod, published, refinedRoadSurface: refined, elapsedMs: Date.now() - t0 };
  fs.mkdirSync(path.dirname(D.report), { recursive: true });
  fs.writeFileSync(D.report, JSON.stringify(out, null, 2));
  return out;
}

if (isMainModule(import.meta.url)) {
  const o = run();
  for (const lod of DERIVED_LOD_ORDER) {
    const d = o.derived[lod];
    console.log('[derived-roads]', lod.padEnd(5), 'feature', d.featureCount, 'tiles', d.tiles,
      '→ public', o.published[lod] ? o.published[lod].files + ' files' : '-');
  }
  console.log('[derived-roads] refined-road-surface', o.refinedRoadSurface ? (o.refinedRoadSurface.bytes / 1048576).toFixed(2) + ' MB 配信' : '無し');
  console.log('[derived-roads] out', D.report);
}
