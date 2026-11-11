#!/usr/bin/env node
// Mission 89: 道路(tran)・水域(wtr) と建物の位置整合の「独立」検査器（read-only・無通信・削除/コピー無し）。
//   node tools/mission89-roadwater-verify.mjs --ward <id> --tran <dir> [--wtr <dir>] --thresholds <file> [--root temp/mission80] [--out report.json] [--fixture]
// 設計（要点）:
//  * 建物は絶対に動かさない。道路/水域レイヤー側にだけ候補変換（反転/回転/平行移動）を当て、「変換なし(identity)」が最良かを見る。
//    建物は道路上に載らない → 正しい変換は建物重心の道路ポリゴン内ヒット率が最小になる。向きの誤りはヒット率を上げる。
//  * 道路と水域の交差・隣接（橋・暗渠・護岸）は誤差として数えない。使う信号は「建物×道路」「建物×水域」だけで、道路×水域の交差は評価しない。
//  * 閾値は既定値を持たない。--thresholds に basis(根拠) と approvedBy が無ければ数値は報告するが status は unverified。
//  * 年版/メッシュ対応: tran/wtr の各 GML は source-lock の entries(kind,mesh,name) に載っていることを要求する。
//    現行 lock は bldg/tran のみで wtr を持たない → water は unverified（捏造しない）。road と water の両方が verified で初めて roadWater=verified。
//  * 高さ基準: 本検査は水平(x,z)のみ。垂直方向(標高/Cesium地表)は未比較で verticalChecked=false と明記する。
//  * fixture / CI は origin により local-pc 受入にならない（Mission88 の detectOrigin を再利用）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256Buf, sha256File, canonicalJson, detectOrigin, pointInRing, pointInWard, readOutput } from './mission88-collect-evidence.mjs';

export const METHOD = 'roadwater-independent-v1';
export const VINTAGE = 2025;
export const MIN_BASIS_LEN = 20;

export function projectLatLon(lat, lon, p) {
  return [(lon - p.centerLon) * Math.cos(p.centerLat * Math.PI / 180) * p.metersPerDegree, -(lat - p.centerLat) * p.metersPerDegree];
}

// GML の外周リング列を runtime 座標(x,z)へ。tag は 'tran:Road' / 'wtr:WaterBody' 等。軸順は検証し、仮定しない。
export function parseGmlRings(xml, tag, projection) {
  const feats = [];
  const esc = tag.replace(/[:.]/g, (c) => '\\' + c);
  const fre = new RegExp('<' + esc + '\\b[\\s\\S]*?</' + esc + '>', 'g');
  let m;
  while ((m = fre.exec(xml))) {
    const rings = [];
    const re = /<gml:posList[^>]*>([\s\S]*?)<\/gml:posList>/g;
    let q;
    while ((q = re.exec(m[0]))) {
      const n = q[1].trim().split(/\s+/).map(Number);
      const dim = n.length % 3 === 0 ? 3 : 2;
      const ring = [];
      for (let i = 0; i + dim - 1 < n.length; i += dim) {
        if (!(n[i] > 20 && n[i] < 50 && n[i + 1] > 120 && n[i + 1] < 150)) throw new Error('axis order is not lat,lon');
        ring.push(projectLatLon(n[i], n[i + 1], projection));
      }
      if (ring.length >= 4) rings.push(ring);
    }
    if (rings.length) feats.push(rings);
  }
  return feats;
}

const bboxOf = (ring) => {
  let a = 1e18, b = -1e18, c = 1e18, d = -1e18;
  for (const p of ring) { if (p[0] < a) a = p[0]; if (p[0] > b) b = p[0]; if (p[1] < c) c = p[1]; if (p[1] > d) d = p[1]; }
  return [a, b, c, d];
};

export const TRANSFORMS = {
  identity: ([x, z]) => [x, z],
  flipX: ([x, z]) => [-x, z],
  flipZ: ([x, z]) => [x, -z],
  rot180: ([x, z]) => [-x, -z],
  swapXZ: ([x, z]) => [z, x],
};

// features: [[ring,...],...]。重心周りに変換 f と平行移動 (dx,dz) を適用（レイヤー側のみ）。
export function transformLayer(features, f, dx = 0, dz = 0, center = null) {
  const all = features.flat(2);
  const c = center || (all.length ? [all.reduce((s, p) => s + p[0], 0) / all.length, all.reduce((s, p) => s + p[1], 0) / all.length] : [0, 0]);
  return features.map((rings) => rings.map((ring) => ring.map((p) => {
    const t = f([p[0] - c[0], p[1] - c[1]]);
    return [t[0] + c[0] + dx, t[1] + c[1] + dz];
  })));
}

