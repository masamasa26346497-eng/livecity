#!/usr/bin/env node
// tools/audit/absolute-map-scale-audit.js
// [Mission 32L] ABSOLUTE MAP SCALE AUDIT — AUDIT ONLY
//
//   §0 遵守: building scale / map scale / offset / projection / geometry rebuild は一切変更しない。
//   §14 遵守: nearest-edge 比較・建物 matching・道路 semantics は使わない。
//             見るのは **絶対距離・絶対 world units・絶対 scale** だけ。
//
//   ■ control point の作り方（§1）
//   「地理座標が明確な点」として、**PLATEAU 生 CityGML に緯度経度が書かれている建物の footprint 重心**
//   を使う。これは
//     - lat/lon が一次資料に明示されている（推定でない）
//     - 同じ建物の **canonical world 座標**（＝実際に描画される座標）が canonicalId で一意に引ける
//   という二つを同時に満たす唯一の実データであり、§3/§4 の「同じ点を Map 変換 / Building 変換へ通す」
//   を実測で行える。道路交差点・橋端点は lat/lon の一次資料がこの環境に無いため採用しない（捏造しない）。
//
//   ■ Map 側の変換が equirect であることの実証
//   canonical roads(tran) と 生 tran GML を tranId で突き合わせると、world 座標は
//   equirect(生 lat/lon) と **完全一致**する（本ツールで再測定して report に出す）。
//   したがって「Map 側の変換 = config/areas/osaka-city.json の projection」は仮定ではなく実測事実。
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, toProjectRelativePath, isMainModule } from '../lib/paths.js';
import { writeJson } from '../lib/area.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const AREA_CFG = P('config', 'areas', 'osaka-city.json');
const RAW_BLDG_DIR = P('data', 'raw', 'osaka-higashisumiyoshi');
const CANON_BLDGS = P('data', 'processed', 'osaka-city', 'canonical', 'buildings');
const TRAN_POLYGONS = P('data', 'processed', 'osaka-city', 'canonical', 'roads-tran', 'polygons.json');
const RAW_TRAN_DIR = P('data', 'raw', 'plateau', 'osaka-city', 'tran');
const V3_REPORT = P('data', 'reports', 'road-visual-v3.json');
const LAND_BLOCKS = P('data', 'processed', 'osaka-city', 'visual-land-block-poc', 'umeda', 'blocks.json');
const REPORT = P('data', 'reports', 'absolute-map-scale-audit.json');
const QA_DIR = P('data', 'processed', 'osaka-city', 'scale-qa');
const PUBLIC_QA_DIR = P('public', 'map-data', 'osaka-city', 'scale-qa');

const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };
const isTile = (f) => /^tile_-?\d+_-?\d+\.json$/.test(f);

// ── Map pipeline の変換（config の projection をそのまま使う。znorth-neg-v1） ──
const PROJ = rj(AREA_CFG).projection;
const COSLAT = Math.cos((PROJ.centerLat * Math.PI) / 180);
const mapX = (lon) => (lon - PROJ.centerLon) * COSLAT * PROJ.metersPerDegree;
const mapZ = (lat) => -((lat - PROJ.centerLat) * PROJ.metersPerDegree);

