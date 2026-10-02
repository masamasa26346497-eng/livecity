#!/usr/bin/env node
// tools/build-final-buildings-v4.js
// [Mission 35D §5/§8] 現在の final set（V2N）へ、再監査で見つかった実在建物を足して
//   新しい final building set（V4）を作る。
//
//   守ること（§0）:
//     - V2N の 600,764 棟は **1 棟も消さない / 1 バイトも変えない**。追加するだけ。
//     - PLATEAU の geometry / canonicalId / projection は触らない。
//     - derived-v2-osmv2（production が読む namespace）は触らない。別 namespace へ書く。
//
//   34C の V3 との違い:
//     - 候補は tools/audit/citywide-missing-buildings.js の出力（早期重複判定を撤廃して測り直したもの）
//     - 回収分どうしの重複判定に加え、**複数の PLATEAU にまたがる OSM 建物**の扱いを明示
//     - 水面の中の偽建物は候補の段階で除外済み
//
//   実行: node --max-old-space-size=12288 tools/build-final-buildings-v4.js [--stage=canonical|derived|all]
//   出力: data/processed/osaka-city/canonical/buildings-v4-final/
//         data/processed/osaka-city/derived-v4-final/ と public/map-data/osaka-city/derived-v4-final/
//         data/reports/final-buildings-v4-build.json
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolveProjectPath, toProjectRelativePath, isMainModule } from './lib/paths.js';
import { LIVECITY_COORDINATE_SYSTEM_ID } from './lib/livecity-coordinate-system.js';
import { toFallbackRecord, ringBbox, ringCentroid, MAX_FALLBACK_HEIGHT_M } from './lib/osm-building-fallback.js';
import { buildPlateauIndex, measureOverlap, classifyOverlap, FALLBACK_V2_CLASS } from './lib/osm-fallback-v2-classify.js';
import { polygonAreaM2, makeProvenance } from './lib/canonical-geometry-schema.js';
import { processDerivedLayer, buildingLayerOpts, DERIVED_LOD_ORDER } from './build-derived-geometry.js';
import { writeFilesVerified, readFileRetry } from './lib/synced-dir-writer.js';
import { RECOVERED_MAX_HEIGHT_M, recoveredHeight } from './build-osm-fallback-v3.js';

const P = (...s) => resolveProjectPath(path.join(...s));
export const V4 = {
  candidates: P('data', 'processed', 'osaka-city', 'missing-recovery-v4', 'candidates.json'),
  base: P('data', 'processed', 'osaka-city', 'canonical', 'buildings-v2-osmv2'),
  recoveredDir: P('data', 'processed', 'osaka-city', 'canonical', 'buildings-v4-recovered'),
  mergedDir: P('data', 'processed', 'osaka-city', 'canonical', 'buildings-v4-final'),
  derivedRoot: P('data', 'processed', 'osaka-city', 'derived-v4-final'),
  publicRoot: P('public', 'map-data', 'osaka-city', 'derived-v4-final'),
  report: P('data', 'reports', 'final-buildings-v4-build.json'),
};
const TILE_SIZE = 500;
export const GENERATION = '35D.1';
const r2 = (v) => Math.round(v * 100) / 100;
const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };
const isTile = (f) => /^tile_-?\d+_-?\d+\.json$/.test(f);
const tileKeyOfBbox = (bb) => Math.floor(((bb.minX + bb.maxX) / 2) / TILE_SIZE) + '_' + Math.floor(((bb.minZ + bb.maxZ) / 2) / TILE_SIZE);

/**
 * §5 回収分どうしの重複を落とす。
 *   候補は「今 表示されている建物と重ならないか」でだけ選んでいるので、
 *   OSM 側が同じ建物を 2 本の way で持っている場合は候補どうしが重なる。
 *   残す方の優先順: 名前あり > 階数あり > 面積が大きい > wayId が小さい。
 */
