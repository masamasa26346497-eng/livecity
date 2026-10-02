#!/usr/bin/env node
// tools/audit/building-rotation-root-cause.js
// [Mission 32M] BUILDING ROTATION ROOT CAUSE AUDIT — AUDIT ONLY
//
//   §0: canonical building rebuild / rotation correction / road・projection・origin 変更 /
//       production 反映はすべて禁止。原因の特定だけを行う。
//   §11/§12: truth は **生 CityGML の lat/lon** と独立ソース（OSM / N03）だけ。
//            canonical から逆算した lat/lon は一切 truth に使わない（FIX11 の循環を繰り返さない）。
//
//   変換式は各スクリプトから**実コードをそのまま取り出して**使う（再実装した式で「たぶん同じ」とはしない）:
//     - 建物側: tools/convert-plateau-buildings.js の latLonToJPRect()
//     - 地図側: config/areas/osaka-city.json の projection（tools/lib/city-tile-grid.js と同式）
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import readline from 'node:readline';
import { resolveProjectPath, toProjectRelativePath, isMainModule } from '../lib/paths.js';
import { writeJson } from '../lib/area.js';
import { pbfPrimitiveStream } from '../lib/osm-pbf-stream.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const F = {
  converter: P('tools', 'convert-plateau-buildings.js'),
  buildingConfig: P('data', 'buildings', 'coordinate-config.json'),
  areaConfig: P('config', 'areas', 'osaka-city.json'),
  rawBldg: P('data', 'raw', 'osaka-higashisumiyoshi'),
  jsonl: P('temp', 'ward-poc-all-buildings.jsonl'),
  wardDatasets: P('public', 'map-data', 'osaka-city', 'buildings'),
  canonBldg: P('data', 'processed', 'osaka-city', 'canonical', 'buildings'),
  derivedNear: P('public', 'map-data', 'osaka-city', 'derived', 'near', 'buildings'),
  canonRail: P('data', 'processed', 'osaka-city', 'canonical', 'rail'),
  canonWater: P('data', 'processed', 'osaka-city', 'canonical', 'water'),
  canonParks: P('data', 'processed', 'osaka-city', 'canonical', 'parks'),
  tranPolys: P('data', 'processed', 'osaka-city', 'canonical', 'roads-tran', 'polygons.json'),
  rawTran: P('data', 'raw', 'plateau', 'osaka-city', 'tran'),
  rawRail: P('data', 'raw', 'osaka-city', 'railways-osm.json'),
  rawWater: P('data', 'raw', 'osaka-city', 'waterways-osm.json'),
  rawParks: P('data', 'raw', 'osaka-city', 'parks-osm.json'),
  rawN03: P('data', 'raw', 'osaka-city', 'n03', 'N03-2026_27.geojson'),
  wardPolys: P('data', 'processed', 'osaka-city', 'boundaries', 'ward-classification-polygons.json'),
  osmPbf: P('data', 'raw', 'osm', 'osaka-latest.osm.pbf'),
  harness: P('tests', '_ward-ux-v1-smoke-harness.cjs'),
  html: P('public', 'osaka_3d_buildings.ward-ux-v1.html'),
  report: P('data', 'reports', 'building-rotation-root-cause.json'),
};
const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };
const isTile = (f) => /^tile_-?\d+_-?\d+\.json$/.test(f);
const median = (v) => { if (!v.length) return null; const s = [...v].sort((a, b) => a - b); const m = s.length >> 1; return +(s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2).toFixed(6); };
const pct = (v, q) => { if (!v.length) return null; const s = [...v].sort((a, b) => a - b); return +s[Math.min(s.length - 1, Math.floor(s.length * q))].toFixed(6); };
const cen = (arr) => [arr.reduce((a, p) => a + p[0], 0) / arr.length, arr.reduce((a, p) => a + p[1], 0) / arr.length];
const ringArea = (r) => { let a = 0; for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += r[j][0] * r[i][1] - r[i][0] * r[j][1]; return Math.abs(a) / 2; };
const pir = (x, z, r) => { let ins = false; for (let i = 0, j = r.length - 1; i < r.length; j = i++) { const xi = r[i][0], zi = r[i][1], xj = r[j][0], zj = r[j][1]; if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) ins = !ins; } return ins; };

// ── 実コードから変換式を取り出す ──
function loadBuildingProjector() {
  const src = fs.readFileSync(F.converter, 'utf-8');
  const a = src.indexOf('const JPRECT_ORIGINS'), b = src.indexOf('// ── posList文字列');
  if (a < 0 || b < 0) throw new Error('convert-plateau-buildings.js から latLonToJPRect を取り出せない');
  const ctx = {}; vm.createContext(ctx);
  vm.runInContext(src.slice(a, b) + '\nthis.latLonToJPRect = latLonToJPRect; this.JPRECT_ORIGINS = JPRECT_ORIGINS;', ctx);
  return { latLonToJPRect: ctx.latLonToJPRect, origins: ctx.JPRECT_ORIGINS };
}
const PROJ = rj(F.areaConfig).projection;
const COSLAT = Math.cos((PROJ.centerLat * Math.PI) / 180);
const mapXZ = (lat, lon) => [(lon - PROJ.centerLon) * COSLAT * PROJ.metersPerDegree, -((lat - PROJ.centerLat) * PROJ.metersPerDegree)];

/** 2D similarity（source→target）。rotDeg は (x,z) 平面の数学的正方向。 */
function similarity(pairs) {
  const n = pairs.length; if (n < 3) return null;
  let msx = 0, msz = 0, mtx = 0, mtz = 0;
  for (const p of pairs) { msx += p[0]; msz += p[1]; mtx += p[2]; mtz += p[3]; }
  msx /= n; msz /= n; mtx /= n; mtz /= n;
  let a = 0, b = 0, ss = 0;
  for (const p of pairs) { const x = p[0] - msx, z = p[1] - msz, u = p[2] - mtx, v = p[3] - mtz; a += x * u + z * v; b += x * v - z * u; ss += x * x + z * z; }
  const s = Math.hypot(a, b) / ss, th = Math.atan2(b, a);
  const c = Math.cos(th), sn = Math.sin(th);
  // t = mt - sR·ms
  const tx = mtx - s * (c * msx - sn * msz), tz = mtz - s * (sn * msx + c * msz);
  const res = pairs.map((p) => Math.hypot(s * (c * p[0] - sn * p[1]) + tx - p[2], s * (sn * p[0] + c * p[1]) + tz - p[3]));
  // 回転中心（不動点）: p = sR p + t → (I - sR) p = t
  const m00 = 1 - s * c, m01 = s * sn, m10 = -s * sn, m11 = 1 - s * c;
  const det = m00 * m11 - m01 * m10;
  const center = Math.abs(det) > 1e-12 ? [(tx * m11 - m01 * tz) / det, (m00 * tz - m10 * tx) / det] : null;
  return {
    scale: +s.toFixed(6), rotationDeg: +((th * 180) / Math.PI).toFixed(5),
    tx: +tx.toFixed(3), tz: +tz.toFixed(3),
    residualMedianM: median(res), residualP95M: pct(res, 0.95),
    rotationCenter: center ? [+center[0].toFixed(1), +center[1].toFixed(1)] : null,
    n,
  };
}