export function hitCount(points, features) {
  const bbs = features.map((r) => bboxOf(r[0]));
  let hit = 0;
  for (const [x, z] of points) {
    for (let i = 0; i < features.length; i++) {
      const b = bbs[i];
      if (x < b[0] || x > b[1] || z < b[2] || z > b[3]) continue;
      if (pointInRing(x, z, features[i][0]) && !features[i].slice(1).some((h) => pointInRing(x, z, h))) { hit++; break; }
    }
  }
  return hit;
}

// 点→最寄りポリゴン外周線分の距離(m)。格子ハッシュ。maxR 以内に無ければ null。
export function nearestEdgeDistances(points, features, cell = 50, maxR = 200) {
  const grid = new Map();
  for (const rings of features) for (const ring of rings) for (let i = 0; i + 1 < ring.length; i++) {
    const a = ring[i], b = ring[i + 1];
    const x0 = Math.floor(Math.min(a[0], b[0]) / cell), x1 = Math.floor(Math.max(a[0], b[0]) / cell);
    const z0 = Math.floor(Math.min(a[1], b[1]) / cell), z1 = Math.floor(Math.max(a[1], b[1]) / cell);
    for (let gx = x0; gx <= x1; gx++) for (let gz = z0; gz <= z1; gz++) {
      const k = gx + '_' + gz;
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push([a, b]);
    }
  }
  const segDist = (px, pz, a, b) => {
    const vx = b[0] - a[0], vz = b[1] - a[1];
    const L = vx * vx + vz * vz;
    let t = L ? ((px - a[0]) * vx + (pz - a[1]) * vz) / L : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (a[0] + t * vx), pz - (a[1] + t * vz));
  };
  return points.map(([x, z]) => {
    let best = Infinity;
    const gx = Math.floor(x / cell), gz = Math.floor(z / cell), rr = Math.ceil(maxR / cell);
    for (let i = -rr; i <= rr; i++) for (let j = -rr; j <= rr; j++) {
      for (const [a, b] of grid.get((gx + i) + '_' + (gz + j)) || []) { const d = segDist(x, z, a, b); if (d < best) best = d; }
    }
    return best <= maxR ? best : null;
  });
}

const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };

// 1 レイヤー(道路 or 水域)の位置整合。しきい値 th が無ければ metrics だけ返し status は 'unverified'。
export function checkLayer({ name, features, buildingPts, th, shifts = [0, 5, 10, 20, 40] }) {
  if (!features.length) return { layer: name, status: 'unverified', reason: 'no ' + name + ' features supplied', features: 0, metrics: null };
  const samples = buildingPts.length;
  const cands = {};
  for (const [k, f] of Object.entries(TRANSFORMS)) cands[k] = hitCount(buildingPts, transformLayer(features, f));
  const ranked = Object.entries(cands).sort((a, b) => a[1] - b[1] || (a[0] === 'identity' ? -1 : 1));
  const identityHits = cands.identity;
  const margin = ranked.find(([k]) => k !== 'identity')[1] - identityHits;
  // 平行移動: identity の向きのまま (dx,dz) ずらして最小ヒットの移動量を探す（建物は動かさない）
  const grid = [];
  for (const s of shifts) {
    for (const [sx, sz] of s === 0 ? [[0, 0]] : [[s, 0], [-s, 0], [0, s], [0, -s]]) {
      grid.push({ dx: sx, dz: sz, mag: s, hits: hitCount(buildingPts, transformLayer(features, TRANSFORMS.identity, sx, sz)) });
    }
  }
  const bestShift = grid.slice().sort((a, b) => a.hits - b.hits || a.mag - b.mag)[0];
  const dist = nearestEdgeDistances(buildingPts, features).filter((d) => d !== null);
  const metrics = {
    samples, identityHits, identityHitRatePct: samples ? +(identityHits * 100 / samples).toFixed(3) : null, candidates: cands, bestTransform: ranked[0][0],
    orientationMargin: margin, estimatedOffsetM: bestShift.mag, bestShift: { dx: bestShift.dx, dz: bestShift.dz, hits: bestShift.hits }, shiftGrid: grid,
    nearestEdge: { withinRadius: dist.length, medianM: median(dist) },
  };
  const base = { layer: name, features: features.length, metrics };
  if (!th || !th.ok) return { ...base, status: 'unverified', reason: 'thresholds missing or without basis/approvedBy: ' + ((th && th.why) || 'none') };
  if (samples < th.minSamples) return { ...base, status: 'unverified', reason: 'samples ' + samples + ' < minSamples ' + th.minSamples };
  const why = [];
  if (metrics.bestTransform !== 'identity' || margin < th.minOrientationMargin) why.push('identity is not the best orientation by margin ' + th.minOrientationMargin + ' (best=' + metrics.bestTransform + ', margin=' + margin + ')');
  if (metrics.identityHitRatePct > th.maxBuildingHitRatePct) why.push('buildings-in-' + name + ' ' + metrics.identityHitRatePct + '% > ' + th.maxBuildingHitRatePct);
  if (metrics.estimatedOffsetM > th.maxOffsetM) why.push('estimated offset ' + metrics.estimatedOffsetM + 'm > ' + th.maxOffsetM);
  if (th.maxMedianNearestEdgeM != null && (metrics.nearestEdge.medianM === null || metrics.nearestEdge.medianM > th.maxMedianNearestEdgeM)) why.push('median nearest edge ' + metrics.nearestEdge.medianM + 'm > ' + th.maxMedianNearestEdgeM);
  return { ...base, status: why.length ? 'failed' : 'verified', reason: why.length ? why.join('; ') : 'all explicit thresholds met' };
}

