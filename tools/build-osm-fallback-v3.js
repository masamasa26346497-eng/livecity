#!/usr/bin/env node
// tools/build-osm-fallback-v3.js
// [Mission 34C §10/§11/§12] 欠落していた実在建物を canonical へ取り込む。
//
//   §2/§3 で分かった原因:
//     32O の fallback 選定（tools/build-osm-fallback-v2.js）は、OSM 建物のうち
//     「PLATEAU が面的に無い場所（hole / sparse-mismatch）」にあるものだけを候補にしていた。
//     再開発などで新しく建った 1 棟は周囲が既存 PLATEAU で埋まっているため候補にならず、
//     **重複判定に掛けられる前に落ちていた**（例: 堂島の 49 階建て・本町ガーデンシティテラス）。
//
//   ここでやること:
//     前段の場所フィルタを外し、市内 OSM 建物 全件 を既存の重複判定へ掛け直した結果
//     （tools/audit/building-coverage-citywide.js）のうち、重複ではないものだけを追加する。
//     **重複判定そのものは 32O のまま**（tools/lib/osm-fallback-v2-classify.js）。
//
//   触らないもの: V2 PLATEAU geometry / canonicalId / 既存 fallback / projection /
//                 derived-v2-osmv2（production が読んでいる namespace）。
//
//   実行: node --max-old-space-size=12288 tools/build-osm-fallback-v3.js [--stage=canonical|derived|all]
//   出力: data/processed/osaka-city/canonical/buildings-v2-osmv3/
//         data/processed/osaka-city/derived-v2-osmv3/ と public/map-data/osaka-city/derived-v2-osmv3/
//         data/reports/osm-fallback-v3-build.json
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolveProjectPath, toProjectRelativePath, isMainModule } from './lib/paths.js';
import { LIVECITY_COORDINATE_SYSTEM_ID } from './lib/livecity-coordinate-system.js';
import { toFallbackRecord, ringBbox, ringCentroid, LEVEL_HEIGHT_M, MAX_FALLBACK_HEIGHT_M } from './lib/osm-building-fallback.js';
import { buildPlateauIndex, measureOverlap, classifyOverlap, FALLBACK_V2_CLASS } from './lib/osm-fallback-v2-classify.js';
import { polygonAreaM2, makeProvenance } from './lib/canonical-geometry-schema.js';
import { processDerivedLayer, buildingLayerOpts, DERIVED_LOD_ORDER } from './build-derived-geometry.js';
import { writeFilesVerified, readFileRetry } from './lib/synced-dir-writer.js';

const P = (...s) => resolveProjectPath(path.join(...s));
export const O3 = {
  missing: P('data', 'processed', 'osaka-city', 'osm-fallback-v3', 'missing-candidates.json'),
  v2Merged: P('data', 'processed', 'osaka-city', 'canonical', 'buildings-v2-osmv2'),
  recoveredDir: P('data', 'processed', 'osaka-city', 'canonical', 'buildings-v3-recovered'),
  mergedDir: P('data', 'processed', 'osaka-city', 'canonical', 'buildings-v2-osmv3'),
  derivedRoot: P('data', 'processed', 'osaka-city', 'derived-v2-osmv3'),
  publicRoot: P('public', 'map-data', 'osaka-city', 'derived-v2-osmv3'),
  report: P('data', 'reports', 'osm-fallback-v3-build.json'),
};
const TILE_SIZE = 500;
export const RECOVERED_ID_PREFIX = 'cg_bldg_osm_';
const r2 = (v) => Math.round(v * 100) / 100;
const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };
const isTile = (f) => /^tile_-?\d+_-?\d+\.json$/.test(f);
const tileKeyOfBbox = (bb) => Math.floor(((bb.minX + bb.maxX) / 2) / TILE_SIZE) + '_' + Math.floor(((bb.minZ + bb.maxZ) / 2) / TILE_SIZE);