export function dedupeRecovered(cands) {
  const index = buildPlateauIndex(cands.map((c) => ({ id: c.canonicalId, ring: c.ring })), 40);
  const byId = new Map(cands.map((c) => [c.canonicalId, c]));
  const score = (c) => (c.tags && c.tags.name ? 4 : 0) + (c.tags && c.tags['building:levels'] ? 2 : 0) + (c.areaM2 || 0) / 1e6;
  const dropped = new Set(), pairs = [];
  for (const c of cands) {
    if (dropped.has(c.canonicalId)) continue;
    const m = measureOverlap(c.ring, index);
    if (m.plateauPartners <= 1) continue;
    const k = classifyOverlap(m);
    if (k.cls !== FALLBACK_V2_CLASS.CLEAR_DUPLICATE && k.cls !== FALLBACK_V2_CLASS.LIKELY_DUPLICATE) continue;
    for (const pid of m.partnerIds) {
      if (pid === c.canonicalId || dropped.has(pid)) continue;
      const other = byId.get(pid);
      if (!other) continue;
      const loser = score(c) >= score(other) ? other : c;
      const winner = loser === c ? other : c;
      dropped.add(loser.canonicalId);
      pairs.push({ kept: winner.canonicalId, dropped: loser.canonicalId, cls: k.cls,
        keptName: (winner.tags && winner.tags.name) || null, areaM2: loser.areaM2 });
      if (loser === c) break;
    }
  }
  return { kept: cands.filter((c) => !dropped.has(c.canonicalId)), droppedIds: [...dropped], pairs };
}

/**
 * §5「複数の PLATEAU にまたがる OSM 建物」の扱い。
 *   1 本の OSM way が既存の複数棟をまとめて囲っているだけなら、足すと二重表示になる。
 *   既存棟の面積合計が OSM 面積の大半を占めるなら「包む輪郭」とみなして落とす。
 */
export const MULTI_MATCH = { minPartners: 2, coveredByPartners: 0.55 };
export function isEnvelopeOfExisting(metrics, mm = MULTI_MATCH) {
  if (!metrics) return false;
  if ((metrics.partners || 0) < mm.minPartners) return false;
  return (metrics.overlapRatioToOsm || 0) >= mm.coveredByPartners;
}

/** 回収した 1 棟を canonical feature + attributes へ。形は既存 fallback と同じにする。 */
export function recoveredFeature(c, generatedAt) {
  const rec = toFallbackRecord(c.wayId, c.ring, c.tags, 'overlap-free', c.wardId);
  const rh = recoveredHeight(c.tags);
  const heightRelaxed = !!(rh && rh.dz > MAX_FALLBACK_HEIGHT_M);
  if (rh) {
    rec.dz = +rh.dz.toFixed(2); rec.h = rec.dz; rec.renderHeight = rec.dz; rec.actualHeight = rec.dz;
    rec.heightSource = rh.heightSource; rec.heightUnknown = rh.heightUnknown; rec.confidence = rh.confidence;
  }
  const bb = ringBbox(c.ring);
  const cen = ringCentroid(c.ring);
  const coords = [c.ring.map(([x, z]) => [r2(x), r2(z)])];
  const feature = {
    canonicalId: c.canonicalId, layer: 'buildings', geometryType: 'Polygon', coordinates: coords,
    bbox: { minX: r2(bb.minX), maxX: r2(bb.maxX), minZ: r2(bb.minZ), maxZ: r2(bb.maxZ) },
    areaM2: +polygonAreaM2('Polygon', coords).toFixed(2), centroid: [r2(cen[0]), r2(cen[1])],
    coordinateConvention: 'znorth-neg-v1', coordinateSystem: LIVECITY_COORDINATE_SYSTEM_ID,
    source: makeProvenance({
      geometrySource: 'osm-building', attributeSources: ['osm-building'], confidence: +rec.confidence.toFixed(2),
      sourceIds: ['way/' + c.wayId], generatedAt,
      notes: '[35D] 全域再監査で見つかった未表示建物。早期重複判定を撤廃して測り直した結果 ' + c.cls + '（' + c.rule + '）',
    }),
    qaFlags: ['fallback:overlap-free', 'fallback-v4:' + c.cls, 'recovered:35D'],
  };
  if (rec.heightUnknown) feature.qaFlags.push('height-unknown');
  const attrs = {
    source: 'osm-building', wardId: c.wardId, usage: rec.usage, normalizedUsage: rec.normalizedUsage,
    usageCategory: rec.usageCategory, usageLabel: rec.usageLabel, heightM: rec.h, heightSource: rec.heightSource,
    heightUnknown: !!rec.heightUnknown,
    levels: c.tags && c.tags['building:levels'] ? Number(c.tags['building:levels']) : null,
    confidence: feature.source.confidence, repMethod: 'centroid',
    fallbackReason: 'overlap-free', wardIdV1: null, wardStatus: 'inside', rawWardName: null, rawSourceKind: 'osm',
    fallbackV2Class: c.cls, fallbackV2Rule: c.rule, fallbackV2Status: 'recovered-35D',
    recoveredBy: 'mission-35D', recoveredReason: c.rule, generationVersion: GENERATION,
    heightRelaxed, heightCapM: rh ? RECOVERED_MAX_HEIGHT_M : MAX_FALLBACK_HEIGHT_M,
    overlapMetrics: c.metrics || null,
  };
  return { feature, attrs };
}