export function loadThresholds(file, fsx = fs) {
  if (!file || !fsx.existsSync(file)) return { ok: false, why: 'no thresholds file' };
  let j;
  try { j = JSON.parse(fsx.readFileSync(file, 'utf8')); } catch { return { ok: false, why: 'thresholds file is not JSON' }; }
  if (typeof j.basis !== 'string' || j.basis.trim().length < MIN_BASIS_LEN) return { ok: false, why: 'basis missing or shorter than ' + MIN_BASIS_LEN + ' chars' };
  if (typeof j.approvedBy !== 'string' || !j.approvedBy.trim()) return { ok: false, why: 'approvedBy missing' };
  for (const k of ['minSamples', 'minOrientationMargin', 'maxBuildingHitRatePct', 'maxOffsetM']) {
    if (typeof j[k] !== 'number' || !Number.isFinite(j[k]) || j[k] < 0) return { ok: false, why: k + ' missing or not a non-negative number' };
  }
  return { ok: true, ...j };
}

// GML ファイルを source-lock に束縛: ファイル名の mesh が lock の同 kind エントリに在り、かつ ward のメッシュ集合に属すること。
export function bindToLock({ files, kind, lock, wardMeshes }) {
  const entries = (lock.entries || []).filter((e) => e.kind === kind);
  const bad = [];
  const meshes = new Set();
  for (const f of files) {
    const mesh = (path.basename(f).match(/^(\d{8})_/) || [])[1];
    if (!mesh) { bad.push(f + ': no mesh prefix'); continue; }
    const e = entries.find((x) => x.mesh === mesh && path.basename(x.name) === path.basename(f));
    if (!e) bad.push(path.basename(f) + ': not in source-lock ' + kind + ' entries (vintage/source not bound)');
    else if (!wardMeshes.includes(mesh)) bad.push(path.basename(f) + ': mesh ' + mesh + ' not in ward mesh list');
    else meshes.add(mesh);
  }
  return { ok: bad.length === 0 && files.length > 0, lockHasKind: entries.length > 0, bad, coveredMeshes: [...meshes].sort(), uncoveredMeshes: wardMeshes.filter((m) => !meshes.has(m)) };
}

export function integrityDigest(rep) { const { integrity, ...rest } = rep; void integrity; return sha256Buf(Buffer.from(canonicalJson(rest))); }

export function combine(road, water) {
  if (road.status === 'failed' || water.status === 'failed') return 'failed';
  return road.status === 'verified' && water.status === 'verified' ? 'verified' : 'unverified';
}

