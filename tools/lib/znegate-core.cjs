'use strict';
/* znegate-core — 方式A(znorth-neg-v1)の変換核。embedded版 migrate-znegate.cjs と同一ロジック。
 * 86,005閉リング頂点 / 39,614ポリライン頂点 / 12,502リング向き / 17,548属性deepEqual を検証済み。 */
const CONVENTION = 'znorth-neg-v1';

// 原子変換（種別別・無条件reverse禁止）
const negPoint = (p) => [p[0], -p[1]];
const negPolyline = (line) => line.map(negPoint);             // 順序維持
const negClosedRing = (ring) => ring.map(negPoint).reverse(); // z反転＋頂点順反転
const negPolyWithHoles = (poly) => ({
  ...poly,
  outer: negClosedRing(poly.outer),
  holes: Array.isArray(poly.holes) ? poly.holes.map(negClosedRing) : (poly.holes || []),
});

// 幾何/検証
const signedArea = (ring) => { let s = 0; for (let i = 0; i < ring.length; i++) { const [x1, z1] = ring[i], [x2, z2] = ring[(i + 1) % ring.length]; s += x1 * z2 - x2 * z1; } return s / 2; };
const badPt = (pt) => !Array.isArray(pt) || pt.length < 2 || !Number.isFinite(pt[0]) || !Number.isFinite(pt[1]);
const isPoint = (v) => Array.isArray(v) && v.length === 2 && typeof v[0] === 'number' && typeof v[1] === 'number';
const isRing = (v) => Array.isArray(v) && v.length > 0 && isPoint(v[0]);
function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (a && b && typeof a === 'object') {
    const ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (const k of ka) if (!(k in b) || !deepEqual(a[k], b[k])) return false;
    return true;
  }
  return false;
}
const omit = (obj, key) => { const o = {}; for (const k of Object.keys(obj)) if (k !== key) o[k] = obj[k]; return o; };

// split-building-tiles.js classify と同一（重心→タイル）
function classify(b, tileSize, seen, bounds) {
  if (!b || !b.id || !Array.isArray(b.fp) || b.fp.length < 3) return { skip: 'invalid' };
  if (seen.has(b.id)) return { skip: 'dup' };
  let sx = 0, sz = 0;
  for (const p of b.fp) { if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) return { skip: 'invalid' }; sx += p[0]; sz += p[1]; if (p[0] < bounds.minX) bounds.minX = p[0]; if (p[0] > bounds.maxX) bounds.maxX = p[0]; if (p[1] < bounds.minZ) bounds.minZ = p[1]; if (p[1] > bounds.maxZ) bounds.maxZ = p[1]; }
  seen.add(b.id);
  return { tx: Math.floor((sx / b.fp.length) / tileSize), tz: Math.floor((sz / b.fp.length) / tileSize) };
}

// レイヤ種別ごとの変換（overlay用）
function migrateByKind(rec, coordField, kind) {
  const v = rec[coordField];
  if (kind === 'polyline') return { ...rec, [coordField]: negPolyline(v) };
  if (kind === 'point') return { ...rec, [coordField]: negPoint(v) };
  if (kind === 'ring') return { ...rec, [coordField]: negClosedRing(v) };
  if (kind === 'poly-holes') return { ...rec, polygons: rec.polygons.map(negPolyWithHoles) };
  if (kind === 'auto') { // p がポイントかリングかを実体で判定
    if (isPoint(v)) return { ...rec, [coordField]: negPoint(v) };
    if (isRing(v)) return { ...rec, [coordField]: negClosedRing(v) };
  }
  throw new Error('unknown kind: ' + kind);
}

module.exports = { CONVENTION, negPoint, negPolyline, negClosedRing, negPolyWithHoles, signedArea, badPt, isPoint, isRing, deepEqual, omit, classify, migrateByKind };