/**
 * §9 回収分どうしの重複を落とす。
 *   候補は「既存の表示建物と重ならないか」でだけ選んでいるので、
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
    if (m.plateauPartners <= 1) continue;               // 自分だけ
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
        keptName: winner.tags && winner.tags.name || null, areaM2: loser.areaM2 });
      if (loser === c) break;
    }
  }
  return { kept: cands.filter((c) => !dropped.has(c.canonicalId)), droppedIds: [...dropped], pairs };
}

// [Mission 34C §10] 32O の fallback は高さを 60m で頭打ちにしている
//   （MAX_FALLBACK_HEIGHT_M = 60。「超高層は PLATEAU 側にある想定」というコメント付き）。
//   34C が回収するのは **まさに PLATEAU に無い棟** なので、その前提が成り立たない。
//   実測タグ（height / building:levels）がある棟に限り、市内最高（あべのハルカス 300m）までを許す。
//   タグが無い棟は 32O と同じ扱い（class default・60m clamp）のまま。
export const RECOVERED_MAX_HEIGHT_M = 300;
export function recoveredHeight(tags) {
  const t = tags || {};
  const h = parseFloat(t.height);
  if (Number.isFinite(h) && h > 0) {
    return { dz: Math.min(RECOVERED_MAX_HEIGHT_M, h), heightSource: 'osm-height', heightUnknown: false, confidence: 0.92, clamped: h > RECOVERED_MAX_HEIGHT_M };
  }
  const lv = parseFloat(t['building:levels']);
  if (Number.isFinite(lv) && lv >= 1) {
    const v = lv * LEVEL_HEIGHT_M;
    return { dz: Math.min(RECOVERED_MAX_HEIGHT_M, v), heightSource: 'osm-levels', heightUnknown: false, confidence: 0.78, clamped: v > RECOVERED_MAX_HEIGHT_M };
  }
  return null;   // 実測が無い棟は 32O の既定に任せる
}

/** 回収した 1 棟を canonical feature + attributes へ。形は 32O の fallback と同じ（別 source にしない）。 */
export function recoveredFeature(c, generatedAt) {
  const rec = toFallbackRecord(c.wayId, c.ring, c.tags, 'overlap-free', c.wardId);
  // 実測タグがある棟だけ 60m の頭打ちを外す（上限 300m）。
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
      notes: '[34C] 32O の「PLATEAU gap の中だけ」という候補フィルタで落ちていた棟。重複判定は 32O と同じで ' + c.cls + '（' + c.rule + '）',
    }),
    qaFlags: ['fallback:overlap-free', 'fallback-v3:' + c.cls, 'recovered:34C'],
  };
  if (rec.heightUnknown) feature.qaFlags.push('height-unknown');
  const attrs = {
    source: 'osm-building', wardId: c.wardId, usage: rec.usage, normalizedUsage: rec.normalizedUsage,
    usageCategory: rec.usageCategory, usageLabel: rec.usageLabel, heightM: rec.h, heightSource: rec.heightSource,
    heightUnknown: !!rec.heightUnknown, levels: c.tags && c.tags['building:levels'] ? Number(c.tags['building:levels']) : null,
    confidence: feature.source.confidence, repMethod: 'centroid',
    fallbackReason: 'overlap-free', wardIdV1: null, wardStatus: 'inside', rawWardName: null, rawSourceKind: 'osm',
    fallbackV2Class: c.cls, fallbackV2Rule: c.rule, fallbackV2Status: 'recovered-34C',
    recoveredBy: 'mission-34C', recoveredReason: c.rule,
    // §10 高さの出所を残す。heightRelaxed = 32O の 60m 頭打ちを外した棟。
    heightRelaxed, heightCapM: rh ? RECOVERED_MAX_HEIGHT_M : MAX_FALLBACK_HEIGHT_M,
    // §10 何を根拠に足したかを残す
    overlapMetrics: c.metrics || null,
  };
  return { feature, attrs };
}

