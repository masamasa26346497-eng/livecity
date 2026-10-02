#!/usr/bin/env node
// tools/build-derived-shared-layers.js
// [Mission 35F §5/§8] 35F で作り直したレイヤー（rail / water / parks）だけ derived を作り直して
//   public へ配る。**道路と建物には触らない**。
//
//   build-derived-geometry.js の main() は water / roads / buildings / parks / rail を
//   まとめて作り直す。道路は 35E の状態を保つ必要があり（§13 rollback 禁止）、
//   建物は V4 が別 namespace を持っているので、一緒に回してはいけない。
//
//   実行: node --max-old-space-size=12288 tools/build-derived-shared-layers.js [--layer rail,water,parks]
//   出力: data/processed/osaka-city/derived/{far,mid,near}/{rail,water,parks}/
//         public/map-data/osaka-city/derived/{far,mid,near}/{rail,water,parks}/
//         public/map-data/osaka-city/derived/rail-stations.json
//         data/reports/derived-shared-layers-build.json
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, isMainModule } from './lib/paths.js';
import { processDerivedLayer, DERIVED_LOD_ORDER } from './build-derived-geometry.js';

const P = (...s) => resolveProjectPath(path.join(...s));
export const SL = {
  derivedRoot: P('data', 'processed', 'osaka-city', 'derived'),
  publicRoot: P('public', 'map-data', 'osaka-city', 'derived'),
  stations: P('data', 'processed', 'osaka-city', 'canonical', 'rail', 'stations.json'),
  report: P('data', 'reports', 'derived-shared-layers-build.json'),
};
/** 今回作り直してよいレイヤー。道路・建物は含めない（§13）。 */
export const ALLOWED = ['rail', 'water', 'parks'];
const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };

/**
 * どの LOD で出すか。build-derived-geometry.js と同じ規則を使う（§8 設計を変えない）。
 */
export function railVisibleAt(lod, attr) {
  const c = attr && attr.lodClass;
  if (lod === 'far') return c === 'major';
  if (lod === 'mid') return c === 'major' || c === 'urban';
  return true;
}
export function waterVisibleAt(lod, attr, areaM2) {
  const wc = attr && attr.waterClass;
  const rc = attr && attr.riverClass;
  const bigRiver = rc === 'major' || wc === 'harbor' || wc === 'sea' || areaM2 >= 200000;
  const medium = areaM2 >= 20000 || wc === 'river' || wc === 'canal';
  if (lod === 'far') return bigRiver;
  if (lod === 'mid') return bigRiver || medium;
  return true;
}
export function parkVisibleAt(lod, attr, areaM2) {
  const rankable = attr && attr.rankable;
  const pc = attr && attr.parkClass;
  const isRealPark = pc === 'park' || pc === 'recreation_ground' || pc === 'garden'
    || pc === 'playground' || pc === 'sports_ground';
  if (lod === 'far') return rankable && areaM2 >= 50000;
  if (lod === 'mid') return isRealPark && areaM2 >= 8000;
  return true; // near = 完全（grass / green_space / misclassified-block も）
}

/** レイヤーごとの入力と属性の取り方。 */
export const LAYER_OPTS = {
  rail: {
    srcDir: P('data', 'processed', 'osaka-city', 'canonical', 'rail'),
    visible: (lod, a) => railVisibleAt(lod, a),
    pickAttr: (a) => ({ name: a.name || null, railway: a.railway || null,
      lodClass: a.lodClass || null, railClass: a.railClass || null }),
  },
  water: {
    srcDir: P('data', 'processed', 'osaka-city', 'canonical', 'water'),
    visible: (lod, a, areaM2) => waterVisibleAt(lod, a, areaM2),
    pickAttr: (a) => ({ name: a.name || null, waterClass: a.waterClass || null, riverClass: a.riverClass || null }),
  },
  parks: {
    srcDir: P('data', 'processed', 'osaka-city', 'canonical', 'parks'),
    visible: (lod, a, areaM2) => parkVisibleAt(lod, a, areaM2),
    pickAttr: (a) => ({ name: a.name || null, parkClass: a.parkClass || null, rankable: !!a.rankable }),
  },
};

export function run({ layers = ALLOWED } = {}) {
  const t0 = Date.now();
  const use = layers.filter((l) => ALLOWED.includes(l));
  if (!use.length) throw new Error('作り直すレイヤーが無い（道路・建物は対象外）');
  const generatedAt = new Date().toISOString();
  const results = {}, published = {};

  for (const layer of use) {
    const opts = LAYER_OPTS[layer];
    const m = rj(path.join(opts.srcDir, 'manifest.json'));
    if (!m) { console.log('[shared-layers]', layer, 'canonical が無い。とばす'); continue; }
    results[layer] = processDerivedLayer(layer, {
      srcDir: opts.srcDir, generatedAt, sourceVersion: m.generatedAt,
      outRoot: SL.derivedRoot, layerDir: layer,
      visible: opts.visible, pickAttr: opts.pickAttr,
    });
    published[layer] = {};
    for (const lod of DERIVED_LOD_ORDER) {
      const src = path.join(SL.derivedRoot, lod, layer);
      const dst = path.join(SL.publicRoot, lod, layer);
      if (!fs.existsSync(src)) continue;
      fs.mkdirSync(dst, { recursive: true });
      const want = new Set(fs.readdirSync(src));
      for (const f of fs.readdirSync(dst)) if (!want.has(f)) fs.rmSync(path.join(dst, f), { force: true });
      let files = 0, bytes = 0;
      for (const f of want) {
        fs.copyFileSync(path.join(src, f), path.join(dst, f));
        files++; bytes += fs.statSync(path.join(src, f)).size;
      }
      published[layer][lod] = { files, bytes };
    }
    console.log('[shared-layers]', layer.padEnd(6), 'canonical', m.featureCount,
      '→ derived near', results[layer].lod.near.featureCount, '/ mid', results[layer].lod.mid.featureCount,
      '/ far', results[layer].lod.far.featureCount);
  }

  // §9 駅は derived の top に平置きで配る（rail-stations.json）
  let stations = null;
  if (use.includes('rail') && fs.existsSync(SL.stations)) {
    fs.copyFileSync(SL.stations, path.join(SL.publicRoot, 'rail-stations.json'));
    const s = rj(SL.stations);
    stations = { count: s ? s.count : null };
    console.log('[shared-layers] 駅', stations.count, '件を配信');
  }

  const out = { version: 1, generatedAt, missionId: '35F',
    layers: use, derived: results, published, stations,
    note: '道路（35E の状態）と建物（V4）は触っていない。',
    elapsedMs: Date.now() - t0 };
  fs.mkdirSync(path.dirname(SL.report), { recursive: true });
  fs.writeFileSync(SL.report, JSON.stringify(out, null, 2));
  return out;
}

if (isMainModule(import.meta.url)) {
  const arg = (process.argv.find((a) => a.startsWith('--layer=')) || '').slice(8);
  const o = run({ layers: arg ? arg.split(',') : ALLOWED });
  console.log('[shared-layers] out', SL.report);
}
