// tools/lib/ward-classification-validator.js
// P1-3: Ward polygon データセット（tools/build-ward-polygons.js の出力）の検証。
// 例外は投げず、構造化された結果を返す。
//
// 検証項目（P1-3指令）:
//  - 24 Ward polygon すべて存在 / wardId重複なし / registry外Wardなし
//  - finite coordinates / polygon ring正常
//  - 既存3区（住吉区・東住吉区・平野区）が正しく判定される
//  - 大阪市外点がどの区にも分類されない
//  - 各区は自分の内部点を自分の区として判定し、他区へは吸われない（相互排他）

import { classifyPointToWard, pointInRing } from './point-in-polygon.js';
import { representativePoint } from './building-representative-point.js';

const KNOWN_WARDS = ['sumiyoshi', 'higashisumiyoshi', 'hirano'];

// 明確に大阪市外の点（znorth-neg-v1 ローカル座標。原点は住吉区付近。数十km離れた点）。
const OUTSIDE_CITY_PROBES = [
  [200000, 0], [-200000, 0], [0, 200000], [0, -200000], [500000, 500000],
];

function check(name, pass, detail, severity = 'error') {
  return { name, pass, detail, severity };
}

function ringInterior(ring) {
  const rp = representativePoint(ring);
  if (rp.valid && pointInRing(rp.x, rp.z, ring)) return [rp.x, rp.z];
  const [a, b, c] = ring;
  return [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3];
}

function largestPolygonInterior(ward) {
  let best = null, bestArea = -1;
  for (const poly of ward.polygons) {
    // outer bbox 面積を代理に使う（大きい polygon を選ぶだけの用途）
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const [x, z] of poly.outer) {
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    const a = (maxX - minX) * (maxZ - minZ);
    if (a > bestArea) { bestArea = a; best = poly; }
  }
  return best ? ringInterior(best.outer) : null;
}

/**
 * @param {{wards:Array, coordinateConvention?:string}} payload
 * @param {{city?:string, wards:object[]}} registry
 * @param {{extraProbes?:Array<{x:number,z:number,expect:string|null,label?:string}>}} [options]
 */