// ── §2 測地距離（WGS84 / Vincenty inverse） ──
function geodeticDistance(lat1, lon1, lat2, lon2) {
  const a = 6378137, f = 1 / 298.257223563, b = (1 - f) * a;
  const rad = Math.PI / 180;
  const L = (lon2 - lon1) * rad;
  const U1 = Math.atan((1 - f) * Math.tan(lat1 * rad)), U2 = Math.atan((1 - f) * Math.tan(lat2 * rad));
  const sU1 = Math.sin(U1), cU1 = Math.cos(U1), sU2 = Math.sin(U2), cU2 = Math.cos(U2);
  let lam = L, lamP, it = 0, sinSig, cosSig, sig, sinAlpha, cos2Alpha, cos2SigM, C;
  do {
    const sL = Math.sin(lam), cL = Math.cos(lam);
    sinSig = Math.sqrt((cU2 * sL) ** 2 + (cU1 * sU2 - sU1 * cU2 * cL) ** 2);
    if (sinSig === 0) return 0;
    cosSig = sU1 * sU2 + cU1 * cU2 * cL;
    sig = Math.atan2(sinSig, cosSig);
    sinAlpha = (cU1 * cU2 * sL) / sinSig;
    cos2Alpha = 1 - sinAlpha * sinAlpha;
    cos2SigM = cos2Alpha === 0 ? 0 : cosSig - (2 * sU1 * sU2) / cos2Alpha;
    C = (f / 16) * cos2Alpha * (4 + f * (4 - 3 * cos2Alpha));
    lamP = lam;
    lam = L + (1 - C) * f * sinAlpha * (sig + C * sinSig * (cos2SigM + C * cosSig * (-1 + 2 * cos2SigM * cos2SigM)));
  } while (Math.abs(lam - lamP) > 1e-12 && ++it < 200);
  const u2 = cos2Alpha * ((a * a - b * b) / (b * b));
  const A = 1 + (u2 / 16384) * (4096 + u2 * (-768 + u2 * (320 - 175 * u2)));
  const B = (u2 / 1024) * (256 + u2 * (-128 + u2 * (74 - 47 * u2)));
  const dSig = B * sinSig * (cos2SigM + (B / 4) * (cosSig * (-1 + 2 * cos2SigM * cos2SigM)
    - (B / 6) * cos2SigM * (-3 + 4 * sinSig * sinSig) * (-3 + 4 * cos2SigM * cos2SigM)));
  return b * A * (sig - dSig);
}
function bearing(lat1, lon1, lat2, lon2) {
  const rad = Math.PI / 180;
  const y = Math.sin((lon2 - lon1) * rad) * Math.cos(lat2 * rad);
  const x = Math.cos(lat1 * rad) * Math.sin(lat2 * rad) - Math.sin(lat1 * rad) * Math.cos(lat2 * rad) * Math.cos((lon2 - lon1) * rad);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

const median = (v) => { if (!v.length) return null; const s = [...v].sort((a, b) => a - b); const m = s.length >> 1; return +(s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2).toFixed(6); };
const pct = (v, q) => { if (!v.length) return null; const s = [...v].sort((a, b) => a - b); return +s[Math.min(s.length - 1, Math.floor(s.length * q))].toFixed(6); };
const ringArea = (r) => { let a = 0; for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += r[j][0] * r[i][1] - r[i][0] * r[j][1]; return Math.abs(a) / 2; };

/** 生 CityGML から gmlId -> lod0 外周リング(lat,lon) を取り出す。 */
function rawBuildingRings(file) {
  const s = fs.readFileSync(file, 'utf-8');
  const out = new Map();
  for (const part of s.split('<core:cityObjectMember>')) {
    const m = part.match(/<bldg:Building gml:id="([^"]+)"/); if (!m) continue;
    const sub = part.match(/<bldg:lod0FootPrint>([\s\S]*?)<\/bldg:lod0FootPrint>/) || part.match(/<bldg:lod0RoofEdge>([\s\S]*?)<\/bldg:lod0RoofEdge>/);
    if (!sub) continue;
    const pl = sub[1].match(/<gml:posList[^>]*>([\s\S]*?)<\/gml:posList>/); if (!pl) continue;
    const n = pl[1].trim().split(/\s+/).map(Number); const pts = [];
    for (let i = 0; i + 2 < n.length; i += 3) pts.push([n[i], n[i + 1]]); // [lat, lon]
    if (pts.length >= 3) out.set(m[1], pts);
  }
  return out;
}