export function writeCanonical() {
  const t0 = Date.now();
  const generatedAt = new Date().toISOString();
  const doc = rj(O3.missing);
  if (!doc) throw new Error('missing-candidates.json が無い。先に tools/audit/building-coverage-citywide.js を実行する');
  const all = doc.candidates || [];
  console.log('[osm-fb-v3] 回収分どうしの重複を確認…', all.length);
  const dd = dedupeRecovered(all);
  const cands = dd.kept;
  console.log('[osm-fb-v3] 自己重複で落とした棟', dd.droppedIds.length, JSON.stringify(dd.pairs.slice(0, 5)));
  // §9 同じ wayId を二重に足さない
  const seen = new Set();
  const recFeatures = new Map(), recAttrs = new Map();
  let count = 0;
  const byWard = {};
  for (const c of cands) {
    if (seen.has(c.wayId)) continue;
    seen.add(c.wayId);
    const fa = recoveredFeature(c, generatedAt);
    const k = tileKeyOfBbox(fa.feature.bbox);
    if (!recFeatures.has(k)) { recFeatures.set(k, []); recAttrs.set(k, {}); }
    recFeatures.get(k).push(fa.feature);
    recAttrs.get(k)[fa.feature.canonicalId] = fa.attrs;
    byWard[c.wardId] = (byWard[c.wardId] || 0) + 1;
    count++;
  }
  // ── 回収分だけ（source を分けて残す） ──
  const rFiles = new Map(), rAttrFiles = new Map();
  for (const [k, feats] of recFeatures) {
    const [tx, tz] = k.split('_').map(Number);
    rFiles.set(`tile_${tx}_${tz}.json`, JSON.stringify({ tx, tz, tileSize: TILE_SIZE, coordinateConvention: 'znorth-neg-v1', coordinateSystem: LIVECITY_COORDINATE_SYSTEM_ID, generatedAt, count: feats.length, features: feats }));
    rAttrFiles.set(`tile_${tx}_${tz}.json`, JSON.stringify({ tx, tz, count: feats.length, attributes: recAttrs.get(k) }));
  }
  rFiles.set('manifest.json', JSON.stringify({
    version: 1, layer: 'buildings', kind: 'canonical-geometry', variant: 'v3-recovered',
    sourceKind: 'OSM_RECOVERED', coordinateSystem: LIVECITY_COORDINATE_SYSTEM_ID, generatedAt, tileSize: TILE_SIZE,
    featureCount: count, tiles: recFeatures.size, byWard,
    recoveredFrom: toProjectRelativePath(O3.missing),
    note: 'Mission 34C。32O の候補フィルタ（PLATEAU gap の中だけ）で評価されずに落ちていた OSM 建物。重複判定は 32O と同一。',
  }, null, 2));
  writeFilesVerified(O3.recoveredDir, rFiles, { label: 'canonical/buildings-v3-recovered' });
  writeFilesVerified(path.join(O3.recoveredDir, 'attributes'), rAttrFiles, { label: 'canonical/buildings-v3-recovered/attributes' });
  rFiles.clear(); rAttrFiles.clear();

  // ── merged = V2N（無変更で複製） + 回収分 ──
  const v2Manifest = rj(path.join(O3.v2Merged, 'manifest.json'));
  const mergedFiles = new Map(), mergedAttrFiles = new Map();
  let base = 0, merged = 0;
  const keys = new Set([...fs.readdirSync(O3.v2Merged).filter(isTile).map((f) => f.slice(5, -5)), ...recFeatures.keys()]);
  for (const k of keys) {
    const f = `tile_${k}.json`;
    const src = rj(path.join(O3.v2Merged, f));
    const srcAttr = rj(path.join(O3.v2Merged, 'attributes', f));
    const feats = src ? src.features.slice() : [];
    const attrs = srcAttr ? { ...srcAttr.attributes } : {};
    base += feats.length;
    for (const ft of (recFeatures.get(k) || [])) { feats.push(ft); attrs[ft.canonicalId] = recAttrs.get(k)[ft.canonicalId]; }
    if (!feats.length) continue;
    const [tx, tz] = k.split('_').map(Number);
    mergedFiles.set(f, JSON.stringify({ tx, tz, tileSize: TILE_SIZE, coordinateConvention: 'znorth-neg-v1', coordinateSystem: LIVECITY_COORDINATE_SYSTEM_ID, generatedAt, count: feats.length, features: feats }));
    mergedAttrFiles.set(f, JSON.stringify({ tx, tz, count: feats.length, attributes: attrs }));
    merged += feats.length;
  }
  const mergedManifest = {
    version: 1, layer: 'buildings', kind: 'canonical-geometry', variant: 'v2-corrected-osmv3',
    coordinateSystem: LIVECITY_COORDINATE_SYSTEM_ID, coordinateConvention: 'znorth-neg-v1',
    generatedAt, tileSize: TILE_SIZE, featureCount: merged, tiles: mergedFiles.size,
    composition: { base: toProjectRelativePath(O3.v2Merged), baseGeneratedAt: v2Manifest.generatedAt, baseFeatureCount: base,
      recovered: toProjectRelativePath(O3.recoveredDir), recoveredFeatureCount: count },
    note: 'Mission 34C。V2N（600,764）へ、候補フィルタで落ちていた実在 OSM 建物を追加した集合。V2N 側は 1 件も変更していない。',
  };
  mergedFiles.set('manifest.json', JSON.stringify(mergedManifest, null, 2));
  writeFilesVerified(O3.mergedDir, mergedFiles, { label: 'canonical/buildings-v2-osmv3' });
  writeFilesVerified(path.join(O3.mergedDir, 'attributes'), mergedAttrFiles, { label: 'canonical/buildings-v2-osmv3/attributes' });

  // §15 dev の COVERAGE QA が読む軽い索引（回収分の footprint だけ）
  writeFilesVerified(O3.recoveredDir, new Map([['recovered-index.json', JSON.stringify({
    version: 1, generatedAt, missionId: '34C', count,
    note: 'Mission 34C で回収した建物の footprint。dev の [COVERAGE QA] が magenta で描く。',
    buildings: cands.filter((c) => seen.has(c.wayId)).map((c) => ({ canonicalId: c.canonicalId, wardId: c.wardId,
      areaM2: c.areaM2, name: (c.tags && c.tags.name) || null, levels: (c.tags && c.tags['building:levels']) || null,
      cls: c.cls, ring: c.ring })),
  })]]), { label: 'recovered index', settleMs: 5000, removeStray: false });

  return { generatedAt, recovered: count, baseFeatureCount: base, mergedFeatureCount: merged, byWard,
    candidateCount: all.length, selfDuplicateDropped: dd.droppedIds.length, selfDuplicatePairs: dd.pairs,
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
  console.log('[osm-fb-v3] ' + label + ' …');
  const r = spawnSync(process.execPath, ['--max-old-space-size=8192', P('tools', script)], { env: { ...process.env, ...env }, stdio: 'inherit' });
  if (r.status !== 0) throw new Error(label + ' が失敗 (exit ' + r.status + ')');
}

export function buildDerived() {
  const t0 = Date.now();
  const m = rj(path.join(O3.mergedDir, 'manifest.json'));
  const derived = processDerivedLayer('buildings', buildingLayerOpts({
    srcDir: O3.mergedDir, attrDir: path.join(O3.mergedDir, 'attributes'),
    generatedAt: m.generatedAt, sourceVersion: m.generatedAt,
    outRoot: O3.derivedRoot, layerDir: 'buildings', syncedWrite: true,
  }));
  const published = {};
  for (const lod of DERIVED_LOD_ORDER) published[lod] = publishDir(path.join(O3.derivedRoot, lod, 'buildings'), path.join(O3.publicRoot, lod, 'buildings'), 'public osmv3 ' + lod);
  // placement / ward index は新しい建物集合で作り直す（回収分だけ既定 DISPLAY にしない＝同じ規則で評価する）
  const placementDir = path.join(O3.derivedRoot, 'building-placement');
  runTool('placement policy (V3)', 'build-building-placement-policy.js', {
    PLACEMENT_BUILD_DIR: O3.mergedDir, PLACEMENT_ATTR_DIR: path.join(O3.mergedDir, 'attributes'),
    PLACEMENT_OUT_DIR: placementDir, PLACEMENT_REPORT: P('data', 'reports', 'building-placement-policy-v3.json'),
    PLACEMENT_NO_31E: '1', PLACEMENT_SYNCED_WRITE: '1',
  });
  const wardIndex = path.join(O3.derivedRoot, 'building-ward-index.json');
  runTool('ward index (V3)', 'build-ward-building-index.js', {
    WARD_INDEX_BUILD_DIR: O3.mergedDir, WARD_INDEX_ATTR_DIR: path.join(O3.mergedDir, 'attributes'),
    WARD_INDEX_PLACE_DIR: placementDir, WARD_INDEX_OUT: wardIndex,
    WARD_INDEX_REPORT: P('data', 'reports', 'ward-building-index-v3.json'),
  });
  published.placement = publishDir(placementDir, path.join(O3.publicRoot, 'building-placement'), 'public osmv3 placement');
  writeFilesVerified(O3.publicRoot, new Map([
    ['building-ward-index.json', readFileRetry(wardIndex)],
    ['manifest.json', JSON.stringify({
      version: 1, kind: 'buildings-v2-corrected-osmv3', generatedAt: new Date().toISOString(),
      coordinateSystem: LIVECITY_COORDINATE_SYSTEM_ID,
      note: 'Mission 34C。V2N + 候補フィルタで落ちていた実在 OSM 建物。derived-v2-osmv2 はそのまま残す。',
      contents: ['{far,mid,near}/buildings', 'building-placement', 'building-ward-index.json'],
    }, null, 2)],
  ]), { label: 'public osmv3 top', settleMs: 5000, removeStray: false });
  return { derived: derived.lod, published, elapsedMs: Date.now() - t0 };
}

async function main() {
  const stage = (process.argv.find((a) => a.startsWith('--stage=')) || '--stage=all').slice(8);
  const prev = fs.existsSync(O3.report) ? rj(O3.report) : {};
  const report = { ...prev, version: 1, missionId: '34C', generatedAt: new Date().toISOString() };
  if (stage === 'canonical' || stage === 'all') {
    report.canonical = writeCanonical();
    console.log('[osm-fb-v3] canonical', JSON.stringify(report.canonical));
  }
  if (stage === 'derived' || stage === 'all') {
    report.derived = buildDerived();
    console.log('[osm-fb-v3] derived', JSON.stringify(report.derived.published));
  }
  fs.mkdirSync(path.dirname(O3.report), { recursive: true });
  fs.writeFileSync(O3.report, JSON.stringify(report, null, 2));
  return report;
}

if (isMainModule(import.meta.url)) {
  main().then(() => { console.log('[osm-fb-v3] out', O3.report); process.exit(0); })
    .catch((e) => { console.error(e); process.exit(1); });
}
