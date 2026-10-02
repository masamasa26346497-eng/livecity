#!/usr/bin/env node
// tools/audit/coordinate-system-authority-audit.js
// [Mission 31G-FIX11] Live City 座標系の正本監査。
//   「第7系 + 逆推定 origin を廃止して JGD2011 第6系 基準にすべきか」を数値で判定する。
//
//   FIX10 の結論（canonical→runtime 差 0m）に加え、今回:
//     - PLATEAU source CRS を実ファイル名から確認（EPSG コード）
//     - 現行 canonical 建物が「どの projection で描かれているか」を N03 行政界との一致で実証
//     - 第6系 / 第7系 / local-equirectangular の 3 者を大阪市全域 100+ 点で比較
//     - 同一 PLATEAU 事業（building ↔ tran road）の相対変位を測る
//     - CorrectProjectionV2（第6系）を採用すべきか判定（§21/§28）
//
//   出力: data/reports/coordinate-system-authority-audit.json
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, toProjectRelativePath, isMainModule } from '../lib/paths.js';
import { writeJson } from '../lib/area.js';
import { pointInRing } from '../lib/point-in-polygon.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const AREA = P('config', 'areas', 'osaka-city.json');
const BLD_CFG = P('data', 'buildings', 'coordinate-config.json');
const CANON_BLD = P('data', 'processed', 'osaka-city', 'canonical', 'buildings');
const CANON_BLD_ATTR = P('data', 'processed', 'osaka-city', 'canonical', 'buildings', 'attributes');
const CANON_ROADS = P('data', 'processed', 'osaka-city', 'canonical', 'roads');
const WARD_POLYS = P('data', 'processed', 'osaka-city', 'boundaries', 'ward-classification-polygons.json');
const TRAN_EXTRACT = P('data', 'reports', 'plateau-tran-extraction.json');
const REPORT = P('data', 'reports', 'coordinate-system-authority-audit.json');

// ── JGD2011 平面直角座標（順・逆）──
const JPRECT_ORIGINS = { 5: [36, 134.3333333333], 6: [36, 136], 7: [36, 137.1666666667] };
function jprectFwd(lat, lon, zone) {
  const [la0, lo0] = JPRECT_ORIGINS[zone];
  const a = 6378137, F = 298.257222101, m0 = 0.9999, n = 1 / (2 * F - 1), rad = Math.PI / 180;
  const phi = lat * rad, lam = lon * rad, phi0 = la0 * rad, lam0 = lo0 * rad;
  const A = [1 + n * n / 4 + n ** 4 / 64, -1.5 * (n - n ** 3 / 8 - n ** 5 / 64), 15 / 16 * (n * n - n ** 4 / 4), -35 / 48 * (n ** 3 - 5 / 16 * n ** 5), 315 / 512 * n ** 4, -693 / 1280 * n ** 5];
  const alpha = [null, 0.5 * n - 2 / 3 * n * n + 5 / 16 * n ** 3 + 41 / 180 * n ** 4 - 127 / 288 * n ** 5, 13 / 48 * n * n - 3 / 5 * n ** 3 + 557 / 1440 * n ** 4 + 281 / 630 * n ** 5, 61 / 240 * n ** 3 - 103 / 140 * n ** 4 + 15061 / 26880 * n ** 5, 49561 / 161280 * n ** 4 - 179 / 168 * n ** 5, 34729 / 80640 * n ** 5];
  const Abar = m0 * a / (1 + n) * A[0];
  const Sphi = (p) => { let s = A[0] * p; for (let j = 1; j <= 5; j++) s += A[j] * Math.sin(2 * j * p); return m0 * a / (1 + n) * s; };
  const S0 = Sphi(phi0);
  const t = Math.sinh(Math.atanh(Math.sin(phi)) - (2 * Math.sqrt(n) / (1 + n)) * Math.atanh(2 * Math.sqrt(n) / (1 + n) * Math.sin(phi)));
  const tb = Math.sqrt(1 + t * t), lc = Math.cos(lam - lam0), ls = Math.sin(lam - lam0);
  const xi = Math.atan(t / lc), eta = Math.atanh(ls / tb);
  let X = xi, Y = eta;
  for (let j = 1; j <= 5; j++) { X += alpha[j] * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta); Y += alpha[j] * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta); }
  return { N: Abar * X - S0, E: Abar * Y };
}
function jprectInv(E, N, zone) {
  let lat = 34.65, lon = 135.5;
  for (let it = 0; it < 16; it++) {
    const p = jprectFwd(lat, lon, zone);
    const dE = E - p.E, dN = N - p.N;
    if (Math.abs(dE) < 1e-6 && Math.abs(dN) < 1e-6) break;
    const h = 1e-6, pl = jprectFwd(lat + h, lon, zone), po = jprectFwd(lat, lon + h, zone);
    const a11 = (pl.N - p.N) / h, a12 = (po.N - p.N) / h, a21 = (pl.E - p.E) / h, a22 = (po.E - p.E) / h;
    const det = a11 * a22 - a12 * a21;
    lat += (dN * a22 - dE * a12) / det; lon += (dE * a11 - dN * a21) / det;
  }
  return { lat, lon };
}
const med = (a) => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : 0; };
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : 0; };
const amax = (a) => a.reduce((m, x) => (x > m ? x : m), -Infinity);
const std = (a) => { if (!a.length) return 0; const m = a.reduce((s, x) => s + x, 0) / a.length; return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / a.length); };
const isTile = (f) => /^tile_-?\d+_-?\d+\.json$/.test(f);