function rawBuildingRings(file) {
  const s = fs.readFileSync(file, 'utf-8'); const out = new Map();
  for (const part of s.split('<core:cityObjectMember>')) {
    const m = part.match(/<bldg:Building gml:id="([^"]+)"/); if (!m) continue;
    const sub = part.match(/<bldg:lod0FootPrint>([\s\S]*?)<\/bldg:lod0FootPrint>/); if (!sub) continue;
    const pl = sub[1].match(/<gml:posList[^>]*>([\s\S]*?)<\/gml:posList>/); if (!pl) continue;
    const n = pl[1].trim().split(/\s+/).map(Number); const pts = [];
    for (let i = 0; i + 2 < n.length; i += 3) pts.push([n[i], n[i + 1]]);
    if (pts.length >= 3) {
      // 生 CityGML の gen 属性「区名」＝座標とは独立した区の正解
      const wn = part.match(/<gen:stringAttribute name="区名"><gen:value>([^<]*)</);
      pts.wardName = wn ? wn[1] : null;
      out.set(m[1], pts);
    }
  }
  return out;
}
async function indexJsonl(ids) {
  const out = new Map();
  const rl = readline.createInterface({ input: fs.createReadStream(F.jsonl, { encoding: 'utf8' }) });
  for await (const L of rl) {
    if (!L) continue;
    const id = L.slice(7, L.indexOf('"', 7));
    if (!ids.has(id)) continue;
    out.set(id, JSON.parse(L).fp);
  }
  return out;
}
function indexTiles(dir, ids, idOf, ringOf) {
  const out = new Map();
  if (!fs.existsSync(dir)) return out;
  const walk = (d) => {
    for (const f of fs.readdirSync(d)) {
      const p = path.join(d, f);
      if (fs.statSync(p).isDirectory()) { walk(p); continue; }
      if (!isTile(f)) continue;
      const t = rj(p); if (!t) continue;
      for (const ft of (t.features || t.buildings || [])) {
        const id = idOf(ft); if (!ids.has(id) || out.has(id)) continue;
        const r = ringOf(ft); if (r && r.length >= 3) out.set(id, r);
      }
    }
  };
  walk(dir);
  return out;
}