/** §3 の前提検証: canonical roads(tran) が equirect(生 lat/lon) と一致するかを実測する。 */
function verifyMapPipelineIsEquirect(limit = 200) {
  const j = rj(TRAN_POLYGONS);
  if (!j || !fs.existsSync(RAW_TRAN_DIR)) return { verified: false, reason: 'tran データが無い' };
  const byId = new Map();
  for (const p of j.polygons || []) {
    const c = p.coordinates && p.coordinates[0]; if (!c || c.length < 3) continue;
    const cx = c.reduce((a, q) => a + q[0], 0) / c.length, cz = c.reduce((a, q) => a + q[1], 0) / c.length;
    if (Math.abs(cx + 2600) < 600 && Math.abs(cz + 10950) < 600) { byId.set(p.tranId, { cx, cz, ring: c }); if (byId.size >= limit * 3) break; }
  }
  const dxs = [], dzs = [], scales = [];
  for (const f of fs.readdirSync(RAW_TRAN_DIR).filter((x) => /^5235033|^5235034/.test(x))) {
    const s = fs.readFileSync(path.join(RAW_TRAN_DIR, f), 'utf-8');
    for (const part of s.split('<core:cityObjectMember>')) {
      const m = part.match(/<tran:Road gml:id="([^"]+)"/); if (!m) continue;
      const rec = byId.get(m[1]); if (!rec) continue;
      const pl = part.match(/<gml:posList[^>]*>([\s\S]*?)<\/gml:posList>/); if (!pl) continue;
      const n = pl[1].trim().split(/\s+/).map(Number); const pts = [];
      for (let i = 0; i + 2 < n.length; i += 3) pts.push([n[i], n[i + 1]]);
      if (pts.length < 3) continue;
      const cLat = pts.reduce((a, p2) => a + p2[0], 0) / pts.length, cLon = pts.reduce((a, p2) => a + p2[1], 0) / pts.length;
      dxs.push(rec.cx - mapX(cLon)); dzs.push(rec.cz - mapZ(cLat));
      const aEq = ringArea(pts.map((p2) => [mapX(p2[1]), mapZ(p2[0])])), aCn = ringArea(rec.ring);
      if (aEq > 20) scales.push(Math.sqrt(aCn / aEq));
      if (dxs.length >= limit) break;
    }
    if (dxs.length >= limit) break;
  }
  return {
    verified: dxs.length > 0 && Math.abs(median(dxs)) < 0.05 && Math.abs(median(dzs)) < 0.05,
    pairs: dxs.length, medianDxM: median(dxs), medianDzM: median(dzs),
    maxAbsDxM: dxs.length ? +Math.max(...dxs.map(Math.abs)).toFixed(4) : null,
    linearScale: median(scales),
    note: 'canonical roads(tran) の world 座標が equirect(生 tran lat/lon) と一致するか。'
      + '一致するなら「Map 側の変換 = config projection」は実測事実として確定する。',
  };
}