export function validateWardClassification(payload, registry, options = {}) {
  const checks = [];
  const wardReports = [];

  if (!payload || !Array.isArray(payload.wards)) {
    return { ok: false, checks: [check('payload-shape', false, 'payload.wards が配列ではありません。')], wardReports: [] };
  }
  if (!registry || !Array.isArray(registry.wards)) {
    return { ok: false, checks: [check('registry-shape', false, 'registry.wards が配列ではありません。')], wardReports: [] };
  }

  const wards = payload.wards;
  const registryById = new Map(registry.wards.map((w) => [w.id, w]));

  // ── 網羅・一意・registry整合 ──
  const idCounts = new Map();
  for (const w of wards) idCounts.set(w.wardId, (idCounts.get(w.wardId) || 0) + 1);
  const dup = [...idCounts.entries()].filter(([, c]) => c > 1).map(([id]) => id);
  const missing = registry.wards.filter((w) => !idCounts.has(w.id)).map((w) => w.name);
  const unknown = [...idCounts.keys()].filter((id) => !registryById.has(id));

  checks.push(check('all-24-wards-present', missing.length === 0, missing.length ? `未生成: ${missing.join('、')}` : '24区すべて存在'));
  checks.push(check('no-duplicate-wardId', dup.length === 0, dup.length ? `重複: ${dup.join(', ')}` : 'OK'));
  checks.push(check('no-registry-external-ward', unknown.length === 0, unknown.length ? `registry外: ${unknown.join(', ')}` : 'OK'));

  let identityMismatch = 0;
  let nonFinite = 0;
  let badRings = 0;
  let emptyWards = 0;

  for (const w of wards) {
    const reg = registryById.get(w.wardId);
    if (reg && (reg.code !== w.wardCode || reg.name !== w.wardName)) identityMismatch++;

    if (!Array.isArray(w.polygons) || w.polygons.length === 0) { emptyWards++; }
    let wardNonFinite = 0, wardBadRings = 0, ringCount = 0, holeCount = 0;
    for (const poly of (w.polygons || [])) {
      for (const ring of [poly.outer, ...(poly.holes || [])]) {
        ringCount++;
        if (!Array.isArray(ring) || ring.length < 4) { wardBadRings++; continue; }
        const closed = ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1];
        if (!closed) wardBadRings++;
        for (const p of ring) {
          if (!Array.isArray(p) || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) wardNonFinite++;
        }
      }
      holeCount += (poly.holes || []).length;
    }
    nonFinite += wardNonFinite;
    badRings += wardBadRings;
    wardReports.push({
      wardId: w.wardId, wardName: w.wardName, wardCode: w.wardCode,
      polygonCount: (w.polygons || []).length, holeCount, ringCount,
      nonFiniteCoords: wardNonFinite, badRings: wardBadRings,
    });
  }

  checks.push(check('ward-identity-matches-registry', identityMismatch === 0, identityMismatch ? `${identityMismatch}区でcode/nameがregistryと不一致` : 'OK'));
  checks.push(check('coords-finite', nonFinite === 0, nonFinite ? `非有限座標 ${nonFinite}点` : 'OK'));
  checks.push(check('rings-valid', badRings === 0, badRings ? `不正リング ${badRings}本（3点未満/未閉合）` : 'OK'));
  checks.push(check('no-empty-wards', emptyWards === 0, emptyWards ? `polygon 0 の区 ${emptyWards}` : 'OK'));

  // ── 相互排他: 各区は自分の内部点を自分の区として判定する ──
  let selfMisclassified = [];
  for (const w of wards) {
    const interior = largestPolygonInterior(w);
    if (!interior) continue;
    const r = classifyPointToWard(interior[0], interior[1], wards);
    if (r.wardId !== w.wardId) {
      selfMisclassified.push(`${w.wardName}(→${r.wardId || r.status})`);
    }
  }
  checks.push(check('wards-self-consistent', selfMisclassified.length === 0,
    selfMisclassified.length ? `内部点が自区へ分類されない: ${selfMisclassified.join(', ')}` : '全24区で内部点→自区'));

  // ── 既存3区が正しく判定される ──
  const knownPresent = KNOWN_WARDS.filter((id) => idCounts.has(id));
  let knownOk = knownPresent.length === KNOWN_WARDS.length;
  const knownDetail = [];
  if (!knownOk) knownDetail.push(`欠落: ${KNOWN_WARDS.filter((id) => !idCounts.has(id)).join(', ')}`);
  for (const id of knownPresent) {
    const w = wards.find((x) => x.wardId === id);
    const interior = largestPolygonInterior(w);
    if (!interior) { knownOk = false; knownDetail.push(`${id}: 内部点取得不可`); continue; }
    const r = classifyPointToWard(interior[0], interior[1], wards);
    if (r.wardId !== id) { knownOk = false; knownDetail.push(`${w.wardName}: 内部点→${r.wardId || r.status}`); }
  }
  checks.push(check('known-3-wards-classify', knownOk, knownDetail.length ? knownDetail.join(' / ') : '住吉区・東住吉区・平野区の内部点が正しく自区へ'));

  // ── 大阪市外点はどの区にも分類されない ──
  let insideCityFalsePositive = [];
  for (const [x, z] of OUTSIDE_CITY_PROBES) {
    const r = classifyPointToWard(x, z, wards);
    if (r.wardId !== null) insideCityFalsePositive.push(`(${x},${z})→${r.wardId}`);
  }
  checks.push(check('outside-city-unclassified', insideCityFalsePositive.length === 0,
    insideCityFalsePositive.length ? `市外点が区へ分類された: ${insideCityFalsePositive.join(', ')}` : 'OK'));

  // ── 追加プローブ（fixtureテスト等から） ──
  for (const probe of options.extraProbes || []) {
    const r = classifyPointToWard(probe.x, probe.z, wards);
    checks.push(check(`probe:${probe.label || `${probe.x},${probe.z}`}`,
      r.wardId === probe.expect,
      `期待 ${probe.expect} / 実際 ${r.wardId || r.status}`));
  }

  const errorFails = checks.filter((c) => !c.pass && c.severity === 'error');
  return {
    ok: errorFails.length === 0,
    checks,
    wardReports,
    summary: {
      wardCount: wards.length,
      registryWardCount: registry.wards.length,
      coordinateConvention: payload.coordinateConvention || null,
      errorFailCount: errorFails.length,
    },
  };
}