export async function runBuildingRotationRootCause() {
  const generatedAt = new Date().toISOString();
  const { latLonToJPRect, origins } = loadBuildingProjector();
  const bcfg = rj(F.buildingConfig);

  // ── §2/§3 config 実値 ──
  const zoneOrigin = origins[bcfg.jprectZone];
  const buildingConfig = {
    file: toProjectRelativePath(F.buildingConfig),
    crs: bcfg.sourceCRS, coordinateMode: bcfg.coordinateMode,
    zone: bcfg.jprectZone,
    zoneOriginLatDeg: zoneOrigin[0], centralMeridianDeg: zoneOrigin[1],
    scaleFactor: 0.9999, falseEasting: 0, falseNorthing: 0,
    localOrigin: bcfg.localOrigin, axisOrder: bcfg.axisOrder, axisMapping: bcfg.axisMapping,
    declaredStatus: bcfg._deprecated ? 'DEPRECATED（ファイル内の注記）' : 'ACTIVE',
    deprecatedNote: bcfg._deprecated || null,
    generatedAt: bcfg.generatedAt,
    calibration: bcfg.calibration,
  };
  const mapConfig = {
    file: toProjectRelativePath(F.areaConfig),
    method: PROJ.type, originLatDeg: PROJ.centerLat, originLonDeg: PROJ.centerLon,
    metersPerDegree: PROJ.metersPerDegree, cosLatFixedAtOrigin: +COSLAT.toFixed(8),
    axisConvention: 'x = east, z = -north（znorth-neg-v1）',
    northOrientation: '全域で真北 = -Z（経線収差なし）',
  };

  // ── §5/§6 経線収差（実コードの latLonToJPRect を数値微分して求める） ──
  function convergenceDeg(lat, lon, zone) {
    const d = 1e-5;
    const p0 = latLonToJPRect(lat, lon, zone), p1 = latLonToJPRect(lat + d, lon, zone);
    // 真北方向のグリッド上での向き（grid north から時計回りを正とする方位）
    return +((Math.atan2(p1.E - p0.E, p1.N - p0.N) * 180) / Math.PI).toFixed(5);
  }
  const ref = { lat: PROJ.centerLat, lon: PROJ.centerLon };
  const umedaLL = { lat: 34.7024, lon: 135.4960 };
  const zoneVIConvergence = {
    zoneOrigin: origins[6],
    atLiveCityOriginDeg: convergenceDeg(ref.lat, ref.lon, 6),
    atUmedaDeg: convergenceDeg(umedaLL.lat, umedaLL.lon, 6),
    note: '真北がグリッド上で grid north からどちらへ何度傾いているか（時計回り正）。',
  };
  const zoneVIIConvergence = {
    zoneOrigin: origins[7],
    atLiveCityOriginDeg: convergenceDeg(ref.lat, ref.lon, 7),
    atUmedaDeg: convergenceDeg(umedaLL.lat, umedaLL.lon, 7),
    note: zoneVIConvergence.note,
  };

  // ── §7 control points: 生 CityGML（住吉/中間/梅田・計 6 メッシュ） ──
  const MESHES = [['51357420', 'sumiyoshi'], ['51357339', 'sumiyoshi'], ['51357430', 'mid'], ['52350329', 'mid'], ['52350339', 'umeda'], ['52350349', 'umeda']];
  const rawFiles = fs.readdirSync(F.rawBldg).filter((f) => f.endsWith('.gml'));
  const raw = new Map();
  for (const [mesh, region] of MESHES) {
    const file = rawFiles.find((f) => f.startsWith(mesh)); if (!file) continue;
    let k = 0;
    for (const [id, ring] of rawBuildingRings(path.join(F.rawBldg, file))) {
      raw.set(id, { ring, mesh, region, wardName: ring.wardName });
      if (++k >= 400) break;
    }
  }
  const ids = new Set(raw.keys());

  const registry = JSON.parse(fs.readFileSync(P('config', 'wards', 'registry.json'), 'utf-8').replace(/^\uFEFF/, ''));
  const wardIdByName = new Map((registry.wards || registry).map((w) => [w.name, w.id]));

  // ── §8 各段階の座標を集める ──
  const stageCoords = {
    B_projected_zone7: new Map(),
    B_projected_zone6: new Map(),
    C1_jsonl: await indexJsonl(ids),
    C2_wardDataset: indexTiles(F.wardDatasets, ids, (b) => b.id, (b) => b.fp),
    C3_canonical: indexTiles(F.canonBldg, new Set([...ids].map((i) => 'cg_bldg_' + i)), (f) => f.canonicalId, (f) => (f.geometryType === 'Polygon' ? f.coordinates[0] : f.coordinates[0] && f.coordinates[0][0])),
    D_derivedNear: indexTiles(F.derivedNear, new Set([...ids].map((i) => 'cg_bldg_' + i)), (f) => f.canonicalId, (f) => (f.geometryType === 'Polygon' ? f.coordinates[0] : f.coordinates[0] && f.coordinates[0][0])),
  };
  for (const [id, r] of raw) {
    stageCoords.B_projected_zone7.set(id, r.ring.map(([la, lo]) => { const p = latLonToJPRect(la, lo, 7); return [p.E, -p.N]; }));
    stageCoords.B_projected_zone6.set(id, r.ring.map(([la, lo]) => { const p = latLonToJPRect(la, lo, 6); return [p.E, -p.N]; }));
  }
  const UMEDA_SITE = [-2668.18, -10941.87]; // REFERENCE_SITES.umeda（ward-ux-v1.html）
  const keyOf = (stage, id) => (stage === 'C3_canonical' || stage === 'D_derivedNear' ? 'cg_bldg_' + id : id);

  // E runtime: 実際に scene へ add された頂点（Reference overlay の PLATEAU footprint = derived/near と同一タイル）
  let runtimeStage = null;
  try {
    const { createRequire } = await import('node:module');
    const req = createRequire(import.meta.url);
    const { runInlineScript } = req(F.harness);
    const boot = runInlineScript(F.html, { fetchRoot: P('public') });
    if (boot.ok) {
      const w = boot.window;
      await w.__SET_REFERENCE_ALIGNMENT__(true, 'umeda');
      const t0 = Date.now();
      while (Date.now() - t0 < 8000) { const d = w.__REFERENCE_ALIGNMENT_DEBUG__(); if (d && d.overlay && d.overlay.plateauFootprintCount > 0 && !d.overlay.loading) break; await new Promise((r) => setTimeout(r, 100)); }
      let mesh = null;
      (function walk(o) { if (!o || mesh) return; if (o.name === 'ReferencePlateauFootprintLines') { mesh = o; return; } for (const c of o.children || []) walk(c); })(w.__SCENE__);
      const arr = mesh && mesh.geometry && mesh.geometry.attributes.position && (mesh.geometry.attributes.position.array || mesh.geometry.attributes.position);
      if (arr) {
        // scene 頂点を 1m グリッドで索引し、D の頂点が 5cm 以内に存在するかを見る（Float32 丸めを許容）
        const g = new Map();
        let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
        for (let i = 0; i + 2 < arr.length; i += 3) {
          const x = arr[i], z = arr[i + 2];
          const k = Math.round(x) + ',' + Math.round(z); let a = g.get(k); if (!a) { a = []; g.set(k, a); } a.push([x, z]);
          if (x < minX) minX = x; if (x > maxX) maxX = x; if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
        }
        const near = (x, z) => { for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) { const a = g.get((Math.round(x) + dx) + ',' + (Math.round(z) + dz)); if (a) for (const q of a) if (Math.hypot(q[0] - x, q[1] - z) < 0.05) return true; } return false; };
        // overlay が読み込んだ範囲（site 半径）に完全に入っている建物だけを比べる
        let tot = 0, hit = 0, buildings = 0;
        for (const [id, ring] of stageCoords.D_derivedNear) {
          // overlay は site 中心から半径 380m（REF_SITE_RADIUS_M）の円で描くので、円の内側 350m に完全に入る建物だけを比べる
          if (!ring.every((q) => Math.hypot(q[0] - UMEDA_SITE[0], q[1] - UMEDA_SITE[1]) <= 350)) continue;
          buildings++;
          for (const q of ring) { tot++; if (near(q[0], q[1])) hit++; }
        }
        runtimeStage = { sceneVertexCount: arr.length / 3, sceneExtent: { minX: +minX.toFixed(1), maxX: +maxX.toFixed(1), minZ: +minZ.toFixed(1), maxZ: +maxZ.toFixed(1) },
          buildingsInsideExtent: buildings, derivedVerticesChecked: tot, foundInScene: hit,
          foundRatio: tot ? +(hit / tot).toFixed(4) : null, identity: tot > 0 && hit / tot > 0.95 };
      }
      await w.__SET_REFERENCE_ALIGNMENT__(false);
    }
  } catch (e) { runtimeStage = { error: String(e && e.message || e) }; }

  // 各段階: map frame（= equirect(生 lat/lon)）を基準にした similarity
  function stageFit(stage) {
    const coll = stageCoords[stage];
    const pairs = [];
    for (const [id, r] of raw) {
      const ring = coll.get(keyOf(stage, id)); if (!ring) continue;
      const n = Math.min(ring.length, r.ring.length);
      const src = cen(r.ring.slice(0, n).map(([la, lo]) => mapXZ(la, lo)));
      const dst = cen(ring.slice(0, n));
      pairs.push([src[0], src[1], dst[0], dst[1]]);
    }
    return similarity(pairs);
  }
  const stages = [
    { key: 'A_raw_latlon_to_map', label: 'A 生 lat/lon（Map 変換）', fit: { scale: 1, rotationDeg: 0, tx: 0, tz: 0, residualMedianM: 0, note: '基準（定義上 0）' } },
    { key: 'B_projected_zone7', label: 'B convert-plateau-buildings.js latLonToJPRect(zone=config 7)' },
    { key: 'C1_jsonl', label: 'C1 temp/ward-poc-all-buildings.jsonl（変換出力）' },
    { key: 'C2_wardDataset', label: 'C2 public/map-data/osaka-city/buildings/<ward>（区分割）' },
    { key: 'C3_canonical', label: 'C3 data/processed/osaka-city/canonical/buildings' },
    { key: 'D_derivedNear', label: 'D derived/near/buildings（描画タイル）' },
  ];
  for (const s of stages) if (!s.fit) s.fit = stageFit(s.key);
  const E = { key: 'E_runtime', label: 'E runtime scene（ReferencePlateauFootprintLines）', runtime: runtimeStage, fit: runtimeStage && runtimeStage.identity ? { ...stages[5].fit, note: 'D の頂点が scene にそのまま存在（同一性確認）→ D と同じ変換' } : null };
  stages.push(E);
  // zone6 は「もし正しい系(第6系)を使っていたら」の参考
  const zone6Fit = stageFit('B_projected_zone6');

  // 段階間の同一性（前段 → 後段の頂点差）
  function sameAs(a, b) {
    const ca = stageCoords[a], cb = stageCoords[b];
    const ds = [];
    for (const id of ids) {
      const ra = ca.get(keyOf(a, id)), rb = cb.get(keyOf(b, id)); if (!ra || !rb) continue;
      const n = Math.min(ra.length, rb.length);
      for (let i = 0; i < n; i++) ds.push(Math.hypot(ra[i][0] - rb[i][0], ra[i][1] - rb[i][1]));
    }
    return { vertices: ds.length, medianM: median(ds), p95M: pct(ds, 0.95) };
  }
  // zone7 と jsonl は平行移動（localOrigin）だけ違うので、平行移動を除いた同一性で見る
  const bToC1 = stageCoords.C1_jsonl.size ? (() => {
    const pairs = [];
    for (const id of ids) { const a = stageCoords.B_projected_zone7.get(id), b = stageCoords.C1_jsonl.get(id); if (!a || !b) continue; const n = Math.min(a.length, b.length); const ca = cen(a.slice(0, n)), cb = cen(b.slice(0, n)); pairs.push([ca[0], ca[1], cb[0], cb[1]]); }
    return similarity(pairs);
  })() : null;
  const transitions = {
    B_zone7_to_C1_jsonl: bToC1,
    C1_jsonl_to_C2_wardDataset: sameAs('C1_jsonl', 'C2_wardDataset'),
    C2_wardDataset_to_C3_canonical: sameAs('C2_wardDataset', 'C3_canonical'),
    C3_canonical_to_D_derivedNear: sameAs('C3_canonical', 'D_derivedNear'),
    D_to_E_runtime: runtimeStage,
  };

  // §9 first bad stage
  const ROT_EPS = 0.05;
  let firstBadStage = null;
  for (const s of stages) if (s.fit && Math.abs(s.fit.rotationDeg) > ROT_EPS) { firstBadStage = s.key; break; }

  const observed = stages.find((s) => s.key === 'C3_canonical').fit;
  // §13 向き: (x=east, z=south) 平面で数学的正方向の回転は、北が上の地図では時計回り
  const rotationDirection = observed.rotationDeg > 0
    ? 'CLOCKWISE（北が上の地図で見て、建物レイヤーが地図に対して時計回りに回っている。原点より北の建物ほど東へずれる）'
    : 'COUNTERCLOCKWISE';

  // §15 回転中心
  const bestFitRotationCenter = {
    world: observed.rotationCenter,
    distanceFromLiveCityOriginM: observed.rotationCenter ? +Math.hypot(...observed.rotationCenter).toFixed(1) : null,
    note: 'map frame → canonical の similarity の不動点。canonical は第7系座標を localOrigin で平行移動しただけなので、'
      + '回転中心は「localOrigin を決めたときに一致させた地点」付近に来る。',
  };
  // localOrigin の参照点を逆算（zone7 で localOrigin と一致する lat/lon は 生データを使わず config だけから求まる）
  const originProbe = (() => {
    // 住吉メッシュの点で B(zone7, localOrigin 適用) と C1 の平行移動差
    const pairs = [];
    for (const [id, r] of raw) { if (r.region !== 'sumiyoshi') continue; const b = stageCoords.C1_jsonl.get(id); if (!b) continue; const n = Math.min(b.length, r.ring.length); for (let i = 0; i < n; i++) { const p = latLonToJPRect(r.ring[i][0], r.ring[i][1], 7); pairs.push([p.E - bcfg.localOrigin.projectedE - b[i][0], -(p.N - bcfg.localOrigin.projectedN) - b[i][1]]); } }
    return { configLocalOriginResidualDxM: median(pairs.map((p) => p[0])), configLocalOriginResidualDzM: median(pairs.map((p) => p[1])) };
  })();

  // §16 区別（N03 区界の重心で予測、実測は生 CityGML をメッシュ間引きで読む）
  const wp = rj(F.wardPolys);
  const byWard = [];
  const sim = observed;
  const c = Math.cos((sim.rotationDeg * Math.PI) / 180), sn = Math.sin((sim.rotationDeg * Math.PI) / 180);
  const predictDisp = (x, z) => { const px = sim.scale * (c * x - sn * z) + sim.tx, pz = sim.scale * (sn * x + c * z) + sim.tz; return Math.hypot(px - x, pz - z); };
  // 実測用: メッシュを間引いて全市から読む
  const measuredByWard = {};
  const sampleFiles = rawFiles.filter((_, i) => i % 6 === 0);
  const canonAttr = P('data', 'processed', 'osaka-city', 'canonical', 'buildings', 'attributes');
  const wardOfId = new Map();
  if (fs.existsSync(canonAttr)) for (const f of fs.readdirSync(canonAttr)) { const t = rj(path.join(canonAttr, f)); if (!t) continue; for (const [cid, a] of Object.entries(t.attributes || {})) if (a && a.wardId) wardOfId.set(cid, a.wardId); }
  const canonAll = new Map();
  for (const f of fs.readdirSync(F.canonBldg)) { if (!isTile(f)) continue; const t = rj(path.join(F.canonBldg, f)); if (!t) continue; for (const ft of t.features || []) canonAll.set(ft.canonicalId, ft.geometryType === 'Polygon' ? ft.coordinates[0] : ft.coordinates[0][0]); }
  for (const f of sampleFiles) {
    let k = 0;
    for (const [id, ring] of rawBuildingRings(path.join(F.rawBldg, f))) {
      const cid = 'cg_bldg_' + id; const cr = canonAll.get(cid); const ward = (ring.wardName && wardIdByName.get(ring.wardName)) || wardOfId.get(cid);
      if (!cr || !ward) continue;
      const n = Math.min(cr.length, ring.length);
      const a = cen(ring.slice(0, n).map(([la, lo]) => mapXZ(la, lo))), b = cen(cr.slice(0, n));
      (measuredByWard[ward] = measuredByWard[ward] || []).push(Math.hypot(b[0] - a[0], b[1] - a[1]));
      if (++k >= 60) break;
    }
  }
  for (const w of wp.wards) {
    const cx = (w.bbox.minX + w.bbox.maxX) / 2, cz = (w.bbox.minZ + w.bbox.maxZ) / 2;
    const m = measuredByWard[w.wardId] || [];
    byWard.push({
      ward: w.wardId,
      centroidWorld: [+cx.toFixed(0), +cz.toFixed(0)],
      distanceFromOriginM: +Math.hypot(cx, cz).toFixed(0),
      predictedDisplacementM: +predictDisp(cx, cz).toFixed(1),
      measuredDisplacementMedianM: m.length ? +median(m).toFixed(1) : null,
      measuredSamples: m.length,
    });
  }
  byWard.sort((a, b) => a.distanceFromOriginM - b.distanceFromOriginM);

  // §17 他レイヤー（生 lat/lon → map 変換 と canonical の頂点同一性・similarity）
  function vertexGrid(dir, pick) {
    const g = new Map();
    for (const f of fs.readdirSync(dir)) { if (!isTile(f)) continue; const t = rj(path.join(dir, f)); if (!t) continue; for (const ft of t.features || []) for (const p of pick(ft)) { const k = Math.round(p[0]) + ',' + Math.round(p[1]); let a = g.get(k); if (!a) { a = []; g.set(k, a); } a.push(p); } }
    return g;
  }
  function nearestVertexDist(g, x, z) { let best = Infinity; for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) { const a = g.get((Math.round(x) + dx) + ',' + (Math.round(z) + dz)); if (a) for (const p of a) { const d = Math.hypot(p[0] - x, p[1] - z); if (d < best) best = d; } } return best; }
  const flat = (ft) => { const out = []; const rec = (v) => { if (typeof v[0] === 'number') out.push(v); else for (const x of v) rec(x); }; if (ft.coordinates) rec(ft.coordinates); return out; };
  function layerVertexCheck(label, dir, rawElements, limit = 3000) {
    const g = vertexGrid(dir, flat);
    const ds = [];
    for (const e of rawElements) {
      const geoms = e.geometry ? [e.geometry] : (e.members || []).map((m) => m.geometry).filter(Boolean);
      for (const gm of geoms) for (const p of gm) { const [x, z] = mapXZ(p.lat, p.lon); const d = nearestVertexDist(g, x, z); if (Number.isFinite(d)) ds.push(d); if (ds.length >= limit) break; }
      if (ds.length >= limit) break;
    }
    const exact = ds.filter((d) => d < 0.05).length;
    return { layer: label, verticesChecked: ds.length, exactWithin5cm: exact, exactRatio: ds.length ? +(exact / ds.length).toFixed(4) : null, medianM: median(ds), frame: ds.length && exact / ds.length > 0.5 ? 'MAP_EQUIRECT' : 'NOT_EQUIRECT' };
  }
  const railRaw = (rj(F.rawRail) || {}).elements || [];
  const waterRaw = (rj(F.rawWater) || {}).elements || [];
  const parksRaw = (rj(F.rawParks) || {}).elements || [];
  const layerComparison = [];
  // Road（tran）: tranId で同一性（32L と同じ手法）
  layerComparison.push((() => {
    const j = rj(F.tranPolys); const byId = new Map();
    for (const p of j.polygons) { const c0 = p.coordinates && p.coordinates[0]; if (c0 && c0.length >= 3) byId.set(p.tranId, c0); }
    const ds = []; const pairs = [];
    for (const f of fs.readdirSync(F.rawTran).filter((x) => /^5235034|^5135742/.test(x))) {
      const s = fs.readFileSync(path.join(F.rawTran, f), 'utf-8');
      for (const part of s.split('<core:cityObjectMember>')) {
        const m = part.match(/<tran:Road gml:id="([^"]+)"/); if (!m) continue; const cr = byId.get(m[1]); if (!cr) continue;
        const pl = part.match(/<gml:posList[^>]*>([\s\S]*?)<\/gml:posList>/); if (!pl) continue;
        const n = pl[1].trim().split(/\s+/).map(Number); const pts = [];
        for (let i = 0; i + 2 < n.length; i += 3) pts.push(mapXZ(n[i], n[i + 1]));
        const k = Math.min(pts.length, cr.length);
        for (let i = 0; i < k; i++) ds.push(Math.hypot(pts[i][0] - cr[i][0], pts[i][1] - cr[i][1]));
        const a = cen(pts.slice(0, k)), b = cen(cr.slice(0, k)); pairs.push([a[0], a[1], b[0], b[1]]);
        if (pairs.length >= 600) break;
      }
      if (pairs.length >= 600) break;
    }
    const exact = ds.filter((d) => d < 0.05).length;
    const fit = similarity(pairs);
    return { layer: 'road (PLATEAU tran)', verticesChecked: ds.length, exactWithin5cm: exact, exactRatio: +(exact / ds.length).toFixed(4), medianM: median(ds), rotationDeg: fit ? fit.rotationDeg : null, frame: exact / ds.length > 0.5 ? 'MAP_EQUIRECT' : 'NOT_EQUIRECT' };
  })());
  layerComparison.push(layerVertexCheck('rail (OSM)', F.canonRail, railRaw));
  layerComparison.push(layerVertexCheck('water (OSM)', F.canonWater, waterRaw));
  layerComparison.push(layerVertexCheck('park (OSM)', F.canonParks, parksRaw));
  // Boundary（N03 → ward-classification-polygons）
  layerComparison.push((() => {
    const n03 = rj(F.rawN03); const wpp = rj(F.wardPolys);
    const g = new Map();
    for (const w of wpp.wards) for (const poly of w.polygons) for (const p of poly.outer) { const k = Math.round(p[0]) + ',' + Math.round(p[1]); let a = g.get(k); if (!a) { a = []; g.set(k, a); } a.push(p); }
    const ds = [];
    for (const ft of (n03 && n03.features) || []) {
      const polys = ft.geometry.type === 'Polygon' ? [ft.geometry.coordinates] : ft.geometry.coordinates;
      for (const poly of polys) for (const [lo, la] of poly[0]) { const [x, z] = mapXZ(la, lo); const d = nearestVertexDist(g, x, z); if (Number.isFinite(d)) ds.push(d); if (ds.length >= 3000) break; }
      if (ds.length >= 3000) break;
    }
    const exact = ds.filter((d) => d < 0.05).length;
    return { layer: 'boundary (N03)', verticesChecked: ds.length, exactWithin5cm: exact, exactRatio: ds.length ? +(exact / ds.length).toFixed(4) : null, medianM: median(ds), frame: ds.length && exact / ds.length > 0.5 ? 'MAP_EQUIRECT' : 'NOT_EQUIRECT' };
  })());
  layerComparison.push({ layer: 'building (PLATEAU)', rotationDeg: observed.rotationDeg, frame: 'JPRECT_ZONE_VII_LOCAL', note: 'C3 canonical の similarity（上記）' });
  const onlyBuildingsRotated = layerComparison.filter((l) => l.layer !== 'building (PLATEAU)').every((l) => l.frame === 'MAP_EQUIRECT');

  // §18/§19 lineage と config の使用状況
  const sourceConfigUsed = [
    { file: 'data/buildings/coordinate-config.json（第7系・localOrigin）', status: 'USED', evidence: 'C1 jsonl を第7系+z反転で 1mm 精度で再現できる（B→C1 similarity 残差 ' + (bToC1 ? bToC1.residualMedianM : '?') + 'm・回転 ' + (bToC1 ? bToC1.rotationDeg : '?') + '°）。ファイルには DEPRECATED 注記があるが、**その注記より前（2026-07-20 生成 → jsonl 2026-08-05）に全市建物の変換に使われ、結果が canonical まで無変換で引き継がれている**。', liveCodePathNow: '無し（build-canonical-buildings.js はこの config を読まない。座標は区データセットの fp をそのまま使う）' },
    { file: 'tools/convert-plateau-buildings.js（geographic-jprect モード）', status: 'USED（過去の一括変換で）', evidence: '出力形式 {id, fp, z0, dz, h, usage, ulabel, ward} が jsonl と一致。ward が全件「東住吉区」（東住吉 PoC 設定のまま全市を変換した痕跡）。' },
    { file: 'temp/ward-poc-all-buildings.jsonl', status: 'USED（canonical の実質的な座標ソース）', evidence: 'build-ward-building-datasets.js の既定入力。public/map-data/osaka-city/buildings/manifest.json の source.buildings にも記録。' },
    { file: 'tools/build-ward-building-datasets.js', status: 'USED', evidence: 'jsonl → 区データセット。座標は変えない（C1→C2 頂点差 ' + transitions.C1_jsonl_to_C2_wardDataset.medianM + 'm）。' },
    { file: 'tools/build-canonical-buildings.js', status: 'USED', evidence: '区データセット → canonical。座標は変えない（C2→C3 頂点差 ' + transitions.C2_wardDataset_to_C3_canonical.medianM + 'm）。projection は ward 判定用の逆変換(toLatLon)にだけ使う。' },
    { file: 'config/areas/osaka-city.json（equirect）', status: 'USED（道路・水域・公園・鉄道・行政界）/ 建物の座標生成には UNUSED', evidence: 'layerComparison 参照。' },
    { file: 'tools/audit/coordinate-system-authority-audit.js（FIX11）', status: 'DEPRECATED として扱うべき結論', evidence: 'control point の lat/lon を canonical から equirect 逆変換で作っていた（循環）ため「建物は equirect・誤差 0m」という誤った結論になった。' },
  ];

  // ── §22/§23 補正後の予測（再生成はしない。正しい変換 = equirect(生 lat/lon) を仮に当てる） ──
  async function predicted() {
    const sites = { umeda: { region: 'umeda' }, sumiyoshi: { region: 'sumiyoshi' } };
    // OSM 建物（梅田・住吉の範囲だけ）
    const boxes = {};
    for (const k of Object.keys(sites)) {
      const pts = [...raw.values()].filter((r) => r.region === k).flatMap((r) => r.ring.map(([la, lo]) => mapXZ(la, lo)));
      const xs = pts.map((p) => p[0]), zs = pts.map((p) => p[1]);
      boxes[k] = { minX: Math.min(...xs) - 300, maxX: Math.max(...xs) + 300, minZ: Math.min(...zs) - 300, maxZ: Math.max(...zs) + 300 };
    }
    const latOf = (z) => PROJ.centerLat - z / PROJ.metersPerDegree, lonOf = (x) => PROJ.centerLon + x / (COSLAT * PROJ.metersPerDegree);
    const all = Object.values(boxes);
    const bb = { s: latOf(Math.max(...all.map((b) => b.maxZ))), n: latOf(Math.min(...all.map((b) => b.minZ))), w: lonOf(Math.min(...all.map((b) => b.minX))), e: lonOf(Math.max(...all.map((b) => b.maxX))) };
    const nodes = new Map(); const osmRings = [];
    for await (const p of pbfPrimitiveStream(F.osmPbf)) {
      if (p.type === 'node') { if (p.lat >= bb.s && p.lat <= bb.n && p.lon >= bb.w && p.lon <= bb.e) nodes.set(p.id, mapXZ(p.lat, p.lon)); }
      else if (p.type === 'way') { const t = p.tags || {}; if (!(t.building || t['building:part'])) continue; const pts = []; let ok = true; for (const r of p.refs || []) { const c2 = nodes.get(r); if (!c2) { ok = false; break; } pts.push(c2); } if (ok && pts.length >= 4) osmRings.push(pts); }
    }
    const rasterOf = (rings, box) => {
      const nx = Math.ceil(box.maxX - box.minX), nz = Math.ceil(box.maxZ - box.minZ); const m = new Uint8Array(nx * nz);
      for (const r of rings) { let a = Infinity, b2 = -Infinity, c2 = Infinity, d2 = -Infinity; for (const p of r) { a = Math.min(a, p[0]); b2 = Math.max(b2, p[0]); c2 = Math.min(c2, p[1]); d2 = Math.max(d2, p[1]); } if (b2 < box.minX || a > box.maxX || d2 < box.minZ || c2 > box.maxZ) continue; const i0 = Math.max(0, Math.floor(a - box.minX)), i1 = Math.min(nx - 1, Math.floor(b2 - box.minX)), j0 = Math.max(0, Math.floor(c2 - box.minZ)), j1 = Math.min(nz - 1, Math.floor(d2 - box.minZ)); for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) if (pir(box.minX + i + 0.5, box.minZ + j + 0.5, r)) m[j * nx + i] = 1; }
      return { m, nx, nz, box };
    };
    const coverage = (ring, R) => { const { m, nx, nz, box } = R; let a = Infinity, b2 = -Infinity, c2 = Infinity, d2 = -Infinity; for (const p of ring) { a = Math.min(a, p[0]); b2 = Math.max(b2, p[0]); c2 = Math.min(c2, p[1]); d2 = Math.max(d2, p[1]); } let tot = 0, hit = 0; for (let i = Math.max(0, Math.floor(a - box.minX)); i <= Math.min(nx - 1, Math.floor(b2 - box.minX)); i++) for (let j = Math.max(0, Math.floor(c2 - box.minZ)); j <= Math.min(nz - 1, Math.floor(d2 - box.minZ)); j++) { if (!pir(box.minX + i + 0.5, box.minZ + j + 0.5, ring)) continue; tot++; if (m[j * nx + i]) hit++; } return tot ? hit / tot : null; };
    // 道路（tran）/ 水域（canonical water）
    const tran = rj(F.tranPolys).polygons.map((p) => p.coordinates && p.coordinates[0]).filter((r) => r && r.length >= 3);
    const water = [];
    for (const f of fs.readdirSync(F.canonWater)) { if (!isTile(f)) continue; const t = rj(path.join(F.canonWater, f)); if (!t) continue; for (const ft of t.features || []) { const polys = ft.geometryType === 'Polygon' ? [ft.coordinates] : ft.coordinates; for (const pl of polys) if (pl[0] && pl[0].length >= 3) water.push(pl[0]); } }
    // 区界（N03・map frame）
    const wards = wp.wards;
    const wardAt = (x, z) => { for (const w of wards) { if (x < w.bbox.minX || x > w.bbox.maxX || z < w.bbox.minZ || z > w.bbox.maxZ) continue; for (const p of w.polygons) if (pir(x, z, p.outer)) return w.wardId; } return null; };
    const out = {};
    for (const [k, box] of Object.entries(boxes)) {
      const R = { osm: rasterOf(osmRings, box), road: rasterOf(tran, box), water: rasterOf(water, box) };
      const rows = { before: { osm: [], road: [], water: [] }, after: { osm: [], road: [], water: [] } };
      let wardBefore = 0, wardAfter = 0, wardN = 0, labelAgreesWithRaw = 0, labelN = 0;
      for (const [id, r] of raw) {
        if (r.region !== k) continue;
        const cr = stageCoords.C3_canonical.get('cg_bldg_' + id); if (!cr) continue;
        const after = r.ring.map(([la, lo]) => mapXZ(la, lo));
        for (const [name, R2] of Object.entries(R)) { const vb = coverage(cr, R2), va = coverage(after, R2); if (vb != null) rows.before[name].push(vb); if (va != null) rows.after[name].push(va); }
        // truth = 生 CityGML の「区名」（座標から独立）
        const truthWard = r.wardName ? wardIdByName.get(r.wardName) : null;
        if (truthWard) {
          wardN++; const cb = cen(cr), ca = cen(after);
          if (wardAt(cb[0], cb[1]) === truthWard) wardBefore++;
          if (wardAt(ca[0], ca[1]) === truthWard) wardAfter++;
          const label = wardOfId.get('cg_bldg_' + id);
          if (label) { labelN++; if (label === truthWard) labelAgreesWithRaw++; }
        }
      }
      out[k] = {
        buildings: rows.before.osm.length,
        osmOverlapBefore: median(rows.before.osm), osmOverlapAfter: median(rows.after.osm),
        roadOverlapBefore: median(rows.before.road), roadOverlapAfter: median(rows.after.road),
        roadOverlapMeanBefore: +(rows.before.road.reduce((a, b2) => a + b2, 0) / rows.before.road.length).toFixed(4),
        roadOverlapMeanAfter: +(rows.after.road.reduce((a, b2) => a + b2, 0) / rows.after.road.length).toFixed(4),
        waterOverlapMeanBefore: +(rows.before.water.reduce((a, b2) => a + b2, 0) / rows.before.water.length).toFixed(4),
        waterOverlapMeanAfter: +(rows.after.water.reduce((a, b2) => a + b2, 0) / rows.after.water.length).toFixed(4),
        wardPlacementTruth: '生 CityGML の gen 属性「区名」',
        wardPlacementBefore: wardN ? +(wardBefore / wardN).toFixed(4) : null,
        wardPlacementAfter: wardN ? +(wardAfter / wardN).toFixed(4) : null,
        currentWardLabelAgreesWithRaw: labelN ? +(labelAgreesWithRaw / labelN).toFixed(4) : null,
        wardSamples: wardN,
      };
    }
    return out;
  }
  const pred = await predicted();
  const predictedCorrection = {
    method: '再生成はしていない。§24 に従い「全体を -0.94° 回す」ではなく、**正しい source→canonical 変換（生 lat/lon → Map の equirect）**を'
      + '同じ建物に仮に当てて、描画座標（before）と比べた。',
    umeda: pred.umeda, sumiyoshi: pred.sumiyoshi,
    osmOverlapBefore: pred.umeda.osmOverlapBefore, osmOverlapAfter: pred.umeda.osmOverlapAfter,
    roadOverlapBefore: pred.umeda.roadOverlapMeanBefore, roadOverlapAfter: pred.umeda.roadOverlapMeanAfter,
    waterOverlapBefore: pred.umeda.waterOverlapMeanBefore, waterOverlapAfter: pred.umeda.waterOverlapMeanAfter,
    wardPlacementBefore: pred.umeda.wardPlacementBefore, wardPlacementAfter: pred.umeda.wardPlacementAfter,
    wardNote: '区の正解には生 CityGML の「区名」を使った。canonical の wardId 属性は回転した座標を N03 に当てて付けたもので、'
      + 'それを正解にすると「補正前が正しい」ように見える循環になる（currentWardLabelAgreesWithRaw 参照）。',
    overCorrectionCheck: {
      sumiyoshiOsmBefore: pred.sumiyoshi.osmOverlapBefore, sumiyoshiOsmAfter: pred.sumiyoshi.osmOverlapAfter,
      sumiyoshiWorsened: pred.sumiyoshi.osmOverlapAfter < pred.sumiyoshi.osmOverlapBefore,
      note: '§23: 住吉（現状でも比較的自然）が補正後に悪化しないか。',
    },
  };

  // §20/§21 rebuild scope / canonicalId
  const rebuildScope = {
    mustRegenerate: [
      'temp/ward-poc-all-buildings.jsonl（または生 CityGML から equirect で直接）',
      'public/map-data/osaka-city/buildings/<ward>/（区データセット・24区＋unclassified）',
      'data/processed/osaka-city/canonical/buildings/（geometry・attributes の wardId）',
      'public/map-data/osaka-city/derived/{near,mid,far}/buildings（LOD）',
      'data/processed/osaka-city/derived/building-placement/ と public 側（placement policy: water/road overlap 比が誤った位置で計算されている）',
      'data/processed/osaka-city/derived/building-ward-index.json',
      'public/map-data/osaka-city/visual-buildings / derived-visual-buildings（Visual Building PoC）',
      'data/processed/osaka-city/visual-land-block-poc/umeda/building-assignment.json',
    ],
    mustReEvaluate: [
      'data/reports/umeda-ground-footprint-audit.json（32G）', 'data/reports/umeda-real-world-ground-truth-audit.json（32H: 道路重なりの値）',
      'data/reports/road-visual-v3.json / road-visual-v2.json（Building∩DarkRoad KPI）', 'data/reports/alignment-reset.json ほか alignment 系',
      'data/reports/coordinate-system-authority-audit.json（FIX11: 結論が誤り）', 'data/reports/runtime-visible-layer-alignment.json（32J）',
    ],
    notAffected: ['canonical roads / water / parks / rail / boundaries（すべて equirect で一致）', 'ROAD V3 の道路 geometry 自体（建物を参照していない）'],
    buildingCount: { canonical: 615617 },
  };
  const canonicalIdPreservation = {
    preservable: true,
    rule: "canonicalId = 'cg_bldg_' + 生 CityGML の gml:id（座標に依存しない）",
    evidence: 'C3 の canonicalId から接頭辞を除くと生 GML の gml:id と一致する（本監査の全照合がこの対応で成立）。',
    propertyLinkage: 'attributes/tile_*.json は canonicalId をキーにしているので、座標を作り直しても属性・物件リンクは維持できる。'
      + 'ただし tile 番号は座標から決まるため、属性ファイルの格納 tile は変わる（キーは不変）。',
  };

  // ── §25 分類 ──
  const zone7Match = bToC1 && Math.abs(bToC1.rotationDeg) < 0.01 && bToC1.residualMedianM < 0.05;
  let classification, classificationReason;
  if (!firstBadStage) { classification = 'ROTATION_IS_NOT_SYSTEMATIC'; classificationReason = 'どの段階にも有意な回転が無い。'; }
  else if (firstBadStage === 'B_projected_zone7' && zone7Match && onlyBuildingsRotated) {
    classification = 'PLANE_RECTANGULAR_CONVERGENCE_ERROR';
    classificationReason = '建物だけが平面直角座標（第7系）で投影され、他のレイヤーはすべて equirect（真北＝−Z）で投影されている。'
      + '平面直角座標のグリッド北は真北に対して経線収差の分だけ傾いているため、その傾きがそのまま建物レイヤーの回転になった。'
      + '選ばれた系が大阪府の公式系（第6系）ではなく第7系だったことで回転が大きくなっている（第6系でも '
      + (zone6Fit ? zone6Fit.rotationDeg : '?') + '° 残る）。';
  } else { classification = 'UNKNOWN_ROTATION_SOURCE'; classificationReason = 'first bad stage は特定したが第7系で再現できない。'; }

  const report = {
    version: 1, generatedAt, missionId: '32M', mode: 'AUDIT_ONLY',
    truthPolicy: { rawLatLonUsedAsTruth: true, inverseDerivedTruthUsed: false, note: 'truth は生 CityGML / 生 tran GML / 生 OSM / 生 N03 の lat/lon だけ。canonical からの逆変換は使っていない。' },
    pipelines: {
      building: [
        { stage: 'raw', what: 'PLATEAU CityGML（EPSG:6697 lat lon h）', file: 'data/raw/osaka-higashisumiyoshi/*_bldg_6697_op.gml' },
        { stage: 'parse', fn: 'convertBuildingXml() / parsePosList()', file: 'tools/convert-plateau-buildings.js' },
        { stage: 'CRS decode + projected', fn: 'latLonToJPRect(lat, lon, cfg.jprectZone=7)', file: 'tools/convert-plateau-buildings.js' },
        { stage: 'local', fn: 'toLocal(E, N, cfg)（localOrigin を引く）＋ znorth 反転', file: 'tools/convert-plateau-buildings.js / data/buildings/coordinate-config.json' },
        { stage: 'intermediate', what: 'temp/ward-poc-all-buildings.jsonl' },
        { stage: 'ward split', fn: 'build-ward-building-datasets.js', file: 'public/map-data/osaka-city/buildings/<ward>/' },
        { stage: 'canonical', fn: 'build-canonical-buildings.js（座標は fp をそのまま）', file: 'data/processed/osaka-city/canonical/buildings/' },
        { stage: 'derived/tile', fn: 'build-canonical-derived（LOD）', file: 'public/map-data/osaka-city/derived/{near,mid,far}/buildings/' },
        { stage: 'runtime', fn: 'tileUrl() → buildGroup() → pushExtrude(f.coordinates)', file: 'public/osaka_3d_buildings.ward-ux-v1.html' },
      ],
      mapRoad: [
        { stage: 'raw', what: 'PLATEAU tran GML（EPSG:6697）', file: 'data/raw/plateau/osaka-city/tran/*.gml' },
        { stage: 'CRS decode + local', fn: 'toLocal（equirect・config/areas/osaka-city.json）', file: 'tools/convert-plateau-tran.js' },
        { stage: 'canonical', file: 'data/processed/osaka-city/canonical/roads-tran/polygons.json → canonical/roads' },
        { stage: 'tile/runtime', file: 'derived roads / road-visual-v3' },
      ],
      otherLayers: 'OSM（rail/water/parks）: tools/convert/*.js → tools/lib/projection.js（equirect）。N03: official-boundaries → ward-classification-polygons（equirect）。',
    },
    observedRotationDeg: observed.rotationDeg,
    rotationDirection,
    scaleRatio: observed.scale,
    stageMeasurements: stages.map((s) => ({ stage: s.key, label: s.label, ...(s.fit || {}), runtime: s.runtime || undefined })),
    stageTransitions: transitions,
    firstBadStage,
    ROTATION_FIRST_APPEARS_AT: firstBadStage === 'B_projected_zone7'
      ? 'B: tools/convert-plateau-buildings.js latLonToJPRect(zone 7)（生 lat/lon を平面直角座標 第7系へ投影した瞬間）'
      : firstBadStage,
    buildingConfig, mapConfig,
    zoneVIConvergence, zoneVIIConvergence,
    zoneComparison: {
      zone7Fit: stages.find((s) => s.key === 'B_projected_zone7').fit,
      zone6Fit,
      matchesObserved: 'VII',
      note: '観測回転 ' + observed.rotationDeg + '° は第7系の similarity（' + stages.find((s) => s.key === 'B_projected_zone7').fit.rotationDeg
        + '°）と一致し、第6系（' + (zone6Fit ? zone6Fit.rotationDeg : '?') + '°）とは一致しない。'
        + 'さらに第7系の出力は jsonl を平行移動だけで 1mm 精度で再現する。',
    },
    localOriginCheck: originProbe,
    bestFitRotationCenter,
    byWard,
    layerComparison,
    onlyBuildingsRotated,
    sourceConfigUsed,
    predictedCorrection,
    rebuildScope,
    canonicalIdPreservation,
    classification,
    classificationReason,
    stopToken: classification === 'UNKNOWN_ROTATION_SOURCE' || classification === 'ROTATION_IS_NOT_SYSTEMATIC'
      ? 'BUILDING_ROTATION_ROOT_CAUSE_UNRESOLVED' : 'BUILDING_ROTATION_ROOT_CAUSE_IDENTIFIED',
  };
  await writeJson(F.report, report);
  return report;
}