export function writeCanonical() {
  const t0 = Date.now();
  const generatedAt = new Date().toISOString();
  const doc = rj(V4.candidates);
  if (!doc) throw new Error('candidates.json が無い。先に tools/audit/citywide-missing-buildings.js を実行する');
  const all = doc.candidates || [];
  const stats = { candidateCount: all.length, envelopeDropped: 0, selfDuplicateDropped: 0, added: 0 };

  // §5 既存の複数棟を包んでいるだけの輪郭は足さない
  const envelopeDropped = [];
  const afterEnvelope = all.filter((c) => {
    if (isEnvelopeOfExisting(c.metrics)) {
      stats.envelopeDropped++;
      if (envelopeDropped.length < 30) {
        envelopeDropped.push({ canonicalId: c.canonicalId, name: (c.tags && c.tags.name) || null,
          areaM2: c.areaM2, partners: c.metrics.partners, covered: c.metrics.overlapRatioToOsm });
      }
      return false;
    }
    return true;
  });
  console.log('[v4] 既存を包む輪郭を除外', stats.envelopeDropped);

  console.log('[v4] 回収分どうしの重複を確認…', afterEnvelope.length);
  const dd = dedupeRecovered(afterEnvelope);
  stats.selfDuplicateDropped = dd.droppedIds.length;
  console.log('[v4] 自己重複で落とした棟', dd.droppedIds.length);

  const seen = new Set();
  const recFeatures = new Map(), recAttrs = new Map();
  const byWard = {};
  for (const c of dd.kept) {
    if (seen.has(c.wayId)) continue;
    seen.add(c.wayId);
    const fa = recoveredFeature(c, generatedAt);
    const k = tileKeyOfBbox(fa.feature.bbox);
    if (!recFeatures.has(k)) { recFeatures.set(k, []); recAttrs.set(k, {}); }
    recFeatures.get(k).push(fa.feature);
    recAttrs.get(k)[fa.feature.canonicalId] = fa.attrs;
    byWard[c.wardId] = (byWard[c.wardId] || 0) + 1;
    stats.added++;
  }

  // ── 回収分だけ ──
  const rFiles = new Map(), rAttrFiles = new Map();
  for (const [k, feats] of recFeatures) {
    const [tx, tz] = k.split('_').map(Number);
    rFiles.set(`tile_${tx}_${tz}.json`, JSON.stringify({ tx, tz, tileSize: TILE_SIZE,
      coordinateConvention: 'znorth-neg-v1', coordinateSystem: LIVECITY_COORDINATE_SYSTEM_ID,
      generatedAt, count: feats.length, features: feats }));
    rAttrFiles.set(`tile_${tx}_${tz}.json`, JSON.stringify({ tx, tz, count: feats.length, attributes: recAttrs.get(k) }));
  }
  rFiles.set('manifest.json', JSON.stringify({
    version: 1, layer: 'buildings', kind: 'canonical-geometry', variant: 'v4-recovered',
    sourceKind: 'OSM_RECOVERED', coordinateSystem: LIVECITY_COORDINATE_SYSTEM_ID, generatedAt,
    tileSize: TILE_SIZE, featureCount: stats.added, tiles: recFeatures.size, byWard,
    generationVersion: GENERATION,
    recoveredFrom: toProjectRelativePath(V4.candidates),
    note: 'Mission 35D。早期重複判定を撤廃して全域を測り直し、今の表示に入っていなかった実在 OSM 建物を回収したもの。',
  }, null, 2));
  writeFilesVerified(V4.recoveredDir, rFiles, { label: 'canonical/buildings-v4-recovered' });
  writeFilesVerified(path.join(V4.recoveredDir, 'attributes'), rAttrFiles, { label: 'canonical/buildings-v4-recovered/attributes' });
  rFiles.clear(); rAttrFiles.clear();

  // ── merged = V2N（無変更で複製） + 回収分 ──
  const baseManifest = rj(path.join(V4.base, 'manifest.json'));
  const mergedFiles = new Map(), mergedAttrFiles = new Map();
  let base = 0, merged = 0;
  const keys = new Set([...fs.readdirSync(V4.base).filter(isTile).map((f) => f.slice(5, -5)), ...recFeatures.keys()]);
  for (const k of keys) {
    const f = `tile_${k}.json`;
    const src = rj(path.join(V4.base, f));
    const srcAttr = rj(path.join(V4.base, 'attributes', f));
    const feats = src ? src.features.slice() : [];
    const attrs = srcAttr ? { ...srcAttr.attributes } : {};
    base += feats.length;
    for (const ft of (recFeatures.get(k) || [])) { feats.push(ft); attrs[ft.canonicalId] = recAttrs.get(k)[ft.canonicalId]; }
    if (!feats.length) continue;
    const [tx, tz] = k.split('_').map(Number);
    mergedFiles.set(f, JSON.stringify({ tx, tz, tileSize: TILE_SIZE, coordinateConvention: 'znorth-neg-v1',
      coordinateSystem: LIVECITY_COORDINATE_SYSTEM_ID, generatedAt, count: feats.length, features: feats }));
    mergedAttrFiles.set(f, JSON.stringify({ tx, tz, count: feats.length, attributes: attrs }));
    merged += feats.length;
  }
  mergedFiles.set('manifest.json', JSON.stringify({
    version: 1, layer: 'buildings', kind: 'canonical-geometry', variant: 'v4-final',
    coordinateSystem: LIVECITY_COORDINATE_SYSTEM_ID, coordinateConvention: 'znorth-neg-v1',
    generatedAt, tileSize: TILE_SIZE, featureCount: merged, tiles: mergedFiles.size,
    generationVersion: GENERATION,
    composition: { base: toProjectRelativePath(V4.base), baseGeneratedAt: baseManifest.generatedAt,
      baseFeatureCount: base, recovered: toProjectRelativePath(V4.recoveredDir), recoveredFeatureCount: stats.added },
    note: 'Mission 35D。V2N（600,764）へ全域再監査で見つかった実在建物を追加した集合。V2N 側は 1 件も変更していない。',
  }, null, 2));
  writeFilesVerified(V4.mergedDir, mergedFiles, { label: 'canonical/buildings-v4-final' });
  writeFilesVerified(path.join(V4.mergedDir, 'attributes'), mergedAttrFiles, { label: 'canonical/buildings-v4-final/attributes' });

  // §10 dev の DIFF 表示が読む索引（回収分の footprint だけ）。
  //   canonical 側と public 側の両方へ出す（dev は public の URL を読む）。
  const recoveredIndex = JSON.stringify({
    version: 1, generatedAt, missionId: '35D', generationVersion: GENERATION, count: stats.added,
    note: 'Mission 35D で回収した建物の footprint。dev の [DIFF: MISSING RECOVERY] が色分けして描く。',
    buildings: dd.kept.filter((c) => seen.has(c.wayId)).map((c) => ({ canonicalId: c.canonicalId,
      wardId: c.wardId, areaM2: c.areaM2, name: (c.tags && c.tags.name) || null,
      levels: (c.tags && c.tags['building:levels']) || null, cls: c.cls, ring: c.ring })),
  });
  writeFilesVerified(V4.recoveredDir, new Map([['recovered-index.json', recoveredIndex]]),
    { label: 'v4 recovered index', settleMs: 5000, removeStray: false });
  writeFilesVerified(V4.publicRoot, new Map([['recovered-index.json', recoveredIndex]]),
    { label: 'public v4 recovered index', settleMs: 5000, removeStray: false });

  return { generatedAt, generationVersion: GENERATION, ...stats,
    baseFeatureCount: base, mergedFeatureCount: merged, byWard,
    envelopeDroppedSamples: envelopeDropped, selfDuplicatePairs: dd.pairs.slice(0, 20),
    tiles: mergedFiles.size - 1, elapsedMs: Date.now() - t0 };
}