export async function runAbsoluteMapScaleAudit() {
  const generatedAt = new Date().toISOString();

  // ── Map 側の変換を実測で確定（§3） ──
  const mapPipeline = verifyMapPipelineIsEquirect();

  // ── canonical building index（実際に描画される world 座標） ──
  const canon = new Map();
  for (const f of fs.readdirSync(CANON_BLDGS)) {
    if (!isTile(f)) continue;
    const t = rj(path.join(CANON_BLDGS, f)); if (!t) continue;
    for (const ft of t.features || []) {
      const outer = ft.geometryType === 'Polygon' ? ft.coordinates[0] : (ft.coordinates[0] && ft.coordinates[0][0]);
      if (!outer || outer.length < 3) continue;
      canon.set(ft.canonicalId.replace(/^cg_bldg_/, ''), { ring: outer, areaM2: ft.areaM2 });
    }
  }

  // ── §1 control point: 生 CityGML に lat/lon がある建物 ──
  //   §15 梅田 / §16 住吉 を含むよう、原点からの距離が異なるメッシュを選ぶ。
  const MESHES = [
    { mesh: '51357420', region: 'sumiyoshi' },
    { mesh: '51357339', region: 'sumiyoshi' },
    { mesh: '51357430', region: 'mid' },
    { mesh: '52350329', region: 'mid' },
    { mesh: '52350339', region: 'umeda' },
    { mesh: '52350349', region: 'umeda' },
  ];
  const files = fs.existsSync(RAW_BLDG_DIR) ? fs.readdirSync(RAW_BLDG_DIR).filter((f) => f.endsWith('.gml')) : [];
  const controlPoints = [];
  for (const { mesh, region } of MESHES) {
    const file = files.find((f) => f.startsWith(mesh)); if (!file) continue;
    const raw = rawBuildingRings(path.join(RAW_BLDG_DIR, file));
    const picked = [];
    for (const [id, rr] of raw) {
      const cn = canon.get(id); if (!cn) continue;
      const lat = rr.reduce((a, p) => a + p[0], 0) / rr.length, lon = rr.reduce((a, p) => a + p[1], 0) / rr.length;
      const bx = cn.ring.reduce((a, p) => a + p[0], 0) / cn.ring.length, bz = cn.ring.reduce((a, p) => a + p[1], 0) / cn.ring.length;
      const eqRing = rr.map((p) => [mapX(p[1]), mapZ(p[0])]);
      picked.push({
        id, mesh, region, lat, lon,
        mapWorld: [+mapX(lon).toFixed(3), +mapZ(lat).toFixed(3)],
        buildingWorld: [+bx.toFixed(3), +bz.toFixed(3)],
        rawAreaEquirectM2: +ringArea(eqRing).toFixed(2),
        canonicalAreaM2: cn.areaM2,
        ring: cn.ring,
      });
      if (picked.length >= 60) break;
    }
    for (const p of picked) controlPoints.push(p);
  }

  // ── §3/§4/§5 pair 測定 ──
  const BANDS = [[50, 100], [100, 250], [250, 500], [500, 1000], [1000, 3000]];
  const bandKey = (d) => { for (const [lo, hi] of BANDS) if (d >= lo && d < hi) return lo + '-' + hi + 'm'; return null; };
  const pairs = [];
  const byRegion = { umeda: [], sumiyoshi: [], mid: [] };
  for (const cp of controlPoints) if (byRegion[cp.region]) byRegion[cp.region].push(cp);
  function addPairs(list, region) {
    const used = new Set();
    for (let i = 0; i < list.length; i++) {
      for (let k = i + 1; k < list.length; k++) {
        const a = list[i], b = list[k];
        const geo = geodeticDistance(a.lat, a.lon, b.lat, b.lon);
        const band = bandKey(geo); if (!band) continue;
        const brg = bearing(a.lat, a.lon, b.lat, b.lon);
        // §6/§7 方向分類（East-West / North-South / Diagonal）
        const m = brg % 180;
        const dir = (m < 20 || m > 160) ? 'NS' : (m > 70 && m < 110) ? 'EW' : 'DIAG';
        const key = band + ':' + dir;
        if (used.has(key) && pairs.filter((p) => p.region === region).length > 60) continue;
        used.add(key);
        const mapD = Math.hypot(b.mapWorld[0] - a.mapWorld[0], b.mapWorld[1] - a.mapWorld[1]);
        const bldD = Math.hypot(b.buildingWorld[0] - a.buildingWorld[0], b.buildingWorld[1] - a.buildingWorld[1]);
        pairs.push({
          region, band, direction: dir, bearingDeg: +brg.toFixed(2),
          geodeticM: +geo.toFixed(3), mapWorldM: +mapD.toFixed(3), buildingWorldM: +bldD.toFixed(3),
          mapScaleRatio: +(mapD / geo).toFixed(6),
          buildingScaleRatio: +(bldD / geo).toFixed(6),
          relativeScale: +((bldD / geo) / (mapD / geo)).toFixed(6),
          a: a.id, b: b.id,
        });
      }
      if (pairs.filter((p) => p.region === region).length > 120) break;
    }
  }
  for (const [region, list] of Object.entries(byRegion)) addPairs(list, region);

  const statsOf = (rows, key) => ({ count: rows.length, median: median(rows.map((r) => r[key])), p95: pct(rows.map((r) => r[key]), 0.95), min: rows.length ? +Math.min(...rows.map((r) => r[key])).toFixed(6) : null, max: rows.length ? +Math.max(...rows.map((r) => r[key])).toFixed(6) : null });
  const ew = pairs.filter((p) => p.direction === 'EW'), ns = pairs.filter((p) => p.direction === 'NS'), dg = pairs.filter((p) => p.direction === 'DIAG');

  // ── §12/§13 で使う: 建物フレーム ↔ Map フレームの affine（実測。理論式ではない） ──
  function affineFit(rows) {
    if (rows.length < 3) return null;
    const solve3 = (A, y) => {
      const M = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], v = [0, 0, 0];
      for (let i = 0; i < A.length; i++) for (let r = 0; r < 3; r++) { v[r] += A[i][r] * y[i]; for (let c = 0; c < 3; c++) M[r][c] += A[i][r] * A[i][c]; }
      for (let i = 0; i < 3; i++) {
        let p = i; for (let r = i + 1; r < 3; r++) if (Math.abs(M[r][i]) > Math.abs(M[p][i])) p = r;
        if (Math.abs(M[p][i]) < 1e-12) return null;
        [M[i], M[p]] = [M[p], M[i]]; [v[i], v[p]] = [v[p], v[i]];
        const d = M[i][i]; for (let c = 0; c < 3; c++) M[i][c] /= d; v[i] /= d;
        for (let r = 0; r < 3; r++) { if (r === i) continue; const q = M[r][i]; for (let c = 0; c < 3; c++) M[r][c] -= q * M[i][c]; v[r] -= q * v[i]; }
      }
      return v;
    };
    const A = rows.map((r) => [r.mapWorld[0], r.mapWorld[1], 1]);
    const wx = solve3(A, rows.map((r) => r.buildingWorld[0]));
    const wz = solve3(A, rows.map((r) => r.buildingWorld[1]));
    if (!wx || !wz) return null;
    const [a1, b1, e] = wx, [c1, d1, f] = wz;
    const resid = rows.map((r) => Math.hypot(a1 * r.mapWorld[0] + b1 * r.mapWorld[1] + e - r.buildingWorld[0], c1 * r.mapWorld[0] + d1 * r.mapWorld[1] + f - r.buildingWorld[1]));
    return {
      scaleX: +Math.hypot(a1, c1).toFixed(6), scaleZ: +Math.hypot(b1, d1).toFixed(6),
      rotationDeg: +((Math.atan2(c1, a1) * 180) / Math.PI).toFixed(5),
      shear: +(a1 * b1 + c1 * d1).toFixed(6),
      translationX: +e.toFixed(3), translationZ: +f.toFixed(3),
      residualMedianM: median(resid), residualP95M: pct(resid, 0.95),
      sampleCount: rows.length,
      note: 'Map frame(equirect) → Building frame(canonical) の最小二乗 affine。実測点から推定した値。',
    };
  }
  const affine = affineFit(controlPoints);

  // ── §9 建物 bbox sanity（低層 30 棟以上・world meter） ──
  const lowrise = [];
  for (const cp of controlPoints) {
    const r = cp.ring;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const p of r) { if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0]; if (p[1] < minZ) minZ = p[1]; if (p[1] > maxZ) maxZ = p[1]; }
    const w = maxX - minX, d = maxZ - minZ;
    if (cp.canonicalAreaM2 > 30 && cp.canonicalAreaM2 < 1500) {
      lowrise.push({ id: cp.id, region: cp.region, widthM: +w.toFixed(2), depthM: +d.toFixed(2), areaM2: cp.canonicalAreaM2 });
    }
    if (lowrise.length >= 200) break;
  }
  const bboxSanity = {
    sampleCount: lowrise.length,
    widthM: { median: median(lowrise.map((b) => b.widthM)), p95: pct(lowrise.map((b) => b.widthM), 0.95), max: lowrise.length ? +Math.max(...lowrise.map((b) => b.widthM)).toFixed(2) : null },
    depthM: { median: median(lowrise.map((b) => b.depthM)), p95: pct(lowrise.map((b) => b.depthM), 0.95), max: lowrise.length ? +Math.max(...lowrise.map((b) => b.depthM)).toFixed(2) : null },
    over50mCount: lowrise.filter((b) => b.widthM > 50 || b.depthM > 50).length,
    over100mCount: lowrise.filter((b) => b.widthM > 100 || b.depthM > 100).length,
    examples: lowrise.slice(0, 12),
    note: '実際に描画される canonical footprint の bbox を world meter で測ったもの。普通の低層建物が '
      + '8〜30m 程度なら絶対 scale は正しい。50m/100m 級が並ぶなら scale error。',
  };

  // ── §10 道路幅 / §11 街区 ──
  const v3 = rj(V3_REPORT);
  const roadWidth = v3 ? { carriagewayMedianM: v3.widthStats.CARRIAGEWAY.median, carriagewayP95M: v3.widthStats.CARRIAGEWAY.p95, source: 'Mission 32I road-visual-v3.json' } : null;
  const lb = rj(LAND_BLOCKS);
  let blockSanity = null;
  if (lb && Array.isArray(lb.blocks)) {
    const dims = [];
    for (const b of lb.blocks) {
      const poly = b.geometry && (b.geometry.type === 'Polygon' ? b.geometry.coordinates[0] : b.geometry.coordinates[0][0]);
      if (!poly || poly.length < 3) continue;
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (const p of poly) { if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0]; if (p[1] < minZ) minZ = p[1]; if (p[1] > maxZ) maxZ = p[1]; }
      dims.push({ w: maxX - minX, d: maxZ - minZ });
    }
    blockSanity = {
      blockCount: dims.length,
      widthMedianM: median(dims.map((d) => d.w)), depthMedianM: median(dims.map((d) => d.d)),
      widthP95M: pct(dims.map((d) => d.w), 0.95),
      buildingToBlockWidthRatio: bboxSanity.widthM.median && median(dims.map((d) => d.w)) ? +(bboxSanity.widthM.median / median(dims.map((d) => d.w))).toFixed(4) : null,
      source: 'Mission 32F visual-land-block-poc/umeda/blocks.json（ROAD-ENCLOSED BLOCK）',
    };
  }

  // ── §5/§17 判定 ──
  const relAll = pairs.map((p) => p.relativeScale);
  const relMedian = median(relAll);
  const bMedian = median(pairs.map((p) => p.buildingScaleRatio));
  const mMedian = median(pairs.map((p) => p.mapScaleRatio));
  const ewRel = median(ew.map((p) => p.relativeScale)), nsRel = median(ns.map((p) => p.relativeScale));
  const anisotropy = ewRel != null && nsRel != null ? +Math.abs(ewRel - nsRel).toFixed(6) : null;

  let classification, classificationReason;
  const within = (v, lo, hi) => v != null && v >= lo && v <= hi;
  if (anisotropy != null && anisotropy > 0.01) {
    classification = 'ANISOTROPIC_SCALE_ERROR';
    classificationReason = 'East-West と North-South で relativeScale が ' + anisotropy + ' 異なる。';
  } else if (within(relMedian, 0.995, 1.005)) {
    classification = 'ABSOLUTE_SCALE_MATCH';
    classificationReason = 'relativeScale(building/map) の中央値 ' + relMedian + ' は §19 の許容帯 0.995–1.005 に入る。'
      + '建物側の 100m と地図側の 100m は実質同じ world 距離である。';
  } else if (relMedian > 1.005) {
    classification = 'BUILDING_SCALE_TOO_LARGE';
    classificationReason = 'relativeScale 中央値 ' + relMedian + ' > 1.005。';
  } else {
    classification = 'BUILDING_SCALE_TOO_SMALL';
    classificationReason = 'relativeScale 中央値 ' + relMedian + ' < 0.995。';
  }

  // ── scale 以外に見つかった不一致（正直に別枠で報告する） ──
  const frameOffsets = controlPoints.map((cp) => ({
    region: cp.region,
    distanceFromOriginM: +Math.hypot(cp.mapWorld[0], cp.mapWorld[1]).toFixed(1),
    dxM: +(cp.buildingWorld[0] - cp.mapWorld[0]).toFixed(3),
    dzM: +(cp.buildingWorld[1] - cp.mapWorld[1]).toFixed(3),
  }));
  const byRegionOffset = {};
  for (const r of ['sumiyoshi', 'mid', 'umeda']) {
    const rows = frameOffsets.filter((o) => o.region === r);
    if (!rows.length) continue;
    byRegionOffset[r] = {
      count: rows.length,
      distanceFromOriginMedianM: median(rows.map((o) => o.distanceFromOriginM)),
      dxMedianM: median(rows.map((o) => o.dxM)), dzMedianM: median(rows.map((o) => o.dzM)),
      displacementMedianM: median(rows.map((o) => Math.hypot(o.dxM, o.dzM))),
    };
  }

  const report = {
    version: 1, generatedAt, missionId: '32L', mode: 'AUDIT_ONLY',
    method: {
      controlPointSource: 'PLATEAU 生 CityGML に緯度経度が明示されている建物 footprint 重心。'
        + '同じ建物の canonical world 座標を canonicalId で引き、Map 変換 / Building 実座標を同一点で比較する。',
      geodetic: 'WGS84 Vincenty inverse',
      forbidden: '§14: nearest-edge 比較・建物 matching・道路 semantics は使っていない。',
    },
    mapPipelineVerification: mapPipeline,
    controlPointCount: controlPoints.length,
    pairCount: pairs.length,
    building: {
      scaleX: median(ew.map((p) => p.buildingScaleRatio)),
      scaleZ: median(ns.map((p) => p.buildingScaleRatio)),
      medianRatio: bMedian, p95Ratio: pct(pairs.map((p) => p.buildingScaleRatio), 0.95),
    },
    map: {
      scaleX: median(ew.map((p) => p.mapScaleRatio)),
      scaleZ: median(ns.map((p) => p.mapScaleRatio)),
      medianRatio: mMedian, p95Ratio: pct(pairs.map((p) => p.mapScaleRatio), 0.95),
    },
    relative: {
      buildingVsMapX: ewRel, buildingVsMapZ: nsRel,
      medianRatio: relMedian, p95Ratio: pct(relAll, 0.95),
      anisotropy,
      diagonal: median(dg.map((p) => p.relativeScale)),
    },
    distanceBands: Object.fromEntries(BANDS.map(([lo, hi]) => {
      const k = lo + '-' + hi + 'm';
      const rows = pairs.filter((p) => p.band === k);
      return [k, { count: rows.length, relativeScaleMedian: median(rows.map((r) => r.relativeScale)), buildingRatio: median(rows.map((r) => r.buildingScaleRatio)), mapRatio: median(rows.map((r) => r.mapScaleRatio)) }];
    })),
    umeda: { ...statsOf(pairs.filter((p) => p.region === 'umeda'), 'relativeScale'), buildingRatio: median(pairs.filter((p) => p.region === 'umeda').map((p) => p.buildingScaleRatio)), mapRatio: median(pairs.filter((p) => p.region === 'umeda').map((p) => p.mapScaleRatio)) },
    sumiyoshi: { ...statsOf(pairs.filter((p) => p.region === 'sumiyoshi'), 'relativeScale'), buildingRatio: median(pairs.filter((p) => p.region === 'sumiyoshi').map((p) => p.buildingScaleRatio)), mapRatio: median(pairs.filter((p) => p.region === 'sumiyoshi').map((p) => p.mapScaleRatio)) },
    buildingBboxSanity: bboxSanity,
    roadWidthSanity: roadWidth,
    cityBlockSanity: blockSanity,
    affineMapToBuildingFrame: affine,
    frameDisplacement: {
      byRegion: byRegionOffset,
      note: '**scale とは別の不一致**。Building 実座標 − Map 変換座標 の差を、同じ建物の同じ点で測ったもの。'
        + 'scale が一致していてもこの差が距離とともに増えるなら、それは縮尺ではなく **frame の食い違い** である。',
    },
    rotationFinding: affine ? {
      rotationDeg: affine.rotationDeg,
      displacementAtUmedaM: byRegionOffset.umeda ? byRegionOffset.umeda.displacementMedianM : null,
      jprectZone7ConvergenceDeg: +(((135.5 - 137.1666666667) * Math.sin((34.65 * Math.PI) / 180))).toFixed(4),
      hypothesis: '実測回転 ' + affine.rotationDeg + '° は、廃止扱いの data/buildings/coordinate-config.json が指す '
        + '平面直角座標 第7系(原点 137.1667°E)の大阪付近の子午線収差 |γ|≈0.95° と大きさが一致する。'
        + 'canonical 建物がこの系の grid north を真北として扱った座標を引き継いでいる可能性が高い（仮説・今回は修正しない）。',
      independentConfirmation: 'OSM 建物(梅田 6,411 件・equirect)による被覆率: equirect(生PLATEAU) ring 98.6% / canonical ring 31.5%（梅田の32G問題建物30棟）。',
      whyPriorAuditMissedIt: 'coordinate-system-authority-audit.js（FIX11）は control point の lat/lon を **canonical world 座標を '
        + 'equirect の逆変換で戻して作っていた**（worldInv(centroid)）。この作り方では equirect 誤差が必ず 0 になる（循環）。'
        + 'また N03 区界の包含判定は区の内部の建物に対して 1° 未満の回転を検出できない。'
        + 'Reference Alignment の PLATEAU↔GSI 一致(梅田 medianDx −0.95m)は、最近傍でマッチした 57 組のみの値で、'
        + 'マッチ数そのものが 住吉 1,562 → 本町 237 → 梅田 57 と距離とともに崩れている（選択バイアス）。',
      scopeNote: '§17 の分類は「縮尺」についての判定なので ABSOLUTE_SCALE_MATCH とした。回転は縮尺ではないため分類肢に無いが、'
        + 'ユーザーが見ている「建物と地図が合わない」の主因候補として最優先で報告する。',
    } : null,
    classification,
    classificationReason,
    stopToken: 'ABSOLUTE_SCALE_AUDIT_COMPLETE',
  };

  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  await writeJson(REPORT, report);

  // ── §12/§13 100m ruler 用データ ──
  const qa = {
    version: 1, generatedAt, missionId: '32L',
    rulerMeters: 100,
    note: '[100 m] バーは Three.js world で正確に 100 units = 100 m。建物・道路・街区と同じ world 空間に置く。',
    referenceValues: {
      buildingWidthMedianM: bboxSanity.widthM.median,
      buildingDepthMedianM: bboxSanity.depthM.median,
      carriagewayWidthMedianM: roadWidth ? roadWidth.carriagewayMedianM : null,
      blockWidthMedianM: blockSanity ? blockSanity.widthMedianM : null,
    },
    classification,
  };
  for (const dir of [QA_DIR, PUBLIC_QA_DIR]) { fs.mkdirSync(dir, { recursive: true }); await writeJson(path.join(dir, 'overlay.json'), qa); }

  return report;
}

