// tools/lib/canonical-corrections.js
// [Mission 31E §13/§14] canonical geometry への追跡可能・可逆な補正の読込と適用。
//   元 canonical / raw source は書き換えない。build 時にこのモジュールで derived へ適用する。
//   補正ファイルを消して再 build すれば元に戻る（reversible）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { resolveProjectPath } from './paths.js';
import { makeCanonicalFeature, polygonAreaM2 } from './canonical-geometry-schema.js';

const CORR_DIR = resolveProjectPath(path.join('data', 'processed', 'osaka-city', 'canonical', 'corrections'));
const ALLOWED_OPS = new Set(['split-multipolygon-parts', 'remove-sliver', 'exclude-invalid-island', 'reclassify']);

/** layer ('water' | 'roads' | 'buildings' | 'parks') の補正レコードを読む。 */
export function loadCorrections(layer) {
  const dir = path.join(CORR_DIR, layer);
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    if (!/\.json$/.test(f)) continue;
    const rec = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
    rec._file = path.join('data/processed/osaka-city/canonical/corrections', layer, f);
    if (!ALLOWED_OPS.has(rec.operation)) { rec._error = 'operation が許可外: ' + rec.operation; }
    out.push(rec);
  }
  return out;
}

function geomHash(coords) { return 'sha1:' + crypto.createHash('sha1').update(JSON.stringify(coords)).digest('hex'); }

function ringAllVerts(poly) { return poly.flat(); }
function distPtToPts(pt, pts) {
  let m = Infinity;
  for (const [x, z] of pts) { const d = Math.hypot(pt[0] - x, pt[1] - z); if (d < m) m = d; }
  return m;
}
function pip(pt, ring) {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], zi = ring[i][1], xj = ring[j][0], zj = ring[j][1];
    if ((zi > pt[1]) !== (zj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - zi)) / (zj - zi) + xi) c = !c;
  }
  return c;
}

/**
 * split-multipolygon-parts: MultiPolygon の target から、centerline 非交差の独立部分を分離。
 * @returns { keptFeature, splitOffFeatures[], applied: {…} }
 */
function applySplitMultipolygon(feature, rec) {
  if (feature.geometryType !== 'MultiPolygon') return { error: 'target が MultiPolygon でない' };
  const cl = (feature.centerlineRef && feature.centerlineRef.coordinates) || [];
  if (!cl.length) return { error: 'centerlineRef が無く split の根拠を取れない' };
  const sel = rec.params.splitPartSelector || {};
  const wantIn = sel.centerlinePointsInside != null ? sel.centerlinePointsInside : 0;
  const minDist = sel.minDistToCenterlineM_gt || 60;
  const minArea = sel.minAreaM2 || 80000;

  const kept = [], splitOff = [];
  for (const poly of feature.coordinates) {
    const outer = poly[0] || [];
    const clInside = cl.filter((p) => pip(p, outer)).length;
    const md = distPtToPts(outer[0] ? [outer.reduce((s, p) => s + p[0], 0) / outer.length, outer.reduce((s, p) => s + p[1], 0) / outer.length] : [0, 0], cl);
    // より厳密に: いずれかの outer 頂点から centerline への最小距離
    let vmd = Infinity;
    for (const v of outer) { const d = distPtToPts(v, cl); if (d < vmd) vmd = d; }
    const area = polygonAreaM2('Polygon', poly);
    if (clInside <= wantIn && vmd > minDist && area >= minArea) splitOff.push(poly);
    else kept.push(poly);
  }
  if (!splitOff.length) return { error: 'selector に一致する split 対象 part が無い', kept: kept.length };
  if (!kept.length) return { error: 'kept part が 0（全 part を split すると target が消える）' };

  const keptCoords = kept.length === 1 ? kept[0] : kept;
  const keptGt = kept.length === 1 ? 'Polygon' : 'MultiPolygon';
  const keptFeature = makeCanonicalFeature({
    canonicalId: feature.canonicalId,
    layer: feature.layer, geometryType: keptGt, coordinates: keptCoords,
    provenance: {
      ...feature.source,
      notes: (feature.source.notes || '') + ` ／ [31E correction ${rec.correctionId}] 港湾/独立水域 ${splitOff.length} part を分離（元 ${feature.coordinates.length} part → ${kept.length} part）。`,
    },
    attributes: { ...feature.attributes, correctionApplied: rec.correctionId, polygonMergedParts: kept.length },
    qaFlags: [...(feature.qaFlags || []).filter((q) => !q.includes('polygon-much-larger-than-ribbon')), 'corrected-31E:' + rec.operation],
    centerlineRef: feature.centerlineRef,
    widthProfile: feature.widthProfile,
  });

  const so = rec.params.splitOffAttributes || {};
  const splitOffFeatures = splitOff.map((poly, i) => makeCanonicalFeature({
    canonicalId: (rec.params.splitOffCanonicalIdPrefix || 'cg_water_split') + '_' + i,
    layer: feature.layer, geometryType: 'Polygon', coordinates: poly,
    provenance: {
      geometrySource: feature.source.geometrySource,
      attributeSources: ['31E-correction'],
      confidence: rec.params.splitOffConfidence != null ? rec.params.splitOffConfidence : 0.6,
      sourceIds: [...(feature.source.sourceIds || []), 'correction/' + rec.correctionId],
      generatedAt: new Date().toISOString(),
      notes: `[31E correction ${rec.correctionId}] ${feature.attributes.name || feature.canonicalId} から分離。${so.note || ''}`,
    },
    attributes: {
      name: so.name !== undefined ? so.name : null,
      waterClass: so.waterClass || 'water',
      derivedFrom: feature.canonicalId, correctionApplied: rec.correctionId,
    },
    qaFlags: ['split-from-' + feature.canonicalId, 'corrected-31E:' + rec.operation],
    centerlineRef: null,
    widthProfile: null,
  }));

  return {
    keptFeature, splitOffFeatures,
    applied: {
      correctionId: rec.correctionId, operation: rec.operation, target: feature.canonicalId,
      partsBefore: feature.coordinates.length, partsKept: kept.length, partsSplitOff: splitOff.length,
      areaBeforeM2: Math.round(polygonAreaM2(feature.geometryType, feature.coordinates)),
      areaKeptM2: Math.round(polygonAreaM2(keptGt, keptCoords)),
      areaSplitOffM2: splitOff.reduce((s, p) => s + Math.round(polygonAreaM2('Polygon', p)), 0),
      splitOffIds: splitOffFeatures.map((f) => f.canonicalId),
    },
  };
}