function publishDir(src, dst, label) {
  const m = JSON.parse(readFileRetry(path.join(src, 'manifest.json')));
  const files = new Map([['manifest.json', readFileRetry(path.join(src, 'manifest.json'))]]);
  for (const f of fs.readdirSync(src)) if (isTile(f)) files.set(f, readFileRetry(path.join(src, f)));
  const w = writeFilesVerified(dst, files, { label });
  return { tiles: m.tiles != null ? m.tiles : files.size - 1, files: w.written != null ? w.written : files.size };
}
function runTool(label, script, env) {
  console.log('[v4] ' + label + ' …');
  const r = spawnSync(process.execPath, ['--max-old-space-size=8192', P('tools', script)],
    { env: { ...process.env, ...env }, stdio: 'inherit' });
  if (r.status !== 0) throw new Error(label + ' が失敗 (exit ' + r.status + ')');
}

export function buildDerived() {
  const t0 = Date.now();
  const m = rj(path.join(V4.mergedDir, 'manifest.json'));
  const derived = processDerivedLayer('buildings', buildingLayerOpts({
    srcDir: V4.mergedDir, attrDir: path.join(V4.mergedDir, 'attributes'),
    generatedAt: m.generatedAt, sourceVersion: m.generatedAt,
    outRoot: V4.derivedRoot, layerDir: 'buildings', syncedWrite: true,
  }));
  const published = {};
  for (const lod of DERIVED_LOD_ORDER) {
    published[lod] = publishDir(path.join(V4.derivedRoot, lod, 'buildings'),
      path.join(V4.publicRoot, lod, 'buildings'), 'public v4 ' + lod);
  }
  // §8 placement / ward index は新しい建物集合で作り直す。
  //   回収分を既定 DISPLAY にせず、既存と同じ規則で評価する。
  const placementDir = path.join(V4.derivedRoot, 'building-placement');
  runTool('placement policy (V4)', 'build-building-placement-policy.js', {
    PLACEMENT_BUILD_DIR: V4.mergedDir, PLACEMENT_ATTR_DIR: path.join(V4.mergedDir, 'attributes'),
    PLACEMENT_OUT_DIR: placementDir, PLACEMENT_REPORT: P('data', 'reports', 'building-placement-policy-v4.json'),
    PLACEMENT_NO_31E: '1', PLACEMENT_SYNCED_WRITE: '1',
  });
  const placementPublished = publishDir(placementDir, path.join(V4.publicRoot, 'building-placement'), 'public v4 placement');
  const wardIndex = path.join(V4.derivedRoot, 'building-ward-index.json');
  runTool('ward index (V4)', 'build-ward-building-index.js', {
    WARD_INDEX_BUILD_DIR: V4.mergedDir, WARD_INDEX_ATTR_DIR: path.join(V4.mergedDir, 'attributes'),
    WARD_INDEX_PLACE_DIR: placementDir, WARD_INDEX_OUT: wardIndex,
    WARD_INDEX_REPORT: P('data', 'reports', 'ward-building-index-v4.json'),
  });
  writeFilesVerified(V4.publicRoot, new Map([
    ["building-ward-index.json", readFileRetry(wardIndex)],
    ['manifest.json', JSON.stringify({
      version: 1, kind: 'buildings-v4-final', generatedAt: new Date().toISOString(),
      coordinateSystem: LIVECITY_COORDINATE_SYSTEM_ID, generationVersion: GENERATION,
      note: 'Mission 35D。V2N + 全域再監査で見つかった実在建物。derived-v2-osmv2 / derived-v2-osmv3 はそのまま残す。',
      contents: ['{far,mid,near}/buildings', 'building-placement', 'building-ward-index.json'],
    }, null, 2)],
  ]), { label: 'public v4 top', settleMs: 5000, removeStray: false });
  return { derived: derived.lod, published, placement: placementPublished, elapsedMs: Date.now() - t0 };
}

async function main() {
  const stage = (process.argv.find((a) => a.startsWith('--stage=')) || '--stage=all').slice(8);
  const prev = fs.existsSync(V4.report) ? rj(V4.report) : {};
  const report = { ...prev, version: 1, missionId: '35D', generatedAt: new Date().toISOString() };
  if (stage === 'canonical' || stage === 'all') {
    report.canonical = writeCanonical();
    console.log('[v4] canonical 追加', report.canonical.added, '→ 合計', report.canonical.mergedFeatureCount);
  }
  if (stage === 'derived' || stage === 'all') {
    report.derived = buildDerived();
    console.log('[v4] derived', JSON.stringify(report.derived.published));
  }
  fs.mkdirSync(path.dirname(V4.report), { recursive: true });
  fs.writeFileSync(V4.report, JSON.stringify(report, null, 2));
  return report;
}

if (isMainModule(import.meta.url)) {
  main().then(() => { console.log('[v4] out', V4.report); process.exit(0); })
    .catch((e) => { console.error(e); process.exit(1); });
}