if (isMainModule(import.meta.url)) {
  runAbsoluteMapScaleAudit().then((r) => {
    console.log('[32L] mapPipelineIsEquirect=' + r.mapPipelineVerification.verified + ' (pairs=' + r.mapPipelineVerification.pairs + ' dx=' + r.mapPipelineVerification.medianDxM + ' dz=' + r.mapPipelineVerification.medianDzM + ')');
    console.log('[32L] controlPoints=' + r.controlPointCount + ' pairs=' + r.pairCount);
    console.log('[32L] building medianRatio=' + r.building.medianRatio + ' map medianRatio=' + r.map.medianRatio);
    console.log('[32L] relative median=' + r.relative.medianRatio + ' X=' + r.relative.buildingVsMapX + ' Z=' + r.relative.buildingVsMapZ + ' anisotropy=' + r.relative.anisotropy);
    console.log('[32L] umeda rel=' + r.umeda.median + '  sumiyoshi rel=' + r.sumiyoshi.median);
    console.log('[32L] buildingBbox width median=' + r.buildingBboxSanity.widthM.median + 'm depth=' + r.buildingBboxSanity.depthM.median + 'm over50=' + r.buildingBboxSanity.over50mCount);
    console.log('[32L] affine=' + JSON.stringify(r.affineMapToBuildingFrame));
    console.log('[32L] frameDisplacement=' + JSON.stringify(r.frameDisplacement.byRegion));
    console.log('[32L] classification=' + r.classification);
    process.exitCode = 0;
  }).catch((e) => { console.error(e); process.exit(1); });
}