if (isMainModule(import.meta.url)) {
  runBuildingRotationRootCause().then((r) => {
    for (const s of r.stageMeasurements) console.log('[32M] ' + s.stage.padEnd(22) + ' rot=' + s.rotationDeg + ' scale=' + s.scale + ' res=' + s.residualMedianM);
    console.log('[32M] transitions ' + JSON.stringify(r.stageTransitions));
    console.log('[32M] firstBadStage=' + r.firstBadStage);
    console.log('[32M] zoneVI=' + JSON.stringify(r.zoneVIConvergence) + ' zoneVII=' + JSON.stringify(r.zoneVIIConvergence));
    console.log('[32M] center=' + JSON.stringify(r.bestFitRotationCenter));
    console.log('[32M] layers=' + JSON.stringify(r.layerComparison.map((l) => [l.layer, l.frame, l.exactRatio, l.rotationDeg])));
    console.log('[32M] predicted umeda=' + JSON.stringify(r.predictedCorrection.umeda));
    console.log('[32M] predicted sumiyoshi=' + JSON.stringify(r.predictedCorrection.sumiyoshi));
    console.log('[32M] classification=' + r.classification + ' ' + r.stopToken);
    process.exit(0);
  }).catch((e) => { console.error(e); process.exit(1); });
}