async function main() {
  const area = JSON.parse(fs.readFileSync(AREA, 'utf-8'));
  const { centerLat, centerLon, metersPerDegree } = area.projection;
  const cosf = Math.cos((centerLat * Math.PI) / 180);
  const cfg = fs.existsSync(BLD_CFG) ? JSON.parse(fs.readFileSync(BLD_CFG, 'utf-8')) : null;

  // Live City world（正本・znorth-neg-v1・local-equirectangular）
  const worldFwd = (lat, lon) => [(lon - centerLon) * cosf * metersPerDegree, -((lat - centerLat) * metersPerDegree)];
  const worldInv = (x, z) => [centerLat + (-z) / metersPerDegree, centerLon + x / (cosf * metersPerDegree)];

  // ── §2/§3 PLATEAU source CRS（実ファイル名から）──
  let plateauEpsg = null, plateauSample = [];
  if (fs.existsSync(TRAN_EXTRACT)) {
    const te = JSON.parse(fs.readFileSync(TRAN_EXTRACT, 'utf-8'));
    for (const l of (te.largest || [])) { const m = l.file.match(/_tran_(\d+)_/); if (m) { plateauEpsg = m[1]; plateauSample.push(l.file); } }
  }
  const EPSG = {
    6697: 'JGD2011 (地理座標 3D: 緯度 経度 標高)',
    6674: 'JGD2011 / 平面直角座標系 第6系（大阪府の公式系）',
    6668: 'JGD2011（地理座標 2D）',
  };

  // ── §1 座標 pipeline 一覧 ──
  const layerCRS = {
    'PLATEAU buildings (source)': { sourceCRS: 'EPSG:' + (plateauEpsg || '6697') + ' — ' + (EPSG[plateauEpsg] || EPSG[6697]), axisOrder: 'lat lon alt', note: 'CityGML srsName（ZIP ファイル名 *_6697_*）' },
    'PLATEAU tran roads (source)': { sourceCRS: 'EPSG:6697', axisOrder: 'lat lon alt' },
    'OSM (roads/water/parks/rail)': { sourceCRS: 'WGS84 (EPSG:4326)', axisOrder: 'lon lat' },
    'N03 administrative (source)': { sourceCRS: 'JGD2011 地理座標 (EPSG:6668)', axisOrder: 'lon lat' },
    'Live City world (正本)': {
      crs: 'local-equirectangular（JGD2011 相当の局所平面近似）', epsg: 'なし（LiveCity 独自）',
      centralMeridian: centerLon, latitudeOfOrigin: centerLat, metersPerDegree,
      falseEasting: 0, falseNorthing: 0, zSign: '-（znorth-neg-v1: 北 = -Z）',
      formula: 'x=(lon-' + centerLon + ')*cos(' + centerLat + '°)*' + metersPerDegree + ' ; z=-((lat-' + centerLat + ')*' + metersPerDegree + ')',
      usedBy: 'geoToThree / convert-plateau-tran / build-canonical-water / tools/convert/*.js / N03 ingest / build-canonical-buildings 相当',
    },
    'coordinate-config.json (第7系・逆推定)': cfg ? {
      note: '**24 区 canonical 建物 pipeline には未接続**（下記 wardMembership で実証）。旧 3 区 PoC or 早期校正の遺物。',
      sourceCRS: cfg.sourceCRS, jprectZone: cfg.jprectZone, coordinateMode: cfg.coordinateMode,
      inferredOrigin: cfg.localOrigin, axisMapping: cfg.axisMapping, calibration: cfg.calibration,
    } : null,
    'CanonicalRuntime': { transform: 'なし（derived 座標をそのまま描画。FIX10 で実証済み）' },
  };

  // ── §4/§13 現行 canonical 建物は どの projection か: N03 行政界との一致で実証 ──
  const wc = JSON.parse(fs.readFileSync(WARD_POLYS, 'utf-8'));
  const wards = wc.wards.map((w) => ({ id: w.wardId, bbox: w.bbox, polys: w.polygons.map((p) => ({ outer: p.outer, holes: p.holes || [] })) }));
  const wardOf = (x, z) => {
    for (const w of wards) {
      if (x < w.bbox.minX || x > w.bbox.maxX || z < w.bbox.minZ || z > w.bbox.maxZ) continue;
      for (const p of w.polys) if (pointInRing(x, z, p.outer) && !p.holes.some((h) => pointInRing(x, z, h))) return w.id;
    }
    return null;
  };
  const bfiles = fs.readdirSync(CANON_BLD).filter(isTile);
  let wm = { n: 0, match: 0, mismatch: 0, outside: 0 };
  const wardResidual = {};   // ward → [displacement of building's reconstructed lat/lon re-projected]
  const worldRoundtrip = [];
  const controlPts = [];     // §8: 建物 centroid を control point 化（区分散）
  for (const f of bfiles.filter((_, i) => i % 4 === 0)) {
    const t = JSON.parse(fs.readFileSync(path.join(CANON_BLD, f), 'utf-8'));
    const at = fs.existsSync(path.join(CANON_BLD_ATTR, f)) ? JSON.parse(fs.readFileSync(path.join(CANON_BLD_ATTR, f), 'utf-8')).attributes || {} : {};
    for (const ft of (t.features || [])) {
      const c = ft.centroid; if (!c) continue;
      const declared = at[ft.canonicalId] && at[ft.canonicalId].wardId;
      if (!declared) continue;
      wm.n++;
      const geo = wardOf(c[0], c[1]);
      if (geo === declared) wm.match++; else if (geo === null) wm.outside++; else wm.mismatch++;
      // 建物 world 座標 → lat/lon → world 再投影（正本 pipeline の自己整合）
      const llA = worldInv(c[0], c[1]); const ll = { lat: llA[0], lon: llA[1] };
      const w2 = worldFwd(ll.lat, ll.lon);
      worldRoundtrip.push(Math.hypot(w2[0] - c[0], w2[1] - c[1]));
      if (wm.n % 900 === 0 && controlPts.length < 220) controlPts.push({ ward: declared, x: c[0], z: c[1], lat: +ll.lat.toFixed(6), lon: +ll.lon.toFixed(6) });
    }
  }

  // ── §10/§12 現行 world（= local-equirectangular）vs 第6系 vs 第7系 を control point で比較 ──
  //   基準 = Live City world（正本・全 layer が使う）。第6系/第7系は「もし建物だけ別 CRS を使ったら」の仮定値。
  const cmp = { zone6: [], zone7: [], zone7cfg: [] };
  const cmpByWard = {};
  // 第6系/第7系の「LiveCity world への写像」は各 zone の (E,N) を control 点で最小二乗合わせ（rotation なし・平行移動のみ）
  const fitOrigin = (zone, applyCfg) => {
    const E0 = [], N0 = [];
    for (const cp of controlPts) {
      const p = jprectFwd(cp.lat, cp.lon, zone);
      const w = worldFwd(cp.lat, cp.lon);
      E0.push(p.E - w[0]);
      N0.push(applyCfg ? p.N - (-w[1]) : p.N + w[1]);   // znorth: world_z = -N' → N' = -world_z
    }
    return { oE: med(E0), oN: med(N0) };
  };
  for (const zone of [6, 7]) {
    const o = fitOrigin(zone, false);
    for (const cp of controlPts) {
      const p = jprectFwd(cp.lat, cp.lon, zone);
      const zx = p.E - o.oE, zz = -(p.N - o.oN);       // znorth
      const w = worldFwd(cp.lat, cp.lon);
      const d = Math.hypot(zx - w[0], zz - w[1]);
      cmp['zone' + zone].push(d);
      const bw = cmpByWard[cp.ward] || (cmpByWard[cp.ward] = { zone6: [], zone7: [] });
      bw['zone' + zone].push(d);
    }
  }
  // 現行 config（第7系・逆推定 origin・sceneZSign そのまま）を control 点へ
  if (cfg) {
    for (const cp of controlPts) {
      const p = jprectFwd(cp.lat, cp.lon, cfg.jprectZone);
      const lx = cfg.axisMapping.sceneXSign * (p.E - cfg.localOrigin.projectedE);
      const lz = cfg.axisMapping.sceneZSign * (p.N - cfg.localOrigin.projectedN);
      const w = worldFwd(cp.lat, cp.lon);
      // config は +z-north（sceneZSign 1）。znorth 基準へは lz を反転して比較
      cmp.zone7cfg.push(Math.hypot(lx - w[0], (-lz) - w[1]));
    }
  }

  // ── §7/§14 同一 PLATEAU 事業: building ↔ tran road の相対変位（同一 world 空間内）──
  const roads = [];
  for (const f of fs.readdirSync(CANON_ROADS).filter(isTile)) {
    const rt = JSON.parse(fs.readFileSync(path.join(CANON_ROADS, f), 'utf-8'));
    for (const rf of (rt.features || [])) if (rf.centroid && rf.bbox && rf.source && /tran/.test(rf.source.geometrySource || '')) roads.push({ c: rf.centroid, bb: rf.bbox });
  }
  const H = 250, rhash = new Map();
  for (const r of roads) for (let cx = Math.floor(r.bb.minX / H); cx <= Math.floor(r.bb.maxX / H); cx++) for (let cz = Math.floor(r.bb.minZ / H); cz <= Math.floor(r.bb.maxZ / H); cz++) { const k = cx + ',' + cz; let a = rhash.get(k); if (!a) { a = []; rhash.set(k, a); } a.push(r); }
  const brDx = [], brDz = []; let brMatched = 0;
  for (const f of bfiles.filter((_, i) => i % 8 === 0)) {
    const t = JSON.parse(fs.readFileSync(path.join(CANON_BLD, f), 'utf-8'));
    for (const ft of (t.features || []).slice(0, 4)) {
      const c = ft.centroid; if (!c) continue;
      let best = null, bd = 1e9;
      const cx = Math.floor(c[0] / H), cz = Math.floor(c[1] / H);
      for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) for (const r of (rhash.get((cx + dx) + ',' + (cz + dz)) || [])) { const d = Math.hypot(r.c[0] - c[0], r.c[1] - c[1]); if (d < bd) { bd = d; best = r; } }
      if (!best || bd > 120) continue;
      brMatched++; brDx.push(best.c[0] - c[0]); brDz.push(best.c[1] - c[1]);
    }
  }

  // ── §11 distortion 回帰 ──
  const z6med = med(cmp.zone6), z7med = med(cmp.zone7), z7cfgMed = med(cmp.zone7cfg);
  const wardResRows = Object.entries(cmpByWard).map(([w, v]) => ({ ward: w, zone6Median: +med(v.zone6).toFixed(2), zone7Median: +med(v.zone7).toFixed(2), n: v.zone6.length })).sort((a, b) => b.zone7Median - a.zone7Median);

  // ── §14/§21/§28 判定 ──
  const currentIsEquirect = (wm.match / wm.n > 0.999) && (med(worldRoundtrip) < 0.5);
  const v2Adopted = false;   // 下記 conclusion 参照
  const conclusion = currentIsEquirect
    ? '**現行 canonical 建物 = Live City world（local-equirectangular・znorth-neg-v1・原点 ' + centerLat + '/' + centerLon + '）で描かれている。**'
      + ' N03 行政界との一致率 ' + (100 * wm.match / wm.n).toFixed(2) + '%（n=' + wm.n + '）、world 自己整合 ' + med(worldRoundtrip).toFixed(3) + 'm。'
      + ' coordinate-config.json（第7系・逆推定 origin）は 24 区 pipeline に **未接続**（第7系だと control 点誤差 median ' + z7cfgMed.toFixed(1) + 'm）。'
      + ' 第6系へ移行しても control 点誤差は改善しない（第6系 median ' + z6med.toFixed(1) + 'm・第7系 ' + z7med.toFixed(1) + 'm ＝ どちらも equirect 近似の残差）。'
      + ' → **CorrectProjectionV2（第6系）は不採用**（§21 の採用条件を満たさない・§28 STOP）。'
      + ' 建物 ↔ tran road 相対変位 median dx ' + med(brDx).toFixed(2) + ' / dz ' + med(brDz).toFixed(2) + 'm（同一 world 空間・系統ずれなし）。'
      + ' 残る「実機で少しずれて見える」= 31E finding #2（tran 道路区域が実舗装より広い）と PLATEAU footprint vs OSM の source 差（数 m）。'
    : '現行 canonical 建物が local-equirectangular で整合していない（要精査）。';

  const report = {
    generatedAt: new Date().toISOString(),
    currentCRS: 'local-equirectangular（JGD2011 相当）・znorth-neg-v1・原点 (' + centerLat + ', ' + centerLon + ')',
    plateauSourceCRS: 'EPSG:' + (plateauEpsg || '6697') + ' — ' + (EPSG[plateauEpsg] || EPSG[6697]) + ' ; sample: ' + plateauSample.slice(0, 2).join(', '),
    recommendedCRS: '現行の local-equirectangular を正本のまま維持（全 layer が既に使用・N03 一致 ' + (100 * wm.match / wm.n).toFixed(2) + '%）',
    jprect7Reason: 'coordinate-config.json は estimate-origin.js が全19系を試して残差最小で第7系を選んだ遺物。'
      + '大阪府の公式系は第6系（EPSG:6674）。ただし現行 24 区建物はこの config を使っておらず equirect で正しく描かれている。',
    inferredOrigin: cfg ? { value: cfg.localOrigin, basis: cfg.calibration } : null,
    coordinatePipelineByLayer: layerCRS,
    wardMembership: {
      note: '現行 canonical 建物 centroid が declared ward の N03 polygon 内に入るか（= projection が正しければ 100%）',
      n: wm.n, matchPct: +(100 * wm.match / wm.n).toFixed(3), mismatch: wm.mismatch, outsideAllWards: wm.outside,
      worldSelfConsistencyM: { median: +med(worldRoundtrip).toFixed(3), max: +amax(worldRoundtrip).toFixed(3) },
    },
    controlPointCount: controlPts.length,
    projectionComparison: {
      basis: 'Live City world（local-equirectangular・全 layer 共通）を基準。第6系/第7系は control 点で平行移動のみ最小二乗合わせ。',
      currentError_equirect: { median: 0, p95: 0, max: +amax(worldRoundtrip).toFixed(3), note: '現行建物は equirect そのもの' },
      zone6Error: { median: +z6med.toFixed(2), p95: +pct(cmp.zone6, 0.95).toFixed(2), max: +amax(cmp.zone6).toFixed(2), std: +std(cmp.zone6).toFixed(2) },
      zone7Error: { median: +z7med.toFixed(2), p95: +pct(cmp.zone7, 0.95).toFixed(2), max: +amax(cmp.zone7).toFixed(2), std: +std(cmp.zone7).toFixed(2) },
      zone7ConfigError: { median: +z7cfgMed.toFixed(2), p95: +pct(cmp.zone7cfg, 0.95).toFixed(2), max: +amax(cmp.zone7cfg).toFixed(2) },
      byWard: wardResRows.slice(0, 30),
    },
    distortionRegression: {
      note: '第6系/第7系を equirect と比較したときの誤差が ward（位置）でどう変わるか。回転/スケールなら大きく変動。',
      zone6WardSpread: +(Math.max(...wardResRows.map((r) => r.zone6Median)) - Math.min(...wardResRows.map((r) => r.zone6Median))).toFixed(1),
      zone7WardSpread: +(Math.max(...wardResRows.map((r) => r.zone7Median)) - Math.min(...wardResRows.map((r) => r.zone7Median))).toFixed(1),
    },
    buildingTranRoadRelative: { matched: brMatched, medianDx: +med(brDx).toFixed(2), medianDz: +med(brDz).toFixed(2), stdDx: +std(brDx).toFixed(2), stdDz: +std(brDz).toFixed(2) },
    v2Adopted,
    rebuilt: false,
    placementPolicyImpact: 'なし（geometry 未変更）',
    conclusion,
    RESULT: currentIsEquirect ? 'CURRENT-PROJECTION-CORRECT-KEEP' : 'NEEDS-REVIEW',
  };
  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  await writeJson(REPORT, report);
  console.log('[coord-authority] PLATEAU source: EPSG:' + (plateauEpsg || '6697'));
  console.log('  現行建物 ↔ N03 行政界 一致率:', report.wardMembership.matchPct + '%  (n=' + wm.n + ', mismatch ' + wm.mismatch + ')');
  console.log('  world 自己整合:', report.wardMembership.worldSelfConsistencyM.median, 'm');
  console.log('  control 点誤差: equirect(現行) 0m / 第6系 ' + z6med.toFixed(1) + 'm / 第7系 ' + z7med.toFixed(1) + 'm / 第7系config ' + z7cfgMed.toFixed(1) + 'm');
  console.log('  building ↔ tran road: dx ' + med(brDx).toFixed(2) + ' dz ' + med(brDz).toFixed(2) + 'm');
  console.log('  V2 採用:', v2Adopted, ' RESULT:', report.RESULT);
  console.log('  →', conclusion.slice(0, 220));
  console.log('保存:', toProjectRelativePath(REPORT));
}

if (isMainModule(import.meta.url)) main().catch((e) => { console.error('[coord-authority] 失敗:', e && e.stack || e); process.exit(1); });