function applyReclassify(feature, rec) {
  const before = { ...feature.attributes };
  const patch = rec.params.attributes || {};
  const nf = { ...feature, attributes: { ...feature.attributes, ...patch, correctionApplied: rec.correctionId } };
  nf.qaFlags = [...(feature.qaFlags || []), 'corrected-31E:reclassify'];
  nf.source = { ...feature.source, confidence: rec.params.confidence != null ? rec.params.confidence : feature.source.confidence };
  return { keptFeature: nf, splitOffFeatures: [], applied: { correctionId: rec.correctionId, operation: 'reclassify', target: feature.canonicalId, before, after: nf.attributes } };
}

/**
 * feature 配列へ補正群を適用する。
 * @param {Array} features canonical feature 配列
 * @param {Array} corrections loadCorrections の結果
 * @returns { features: 適用後配列, applied: [...], errors: [...] }
 */
export function applyCorrections(features, corrections) {
  const byId = new Map(features.map((f) => [f.canonicalId, f]));
  const applied = [], errors = [];
  const removedIds = new Set();
  const added = [];

  for (const rec of corrections) {
    if (rec._error) { errors.push({ correctionId: rec.correctionId, error: rec._error }); continue; }
    const target = byId.get(rec.targetCanonicalId);
    if (!target) { errors.push({ correctionId: rec.correctionId, error: 'target が canonical に無い: ' + rec.targetCanonicalId }); continue; }
    // §14 可逆性チェック: 記録された originalGeometryHash と現在の geometry が一致するか
    const curHash = geomHash(target.coordinates);
    if (rec.originalGeometryHash && rec.originalGeometryHash !== curHash) {
      errors.push({ correctionId: rec.correctionId, error: 'originalGeometryHash 不一致（元 geometry が変わった。補正レコードを更新せよ）', expected: rec.originalGeometryHash, actual: curHash });
      continue;
    }
    let res;
    if (rec.operation === 'split-multipolygon-parts') res = applySplitMultipolygon(target, rec);
    else if (rec.operation === 'reclassify') res = applyReclassify(target, rec);
    else { errors.push({ correctionId: rec.correctionId, error: '未実装 operation: ' + rec.operation }); continue; }

    if (res.error) { errors.push({ correctionId: rec.correctionId, error: res.error, detail: res }); continue; }
    byId.set(target.canonicalId, res.keptFeature);
    for (const nf of res.splitOffFeatures) { byId.set(nf.canonicalId, nf); added.push(nf.canonicalId); }
    applied.push(res.applied);
  }

  return {
    features: [...byId.values()],
    applied, errors,
    summary: { correctionsSeen: corrections.length, correctionsApplied: applied.length, correctionErrors: errors.length, featuresAdded: added.length },
  };
}