// 受入側(86/88)が証拠として受け取れる形か。ここを通らない報告は roadWater を pass にしない。
export function validateReport(rep, { ward, tilesetSha256, lockEtag }) {
  const bad = [];
  if (!rep || rep.kind !== 'roadwater-alignment' || rep.method !== METHOD) return ['not a ' + METHOD + ' report'];
  if (rep.ward !== ward) bad.push('ward mismatch');
  if (rep.vintage !== VINTAGE) bad.push('vintage must be ' + VINTAGE);
  if (rep.origin !== 'local-pc' || rep.fixture === true) bad.push('origin must be local-pc and not fixture (got ' + rep.origin + ')');
  if (!rep.integrity || rep.integrity.digest !== integrityDigest(rep)) bad.push('integrity digest mismatch');
  if (!rep.inputs || rep.inputs.tilesetSha256 !== tilesetSha256) bad.push('report not bound to this tileset.json sha256');
  if (!rep.inputs || !lockEtag || rep.inputs.lockEtag !== lockEtag) bad.push('report not bound to source-lock etag');
  if (rep.scope !== 'horizontal-only' || rep.verticalChecked !== false) bad.push('scope/verticalChecked must honestly state horizontal-only');
  if (!rep.thresholds || !rep.thresholds.basis || !rep.thresholds.approvedBy) bad.push('thresholds basis/approvedBy missing');
  return bad;
}

// 収集器用: 報告から roadWater 証拠を作る。条件を満たさなければ unverified/failed のまま。
export function toEvidence(rep, ctx) {
  const bad = validateReport(rep, ctx);
  if (bad.length) return { status: 'unverified', reason: 'road/water report rejected: ' + bad.join('; ') };
  const road = rep.road, water = rep.water;
  if (rep.status !== 'verified' || road.status !== 'verified' || water.status !== 'verified') {
    return { status: rep.status === 'failed' ? 'failed' : 'unverified', reason: 'road=' + road.status + ' water=' + water.status, method: METHOD };
  }
  return {
    status: 'verified', method: METHOD, vintage: VINTAGE, scope: rep.scope, verticalChecked: false, roadsChecked: road.features, waterChecked: water.features,
    samples: road.metrics.samples, maxOffsetM: Math.max(road.metrics.estimatedOffsetM, water.metrics.estimatedOffsetM), thresholds: rep.thresholds,
    reportDigest: rep.integrity.digest, inputs: rep.inputs,
  };
}

const rd = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const gmls = (d, re) => (d && fs.existsSync(d) ? fs.readdirSync(d).filter((n) => re.test(n)).sort().map((n) => path.join(d, n)) : []);

export function verify({ ward, root, tranDir, wtrDir, thresholdsFile, areaFile, lockFile, n03File, flags = {}, env = process.env }) {
  const o = detectOrigin(env, flags);
  const outDir = path.join(root, 'out', ward + '-2025');
  const lock = rd(lockFile), area = rd(areaFile), n03 = rd(n03File);
  const w = n03.wards.find((x) => x.wardId === ward);
  if (!w) throw new Error('no N03 polygon for ' + ward);
  if (!fs.existsSync(path.join(outDir, 'tileset.json'))) throw new Error('tileset.json not found: ' + outDir);
  const src = rd(path.join(outDir, 'source.json'));
  if (src.vintage !== VINTAGE) throw new Error('output source.json vintage is not ' + VINTAGE);
  const { byId } = readOutput(outDir);
  const pts = Object.values(byId).map((a) => [a[2], a[3]]);
  const wardMeshes = (src.sourceMeshes || []).slice();
  const th = loadThresholds(thresholdsFile);
  const layerOf = (dir, kind, re, tag) => {
    const files = gmls(dir, re);
    const fileInfo = () => files.map((f) => ({ name: path.basename(f), sha256: sha256File(f) }));
    if (!files.length) return { layer: kind, status: 'unverified', reason: 'no ' + kind + ' GML supplied', bind: null, features: 0, metrics: null, files: [] };
    const bind = bindToLock({ files, kind, lock, wardMeshes });
    if (!bind.lockHasKind) return { layer: kind, status: 'unverified', reason: 'source-lock has no ' + kind + ' entries; vintage/source of supplied files cannot be bound', bind, features: 0, metrics: null, files: fileInfo() };
    if (!bind.ok) return { layer: kind, status: 'failed', reason: 'lock/mesh binding failed: ' + bind.bad.join(' | '), bind, features: 0, metrics: null, files: fileInfo() };
    const feats = files.flatMap((f) => parseGmlRings(fs.readFileSync(f, 'utf8'), tag, area.projection));
    return { ...checkLayer({ name: kind, features: feats, buildingPts: pts, th }), bind, files: fileInfo() };
  };
  const road = layerOf(tranDir, 'tran', /_tran_.*\.gml$/i, 'tran:Road');
  const water = layerOf(wtrDir, 'wtr', /_wtr_.*\.gml$/i, 'wtr:WaterBody');
  const rep = {
    kind: 'roadwater-alignment', method: METHOD, version: '89.1', ward, vintage: VINTAGE, origin: o.origin, originReason: o.reason, fixture: o.fixture, executedAt: new Date().toISOString(),
    scope: 'horizontal-only', verticalChecked: false, verticalNote: 'elevation / Cesium terrain datum not compared; only planar x,z (znorth-neg-v1)',
    design: { buildingsMoved: false, transformsAppliedTo: 'road/water layer only', roadWaterCrossingScoredAsError: false,
      signals: ['building centroid inside road polygon', 'building centroid inside water polygon', 'orientation candidates', 'translation grid', 'median nearest edge'] },
    inputs: { lockEtag: (lock.http && lock.http.etag) || null, lockSha256: sha256File(lockFile), tilesetSha256: sha256File(path.join(outDir, 'tileset.json')), sourceJsonSha256: sha256File(path.join(outDir, 'source.json')),
      n03Sha256: sha256File(n03File), areaSha256: sha256File(areaFile), thresholdsSha256: thresholdsFile && fs.existsSync(thresholdsFile) ? sha256File(thresholdsFile) : null, buildingSamples: pts.length },
    thresholds: th.ok ? { basis: th.basis, approvedBy: th.approvedBy, minSamples: th.minSamples, minOrientationMargin: th.minOrientationMargin, maxBuildingHitRatePct: th.maxBuildingHitRatePct, maxOffsetM: th.maxOffsetM, maxMedianNearestEdgeM: th.maxMedianNearestEdgeM ?? null } : { missing: th.why },
    n03: { buildingPointsInsideWardPolygon: pts.filter(([x, z]) => pointInWard(x, z, w)).length, total: pts.length },
    coverage: { wardMeshes, tranCovered: road.bind ? road.bind.coveredMeshes : [], tranUncovered: road.bind ? road.bind.uncoveredMeshes : wardMeshes, wtrCovered: water.bind ? water.bind.coveredMeshes : [], wtrUncovered: water.bind ? water.bind.uncoveredMeshes : wardMeshes,
      note: 'uncovered meshes are NOT verified; absent tran in the official package is a warning, not a pass' },
    road, water,
  };
  rep.status = combine(road, water);
  rep.integrity = { alg: 'sha256-canonical-json', digest: integrityDigest(rep), note: 'tamper-evidence only; not a signature' };
  return rep;
}

function main() {
  const a = process.argv.slice(2);
  const opt = (k, d = null) => { const i = a.indexOf('--' + k); return i >= 0 && a[i + 1] !== undefined ? a[i + 1] : d; };
  const ward = opt('ward');
  if (!ward) { console.error('usage: node tools/mission89-roadwater-verify.mjs --ward <id> --tran <dir> [--wtr <dir>] --thresholds <file> [--root temp/mission80] [--out file]'); process.exit(64); }
  const abs = (v) => (v ? path.resolve(v) : null);
  const rep = verify({ ward, root: path.resolve(opt('root', 'temp/mission80')), tranDir: abs(opt('tran')), wtrDir: abs(opt('wtr')), thresholdsFile: abs(opt('thresholds')),
    areaFile: path.resolve(opt('area', 'config/areas/osaka-sumiyoshi.json')), lockFile: path.resolve(opt('lock', 'data/reports/mission79/source-lock.json')),
    n03File: path.resolve(opt('n03', 'data/processed/osaka-city/boundaries/ward-classification-polygons.json')), flags: { fixture: a.includes('--fixture') } });
  const out = path.resolve(opt('out', path.join('data/reports/mission89/roadwater', ward + (rep.origin === 'local-pc' ? '' : '.non-acceptance') + '.json')));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(rep, null, 1), { flag: 'wx' });   // 既存は上書きしない
  console.log(JSON.stringify({ ward, status: rep.status, road: [rep.road.status, rep.road.reason], water: [rep.water.status, rep.water.reason], origin: rep.origin, out }, null, 1));
  process.exitCode = rep.status === 'verified' ? 0 : rep.status === 'failed' ? 1 : 2;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try { main(); } catch (e) { console.error('FAILED', e && e.message); process.exit(1); }
}
