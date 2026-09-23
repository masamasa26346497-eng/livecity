#!/usr/bin/env node
// tools/build-plateau-high-lod.js
// [Mission 34A §4-§12] PLATEAU の実データとして存在する最高 LOD（LOD3 > LOD2）の geometry を取り出し、
//   canonicalId に紐づく「derived representation」としてタイル化する。
// ══════════════════════════════════════════════════════════════════════════════════
//   ■ 作らないもの（§0）
//     - LOD1 から推定した架空の LOD2/LOD3（存在する実データだけを使う）
//     - 建物位置 / footprint / canonicalId / placement / ROAD V3 の変更
//     - canonical building の削除・置換（既存 V2N はそのまま。ここは追加 namespace だけ）
//
//   ■ 座標（§6）
//     生 CityGML は EPSG:6697（JGD2011 地理座標 lat lon alt）。
//     latLonToLiveCityWorld()（local-equirectangular / znorth-neg-v1）で直接変換する。
//     平面直角座標系（第6系/第7系）は一切経由しない。
//
//   ■ 入力
//     data/processed/osaka-city/canonical/plateau-lod-index.json  ← LOD 在庫調査の出力
//     data/raw/**/*_bldg_*.gml と CityGML_v4.zip 内の同名エントリ
//     data/processed/osaka-city/canonical/buildings-v2-osmv2/tile_*.json（位置照合 §7・タイル割当）
//
//   ■ 出力
//     public/map-data/osaka-city/derived-v2-osmv2/building-lod-high/tile_<tx>_<tz>.json + manifest.json
//     data/processed/osaka-city/derived-v2-osmv2/building-lod-high/…（同内容）
//     data/reports/plateau-high-lod-build.json
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, isMainModule } from './lib/paths.js';
import { latLonToLiveCityWorld } from './lib/livecity-coordinate-system.js';
import { readZipEntries, extractEntry } from './lib/zip-reader.js';
import { writeFilesVerified } from './lib/synced-dir-writer.js';
import earcut from './lib/earcut.js';
import { buildingStarts, detach, flatten } from './audit/plateau-lod-availability.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const IDX = P('data', 'processed', 'osaka-city', 'canonical', 'plateau-lod-index.json');
const CANON = P('data', 'processed', 'osaka-city', 'canonical', 'buildings-v2-osmv2');
const RAW_DIR = P('data', 'raw');
const RAW_ZIP = P('data', 'raw', 'osaka-sumiyoshi', 'plateau', 'buildings-lod2', '2024', 'archive', 'CityGML_v4.zip');
const OUT_PUBLIC = P('public', 'map-data', 'osaka-city', 'derived-v2-osmv2', 'building-lod-high');
const OUT_PROCESSED = P('data', 'processed', 'osaka-city', 'derived-v2-osmv2', 'building-lod-high');
const OUT_REPORT = P('data', 'reports', 'plateau-high-lod-build.json');
const TILE = 500;
const CANON_PREFIX = 'cg_bldg_';

// §5 妥当性のしきい値。ここを外れた高 LOD は採用せず、次の LOD へ落とす。
// [Mission 34D §13] 空間照合（gml:id が一致しない）だけで結び付ける棟に課す追加条件。
//   id の裏付けが無いので、通常より厳しくする。
export const SPATIAL_VALID = { maxBboxCenterShiftM: 2, maxBboxAreaRatio: 2 };
export const VALID = {
  minRingVerts: 3,
  minHeightM: 1,
  maxHeightM: 320,          // 大阪市内の最高層（あべのハルカス 300m）+ 余裕
  maxFootprintM: 500,       // 1 棟の平面の最大辺
  maxCentroidShiftM: 30,    // §7 canonical LOD1 の重心からのズレ上限（重心は頂点平均なので緩め）
  minSurfaces: 3,           // 屋根・壁・地面が揃わないものは採らない
  maxAbsAltM: 3000,         // 標高の異常値（座標破損の検出）
  // §5/§7 canonical の footprint と「同じ建物か」を bbox で確かめる。
  //   重心（頂点平均）は複雑な平面で大きくぶれるため、位置の正否は bbox 中心で判定する。
  //   実測で 1 棟だけ、canonical 24×24m に対し高 LOD が 100×203m という記録があった
  //   （その gml:id の LOD2 が敷地全体を覆っている）。こういうものは採らない。
  maxBboxCenterShiftM: 15,
  maxBboxAreaRatio: 4,
};
// §9 semantic surface。表示側の material はこの種別で分ける（§10）。
export const SURFACE_KINDS = { RoofSurface: 'roof', WallSurface: 'wall', GroundSurface: 'ground', ClosureSurface: 'closure', OuterFloorSurface: 'ground', OuterCeilingSurface: 'roof' };

export function parsePosListLatLonAlt(text) {
  const n = text.trim().split(/\s+/);
  const pts = [];
  for (let i = 0; i + 2 < n.length; i += 3) {
    const lat = +n[i], lon = +n[i + 1], alt = +n[i + 2];
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(alt)) return null;
    const w = latLonToLiveCityWorld(lat, lon);
    pts.push([w.x, alt, w.z]);
  }
  return pts.length ? pts : null;
}
/** 閉じ点を落とす */
export function openRing(pts) {
  if (pts.length >= 2) {
    const a = pts[0], b = pts[pts.length - 1];
    if (Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9 && Math.abs(a[2] - b[2]) < 1e-9) return pts.slice(0, -1);
  }
  return pts;
}
/** 3D ポリゴンの法線（Newell 法） */
export function newellNormal(ring) {
  let nx = 0, ny = 0, nz = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    nx += (a[1] - b[1]) * (a[2] + b[2]);
    ny += (a[2] - b[2]) * (a[0] + b[0]);
    nz += (a[0] - b[0]) * (a[1] + b[1]);
  }
  const L = Math.hypot(nx, ny, nz);
  return L > 1e-12 ? [nx / L, ny / L, nz / L] : null;
}
/**
 * 平面 3D ポリゴン（+穴）を三角形分割する。
 *   法線の最大成分の軸を落として 2D へ射影 → earcut。退化（面積ゼロ）は捨てる。
 */
export function triangulatePolygon(outer, holes = []) {
  const n = newellNormal(outer);
  if (!n) return null;
  const ax = Math.abs(n[0]), ay = Math.abs(n[1]), az = Math.abs(n[2]);
  const drop = (ay >= ax && ay >= az) ? 1 : (ax >= az ? 0 : 2);
  const to2 = (p) => (drop === 1 ? [p[0], p[2]] : drop === 0 ? [p[1], p[2]] : [p[0], p[1]]);
  const verts = [], flat = [], holeIdx = [];
  for (const p of outer) { verts.push(p); const q = to2(p); flat.push(q[0], q[1]); }
  for (const h of holes) {
    if (h.length < 3) continue;
    holeIdx.push(flat.length / 2);
    for (const p of h) { verts.push(p); const q = to2(p); flat.push(q[0], q[1]); }
  }
  const tri = earcut(flat, holeIdx.length ? holeIdx : null, 2);
  if (!tri.length) return null;
  return { verts, indices: tri };
}

/** 1 建物の XML から、指定 LOD の semantic surface を取り出す */
export function extractSurfaces(seg, lod) {
  const want = 'lod' + lod + 'MultiSurface';
  const out = [];
  const reB = /<bldg:boundedBy>([\s\S]*?)<\/bldg:boundedBy>/g;
  let m;
  while ((m = reB.exec(seg))) {
    const body = m[1];
    const km = /<bldg:(\w+Surface)\b/.exec(body);
    const kind = km ? (SURFACE_KINDS[km[1]] || 'other') : 'other';
    if (body.indexOf('<bldg:' + want) < 0) continue;
    const reP = /<gml:Polygon\b[\s\S]*?<\/gml:Polygon>/g;
    let p;
    while ((p = reP.exec(body))) {
      const ext = /<gml:exterior>[\s\S]*?<gml:posList[^>]*>([\s\S]*?)<\/gml:posList>/.exec(p[0]);
      if (!ext) continue;
      const outer = openRing(parsePosListLatLonAlt(ext[1]) || []);
      if (outer.length < VALID.minRingVerts) continue;
      const holes = [];
      const reI = /<gml:interior>[\s\S]*?<gml:posList[^>]*>([\s\S]*?)<\/gml:posList>/g;
      let h;
      while ((h = reI.exec(p[0]))) { const r = openRing(parsePosListLatLonAlt(h[1]) || []); if (r.length >= 3) holes.push(r); }
      out.push({ kind, outer, holes });
    }
  }
  return out;
}

/** §5/§7/§8 検査 + 地面合わせ + 三角形分割 → 表示用データ */
export function buildRepresentation(surfaces, canon, lod) {
  if (surfaces.length < VALID.minSurfaces) return { ok: false, reason: 'too-few-surfaces' };
  let minAlt = Infinity, maxAlt = -Infinity, minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const s of surfaces) for (const ring of [s.outer, ...s.holes]) for (const p of ring) {
    if (!Number.isFinite(p[0]) || !Number.isFinite(p[1]) || !Number.isFinite(p[2])) return { ok: false, reason: 'non-finite' };
    if (Math.abs(p[1]) > VALID.maxAbsAltM) return { ok: false, reason: 'absurd-altitude' };
    if (p[1] < minAlt) minAlt = p[1];
    if (p[1] > maxAlt) maxAlt = p[1];
    if (p[0] < minX) minX = p[0];
    if (p[0] > maxX) maxX = p[0];
    if (p[2] < minZ) minZ = p[2];
    if (p[2] > maxZ) maxZ = p[2];
  }
  const heightM = maxAlt - minAlt;
  if (!(heightM >= VALID.minHeightM && heightM <= VALID.maxHeightM)) return { ok: false, reason: 'absurd-height', heightM };
  if ((maxX - minX) > VALID.maxFootprintM || (maxZ - minZ) > VALID.maxFootprintM) return { ok: false, reason: 'extreme-bbox' };
  // §8 地面合わせ: GroundSurface があればその最低標高、無ければ全体の最低標高を 0 にする
  const gAlts = [];
  for (const s of surfaces) if (s.kind === 'ground') for (const p of s.outer) gAlts.push(p[1]);
  const baseAlt = gAlts.length ? Math.min(...gAlts) : minAlt;
  // §7 位置: 地面（または全体）の重心を canonical LOD1 の重心と比べる
  const cxs = [], czs = [];
  const src = gAlts.length ? surfaces.filter((s) => s.kind === 'ground') : surfaces;
  for (const s of src) for (const p of s.outer) { cxs.push(p[0]); czs.push(p[2]); }
  const cx = cxs.reduce((a, b) => a + b, 0) / cxs.length;
  const cz = czs.reduce((a, b) => a + b, 0) / czs.length;
  const shift = canon ? Math.hypot(cx - canon.centroid[0], cz - canon.centroid[1]) : 0;
  if (canon && shift > VALID.maxCentroidShiftM) return { ok: false, reason: 'centroid-shift', shiftM: +shift.toFixed(2) };
  // bbox で「同じ建物か」を確かめる（位置の正否はこちらが正本）
  let bboxShift = 0, bboxRatio = 1;
  if (canon && canon.bbox) {
    const cb = canon.bbox;
    bboxShift = Math.hypot((cb.minX + cb.maxX) / 2 - (minX + maxX) / 2, (cb.minZ + cb.maxZ) / 2 - (minZ + maxZ) / 2);
    const ca = Math.max(1, (cb.maxX - cb.minX) * (cb.maxZ - cb.minZ));
    bboxRatio = ((maxX - minX) * (maxZ - minZ)) / ca;
    if (bboxShift > VALID.maxBboxCenterShiftM) return { ok: false, reason: 'bbox-center-shift', bboxShiftM: +bboxShift.toFixed(2) };
    if (bboxRatio > VALID.maxBboxAreaRatio) return { ok: false, reason: 'bbox-area-mismatch', bboxAreaRatio: +bboxRatio.toFixed(1) };
  }

  // 三角形分割（surface 種別ごとにまとめる。§10 の material 分け用）
  const byKind = {};
  let tris = 0, degenerate = 0;
  for (const s of surfaces) {
    const t = triangulatePolygon(s.outer, s.holes);
    if (!t) { degenerate++; continue; }
    const b = (byKind[s.kind] = byKind[s.kind] || { positions: [], indices: [] });
    const off = b.positions.length / 3;
    for (const p of t.verts) b.positions.push(+(p[0]).toFixed(2), +(p[1] - baseAlt).toFixed(2), +(p[2]).toFixed(2));
    for (let i = 0; i + 2 < t.indices.length; i += 3) {
      const a = t.indices[i] + off, b2 = t.indices[i + 1] + off, c = t.indices[i + 2] + off;
      if (a === b2 || b2 === c || a === c) { degenerate++; continue; }
      b.indices.push(a, b2, c);
      tris++;
    }
  }
  if (!tris) return { ok: false, reason: 'no-triangles' };
  const parts = Object.entries(byKind).filter(([, v]) => v.indices.length).map(([kind, v]) => ({ kind, positions: v.positions, indices: v.indices, triangles: v.indices.length / 3 }));
  return {
    ok: true, lod, heightM: +heightM.toFixed(2), baseAltM: +baseAlt.toFixed(2),
    centroid: [+cx.toFixed(2), +cz.toFixed(2)], centroidShiftM: +shift.toFixed(2),
    bboxCenterShiftM: +bboxShift.toFixed(2), bboxAreaRatio: +bboxRatio.toFixed(2),
    bbox: { minX: +minX.toFixed(2), maxX: +maxX.toFixed(2), minZ: +minZ.toFixed(2), maxZ: +maxZ.toFixed(2), maxY: +(maxAlt - baseAlt).toFixed(2) },
    parts, triangles: tris, degenerate,
    surfaceCounts: surfaces.reduce((m, s) => ({ ...m, [s.kind]: (m[s.kind] || 0) + 1 }), {}),
  };
}

/** canonical V2N から対象 id の centroid / 用途カテゴリ / LOD1 高さを引く。
 *  用途カテゴリは §16 のため必須: 高 LOD でも LOD1 と同じ用途色を使い、
 *  LOD が切り替わったときに色が変わらないようにする。 */
/**
 * [Mission 34D §22/§23] 採用した高 LOD が本当に LOD1 の箱より情報量を持つかを測り、等級を付ける。
 *   geometry は変えない（QA 用の属性だけ）。
 *   roofLevels = 屋根頂点の標高を 1m 刻みで束ね、全体の 5% 以上を占める段の数。
 */
export const TIER = { multiLevel: 3, manyPolys: 8, someLevel: 2, somePolys: 3, levelBinM: 1, levelShare: 0.05 };
export function roofQuality(rep) {
  const roofPart = (rep.parts || []).find((p) => p.kind === 'roof');
  const ys = [];
  if (roofPart) for (let i = 1; i < roofPart.positions.length; i += 3) ys.push(roofPart.positions[i]);
  const bins = new Map();
  for (const y of ys) { const k = Math.round(y / TIER.levelBinM); bins.set(k, (bins.get(k) || 0) + 1); }
  const need = ys.length * TIER.levelShare;
  const roofLevels = [...bins.values()].filter((n) => n >= need).length;
  const roofPolys = (rep.surfaceCounts && rep.surfaceCounts.roof) || 0;
  const wallPolys = (rep.surfaceCounts && rep.surfaceCounts.wall) || 0;
  const spreadM = ys.length ? +(Math.max(...ys) - Math.min(...ys)).toFixed(2) : 0;
  let tier;
  if (rep.lod === 3) tier = 'LOD3';
  else if (roofLevels >= TIER.multiLevel || roofPolys >= TIER.manyPolys) tier = 'LOD2-A';
  else if (roofLevels >= TIER.someLevel || roofPolys >= TIER.somePolys) tier = 'LOD2-B';
  else tier = 'LOD2-C';
  return { tier, roofLevels, roofPolys, wallPolys, roofSpreadM: spreadM };
}

export function loadCanonical(targetIds) {
  const out = new Map();
  for (const f of fs.readdirSync(CANON)) {
    if (!/^tile_-?\d+_-?\d+\.json$/.test(f)) continue;
    const j = JSON.parse(fs.readFileSync(path.join(CANON, f), 'utf-8'));
    for (const ft of (j.features || [])) {
      const gid = ft.canonicalId.startsWith(CANON_PREFIX) ? ft.canonicalId.slice(CANON_PREFIX.length) : null;
      if (!gid || !targetIds.has(gid)) continue;
      // §19 card 用に canonical の footprint も持って出る。runtime 側で CR のタイル状態に
      //   依存せずに property card を出すため（依存すると、タイルの読み込み順によって
      //   「クリックしても card が出ない棟」ができる。実測で最大 48% がそうなった）。
      const ring = ft.geometryType === 'Polygon' ? ft.coordinates[0] : (ft.coordinates[0] && ft.coordinates[0][0]);
      out.set(gid, { canonicalId: ft.canonicalId, centroid: ft.centroid, areaM2: ft.areaM2, bbox: ft.bbox,
        fp: Array.isArray(ring) ? ring.map((q) => [+q[0].toFixed(2), +q[1].toFixed(2)]) : null });
    }
  }
  const attrDir = path.join(CANON, 'attributes');
  if (fs.existsSync(attrDir)) {
    for (const f of fs.readdirSync(attrDir)) {
      if (!/^tile_-?\d+_-?\d+\.json$/.test(f)) continue;
      const j = JSON.parse(fs.readFileSync(path.join(attrDir, f), 'utf-8'));
      for (const [cid, a] of Object.entries(j.attributes || {})) {
        const gid = cid.startsWith(CANON_PREFIX) ? cid.slice(CANON_PREFIX.length) : null;
        const rec = gid ? out.get(gid) : null;
        if (!rec) continue;
        rec.usageCategory = a.usageCategory || null;
        rec.lod1HeightM = (typeof a.heightM === 'number') ? a.heightM : null;
        // card が使う属性だけを持つ（canonical の値そのまま。LOD で変えない §19）
        rec.attrs = { usage: a.usage ?? null, normalizedUsage: a.normalizedUsage ?? null,
          usageCategory: a.usageCategory ?? null, usageLabel: a.usageLabel ?? null,
          heightM: a.heightM ?? null, heightSource: a.heightSource ?? null, heightUnknown: !!a.heightUnknown,
          source: a.source ?? null, wardId: a.wardId ?? null,
          confidence: (typeof a.confidence === 'number') ? a.confidence : null };
      }
    }
  }
  return out;
}

function* gmlSources() {
  const stack = [RAW_DIR];
  while (stack.length) {
    const d = stack.pop();
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (!/-DESKTOP-/.test(e.name)) stack.push(p); }
      else if (/_bldg_.*\.gml$/i.test(e.name) && !/-DESKTOP-/.test(e.name)) yield { kind: 'folder', base: path.basename(p), file: p };
    }
  }
}

export async function build({ limitFiles = 0 } = {}) {
  const idxDoc = JSON.parse(fs.readFileSync(IDX, 'utf-8'));
  const index = idxDoc.buildings;
  const targetIds = new Set(Object.keys(index));
  console.log('[high-lod] 対象', targetIds.size, '棟（LOD2/LOD3 を持つもの）');

  const canon = loadCanonical(targetIds);
  console.log('[high-lod] canonical 照合', canon.size, '/', targetIds.size);

  // [Mission 34D §12/§13/§17] 再監査の結果（区の割り当てと、id で一致しない棟の空間照合）を読む。
  //   無ければ 34A と同じ挙動になる（後方互換）。
  const REAUDIT = P('data', 'processed', 'osaka-city', 'canonical', 'max-lod-index.json');
  const reauditByGid = new Map();
  const spatialByGid = new Map();
  try {
    const ra = JSON.parse(fs.readFileSync(REAUDIT, 'utf-8'));
    for (const b2 of (ra.buildings || [])) {
      reauditByGid.set(b2.gmlId, { wardId: b2.wardId, chosen: b2.chosen });
      if (b2.spatialCanonicalId) spatialByGid.set(b2.gmlId, b2.spatialCanonicalId);
    }
    console.log('[high-lod] 再監査 index', reauditByGid.size, '/ 空間照合', spatialByGid.size);
  } catch (e) { console.log('[high-lod] 再監査 index なし（34A と同じ挙動）'); }
  // 空間照合で結び付いた canonical を canonicalId 引きできるようにする
  const canonById = new Map();
  if (spatialByGid.size) {
    const wantCid = new Set(spatialByGid.values());
    for (const f of fs.readdirSync(CANON)) {
      if (!/^tile_-?\d+_-?\d+\.json$/.test(f)) continue;
      const j = JSON.parse(fs.readFileSync(path.join(CANON, f), 'utf-8'));
      for (const ft of (j.features || [])) {
        if (!wantCid.has(ft.canonicalId)) continue;
        const ring = ft.geometryType === 'Polygon' ? ft.coordinates[0] : (ft.coordinates[0] && ft.coordinates[0][0]);
        canonById.set(ft.canonicalId, { canonicalId: ft.canonicalId, centroid: ft.centroid, areaM2: ft.areaM2, bbox: ft.bbox,
          fp: Array.isArray(ring) ? ring.map((q) => [+q[0].toFixed(2), +q[1].toFixed(2)]) : null });
      }
    }
    const attrDir2 = path.join(CANON, 'attributes');
    if (fs.existsSync(attrDir2)) for (const f of fs.readdirSync(attrDir2)) {
      if (!/^tile_-?\d+_-?\d+\.json$/.test(f)) continue;
      const j = JSON.parse(fs.readFileSync(path.join(attrDir2, f), 'utf-8'));
      for (const [cid, a2] of Object.entries(j.attributes || {})) {
        const rec = canonById.get(cid);
        if (!rec) continue;
        rec.usageCategory = a2.usageCategory || null;
        rec.lod1HeightM = (typeof a2.heightM === 'number') ? a2.heightM : null;
        rec.attrs = { usage: a2.usage ?? null, normalizedUsage: a2.normalizedUsage ?? null,
          usageCategory: a2.usageCategory ?? null, usageLabel: a2.usageLabel ?? null,
          heightM: a2.heightM ?? null, wardId: a2.wardId ?? null, source: a2.source ?? null };
      }
    }
  }

  // 採用元ファイル（在庫調査が記録した src）ごとにまとめる
  const byFile = new Map();
  for (const [gid, rec] of Object.entries(index)) {
    const key = rec.src || '(unknown)';
    if (!byFile.has(key)) byFile.set(key, []);
    byFile.get(key).push(gid);
  }
  const folder = new Map();
  for (const s of gmlSources()) if (!folder.has(s.base)) folder.set(s.base, s.file);
  const zipEntries = fs.existsSync(RAW_ZIP) ? readZipEntries(RAW_ZIP).filter((e) => /_bldg_\d+_op\.gml$/i.test(e.name)) : [];
  const zipByBase = new Map(zipEntries.map((e) => [path.basename(e.name), e]));

  const stats = { targets: targetIds.size, canonMatched: canon.size, processed: 0, adopted: 0, adoptedLod2: 0, adoptedLod3: 0,
    fallbackToLod1: 0, notFoundInSource: 0, noCanonical: 0, reasons: {}, triangles: 0, vertices: 0, degenerate: 0,
    spatialAdopted: 0, spatialRejected: { duplicateCanonical: 0, bboxMismatch: 0 }, rejected: [], tiers: {}, roofLevels: [],
    centroidShift: [], bboxShift: [], heightDelta: [], surfaceTotals: {}, holes: 0 };
  const tiles = new Map();
  const adoptedCanonicalIds = new Set();   // §28/§29 1 canonical = 1 高 LOD 表現
  let fileNo = 0;
  const fileKeys = [...byFile.keys()].sort();
  for (const key of fileKeys) {
    if (limitFiles && fileNo >= limitFiles) break;
    const base = key.replace('@zip', '');
    const isZip = key.endsWith('@zip');
    const want = new Set(byFile.get(key));
    let text = null;
    if (!isZip && folder.has(base)) text = fs.readFileSync(folder.get(base), 'utf-8');
    else if (zipByBase.has(base)) text = extractEntry(RAW_ZIP, zipByBase.get(base)).toString('utf-8');
    else if (folder.has(base)) text = fs.readFileSync(folder.get(base), 'utf-8');
    if (!text) { stats.notFoundInSource += want.size; fileNo++; continue; }

    const starts = buildingStarts(text);
    for (let i = 0; i < starts.length; i++) {
      const seg = text.slice(starts[i], starts[i + 1] ?? text.length);
      const idm = /gml:id="([^"]+)"/.exec(seg);
      if (!idm) continue;
      const gid = detach(idm[1]);
      if (!want.has(gid)) continue;
      stats.processed++;
      // §11 高 LOD は「canonical building の別表現」。canonical に居ない棟（メッシュが市域外まで
      //   含むため 438 棟ある）は、LOD1 でも描いていないので高 LOD でも描かない。
      let c = canon.get(gid) || null;
      let spatialCandidate = null;
      // [Mission 34D §12/§13] gml:id で一致しない棟は、位置で canonical へ結び付いたものだけ採る。
      //   （34A はここを「メッシュが市域外を含むため」と説明していたが、再監査では 438 棟すべてが
      //     市内だった。実体は「canonical が採っていない市内 PLATEAU 建物」で、34C §7 と同じ母集団。
      //     曖昧な一致は採らない §13。）
      if (!c) {
        const sid = spatialByGid.get(gid);
        // §13 曖昧な一致は採らない。id の裏付けが無いぶん、次の 2 つを必ず確かめる:
        //   (a) その canonical が既に自分の高 LOD を持っていないこと（持っていたら二重表現になる §28/§29）
        //   (b) bbox が本当に重なること（実測: 4.5m の建物に 6.54m ずれた別棟が当たっていた）
        if (sid && !adoptedCanonicalIds.has(sid)) { c = canonById.get(sid) || null; if (c) spatialCandidate = sid; }
        else if (sid) stats.spatialRejected.duplicateCanonical++;
      }
      if (!c) {
        stats.noCanonical++;
        if (stats.rejected.length < 2000) stats.rejected.push({ gmlId: gid, reason: 'NOT_IN_CANONICAL',
          ward: (reauditByGid.get(gid) || {}).wardId || null, lod: index[gid] ? index[gid].lod : null });
        continue;
      }
      // §4 LOD3 → LOD2 の順に試し、どちらも駄目なら LOD1（= 既存表示）へ落とす
      let rep = null, lastReject = null;
      for (const lod of [3, 2]) {
        if (index[gid].lod < lod) continue;
        const surfaces = extractSurfaces(seg, lod);
        if (!surfaces.length) { stats.reasons['no-' + lod + '-surfaces'] = (stats.reasons['no-' + lod + '-surfaces'] || 0) + 1; continue; }
        for (const s of surfaces) stats.holes += s.holes.length;
        const r = buildRepresentation(surfaces, c, lod);
        if (r.ok) { rep = r; break; }
        lastReject = { lod, reason: r.reason, shiftM: r.shiftM ?? null, bboxShiftM: r.bboxShiftM ?? null,
          heightM: r.heightM ?? null, bboxAreaRatio: r.bboxAreaRatio ?? null };
        stats.reasons[lod + ':' + r.reason] = (stats.reasons[lod + ':' + r.reason] || 0) + 1;
      }
      if (!rep) {
        stats.fallbackToLod1++;
        // [Mission 34D §21/§36] なぜ LOD1 のままなのかを棟ごとに残す（dev QA が 1 クリックで読む）
        if (stats.rejected.length < 2000) stats.rejected.push({ gmlId: gid, canonicalId: c.canonicalId,
          reason: 'LOD_VALIDATION_REJECTED', detail: lastReject, ward: (reauditByGid.get(gid) || {}).wardId || null,
          lod: index[gid] ? index[gid].lod : null });
        continue;
      }
      // §13 空間照合だけで結び付けた棟は、bbox が厳密に重なるものだけ採る
      if (spatialCandidate) {
        if (rep.bboxCenterShiftM > SPATIAL_VALID.maxBboxCenterShiftM || rep.bboxAreaRatio > SPATIAL_VALID.maxBboxAreaRatio) {
          stats.spatialRejected.bboxMismatch++;
          if (stats.rejected.length < 2000) stats.rejected.push({ gmlId: gid, canonicalId: c.canonicalId,
            reason: 'SPATIAL_MATCH_REJECTED',
            detail: { bboxCenterShiftM: rep.bboxCenterShiftM, bboxAreaRatio: rep.bboxAreaRatio },
            ward: (reauditByGid.get(gid) || {}).wardId || null, lod: index[gid] ? index[gid].lod : null });
          stats.noCanonical++;
          continue;
        }
        stats.spatialAdopted++;
      }
      adoptedCanonicalIds.add(c.canonicalId);
      stats.adopted++;
      if (rep.lod === 3) stats.adoptedLod3++; else stats.adoptedLod2++;
      const rq = roofQuality(rep);
      stats.tiers[rq.tier] = (stats.tiers[rq.tier] || 0) + 1;
      stats.roofLevels.push(rq.roofLevels);
      stats.triangles += rep.triangles;
      stats.degenerate += rep.degenerate;
      for (const p of rep.parts) stats.vertices += p.positions.length / 3;
      for (const [k, v] of Object.entries(rep.surfaceCounts)) stats.surfaceTotals[k] = (stats.surfaceTotals[k] || 0) + v;
      if (c) stats.centroidShift.push(rep.centroidShiftM);
      if (c) stats.bboxShift.push(rep.bboxCenterShiftM);
      if (c && typeof c.lod1HeightM === 'number') stats.heightDelta.push(+(rep.heightM - c.lod1HeightM).toFixed(2));
      // タイル割当は canonical の重心（= 既存 building tile と同じ区切り）
      const px = c ? c.centroid[0] : rep.centroid[0], pz = c ? c.centroid[1] : rep.centroid[1];
      const tx = Math.floor(px / TILE), tz = Math.floor(pz / TILE);
      const tk = tx + '_' + tz;
      if (!tiles.has(tk)) tiles.set(tk, []);
      tiles.get(tk).push({
        canonicalId: c ? c.canonicalId : CANON_PREFIX + gid,
        // §16 LOD1 と同じ用途色を使うためのカテゴリ（色を変えない）
        usageCategory: c ? (c.usageCategory || null) : null,
        lod1HeightM: c ? (c.lod1HeightM ?? null) : null,
        fp: c ? (c.fp || null) : null, attrs: c ? (c.attrs || null) : null,
        lod: rep.lod, src: base, heightM: rep.heightM, baseAltM: rep.baseAltM,
        centroid: rep.centroid, centroidShiftM: rep.centroidShiftM,
        bboxCenterShiftM: rep.bboxCenterShiftM, bboxAreaRatio: rep.bboxAreaRatio, bbox: rep.bbox,
        triangles: rep.triangles, parts: rep.parts,
        // [Mission 34D §22/§23] QA 用（geometry には影響しない）
        tier: rq.tier, roofLevels: rq.roofLevels, roofPolys: rq.roofPolys, wallPolys: rq.wallPolys, roofSpreadM: rq.roofSpreadM,
      });
    }
    fileNo++;
    if (fileNo % 5 === 0 || fileNo === fileKeys.length) {
      console.log(`[high-lod] ${fileNo}/${fileKeys.length} files  adopted=${stats.adopted}  tri=${stats.triangles}  heap=${Math.round(process.memoryUsage().heapUsed / 1048576)}MB`);
    }
  }

  // ── 書き出し ──
  const files = new Map();
  const tileList = [];
  for (const [tk, list] of [...tiles.entries()].sort()) {
    const [tx, tz] = tk.split('_').map(Number);
    const body = JSON.stringify({
      tileId: 'building-lod-high/' + tk, tx, tz, tileSize: TILE,
      coordinateConvention: 'znorth-neg-v1', coordinateSystem: 'livecity-local-equirect',
      count: list.length, buildings: list,
    });
    files.set(`tile_${tx}_${tz}.json`, body);
    tileList.push({ tx, tz, file: `tile_${tx}_${tz}.json`, count: list.length, triangles: list.reduce((s, b) => s + b.triangles, 0) });
  }
  const manifest = {
    version: 1, kind: 'building-lod-high', namespace: 'derived-v2-osmv2',
    coordinateConvention: 'znorth-neg-v1', coordinateSystem: 'livecity-local-equirect',
    generatedAt: new Date().toISOString(), missionId: '34A', tileSize: TILE,
    buildingCount: stats.adopted, lod2Count: stats.adoptedLod2, lod3Count: stats.adoptedLod3,
    triangles: stats.triangles, vertices: stats.vertices,
    surfaceKinds: [...new Set(Object.keys(stats.surfaceTotals))],
    zone7Used: false, source: 'PLATEAU CityGML (EPSG:6697) → latLonToLiveCityWorld',
    tiles: tileList,
  };
  files.set('manifest.json', JSON.stringify(manifest, null, 2));
  // [Mission 34D §35/§36] 「なぜこの建物は LOD1 なのか」を dev QA が 1 クリックで読めるようにする。
  //   高 LOD を持っているのに採用しなかった棟だけを載せる（それ以外は NO_LOD2_IN_RAW_SOURCE）。
  files.set('high-lod-reasons.json', JSON.stringify({
    version: 1, generatedAt: manifest.generatedAt, missionId: '34D',
    defaultReason: 'NO_LOD2_IN_RAW_SOURCE',
    note: 'ここに載っていない建物は raw PLATEAU に LOD2/LOD3 自体が無い。',
    count: stats.rejected.length,
    byCanonicalId: Object.fromEntries(stats.rejected.filter((r) => r.canonicalId).map((r) => [r.canonicalId,
      { reason: r.reason, detail: r.detail || null, lod: r.lod, ward: r.ward }])),
    notInCanonical: stats.rejected.filter((r) => !r.canonicalId).map((r) => ({ gmlId: r.gmlId, ward: r.ward, lod: r.lod })),
  }));
  for (const dir of [OUT_PUBLIC, OUT_PROCESSED]) {
    fs.mkdirSync(dir, { recursive: true });
    writeFilesVerified(dir, files, { removeStray: true });
  }

  const shift = stats.centroidShift.slice().sort((a, b) => a - b);
  const report = {
    version: 1, generatedAt: manifest.generatedAt, missionId: '34A',
    targets: stats.targets, canonMatched: stats.canonMatched, processed: stats.processed,
    adopted: stats.adopted, adoptedLod2: stats.adoptedLod2, adoptedLod3: stats.adoptedLod3,
    fallbackToLod1: stats.fallbackToLod1, notFoundInSource: stats.notFoundInSource, noCanonicalSkipped: stats.noCanonical,
    invalidReasons: stats.reasons, degenerateTrianglesDropped: stats.degenerate, interiorRings: stats.holes,
    // [Mission 34D] 追加の会計
    spatialAdopted: stats.spatialAdopted, spatialRejected: stats.spatialRejected, qualityTiers: stats.tiers,
    roofLevelHistogram: (() => { const h = {}; for (const n of stats.roofLevels) h[n] = (h[n] || 0) + 1; return h; })(),
    roofLevelsMean: stats.roofLevels.length ? +(stats.roofLevels.reduce((a3, b3) => a3 + b3, 0) / stats.roofLevels.length).toFixed(2) : null,
    multiLevelRoofPct: stats.roofLevels.length ? +(100 * stats.roofLevels.filter((n) => n >= 2).length / stats.roofLevels.length).toFixed(1) : null,
    rejectedDetail: stats.rejected.slice(0, 600),
    triangles: stats.triangles, vertices: stats.vertices, surfaceTotals: stats.surfaceTotals,
    centroidShiftM: shift.length ? { n: shift.length, median: shift[Math.floor(shift.length / 2)], p90: shift[Math.floor(shift.length * 0.90)], p95: shift[Math.floor(shift.length * 0.95)], p99: shift[Math.floor(shift.length * 0.99)], max: shift[shift.length - 1] } : null,
    // 位置の正否はこちら（重心は頂点平均なので複雑な平面でぶれる）
    bboxCenterShiftM: (() => { const a = stats.bboxShift.slice().sort((x, y) => x - y); return a.length ? { n: a.length, median: a[Math.floor(a.length / 2)], p90: a[Math.floor(a.length * 0.90)], p95: a[Math.floor(a.length * 0.95)], p99: a[Math.floor(a.length * 0.99)], max: a[a.length - 1], over2m: a.filter((v) => v > 2).length, over5m: a.filter((v) => v > 5).length } : null; })(),
    heightDeltaM: (() => { const h = stats.heightDelta.slice().sort((a, b) => a - b); return h.length ? { n: h.length, median: h[Math.floor(h.length / 2)], p05: h[Math.floor(h.length * 0.05)], p95: h[Math.floor(h.length * 0.95)], min: h[0], max: h[h.length - 1] } : null; })(),
    tiles: tileList.length,
    outputBytes: [...files.values()].reduce((s, b) => s + Buffer.byteLength(b), 0),
    validity: VALID,
  };
  fs.mkdirSync(path.dirname(OUT_REPORT), { recursive: true });
  fs.writeFileSync(OUT_REPORT, JSON.stringify(report, null, 2));
  return report;
}

if (isMainModule(import.meta.url)) {
  const li = process.argv.indexOf('--limit-files');
  build({ limitFiles: li >= 0 ? Number(process.argv[li + 1]) : 0 }).then((r) => {
    console.log('[high-lod] 採用', r.adopted, '(LOD2', r.adoptedLod2, '/ LOD3', r.adoptedLod3, ')');
    console.log('[high-lod] LOD1 へ戻した', r.fallbackToLod1, '理由', JSON.stringify(r.invalidReasons));
    console.log('[high-lod] 三角形', r.triangles, '頂点', r.vertices, 'タイル', r.tiles, (r.outputBytes / 1048576).toFixed(1) + 'MB');
    console.log('[high-lod] 重心ズレ', JSON.stringify(r.centroidShiftM), 'surface', JSON.stringify(r.surfaceTotals));
    process.exit(0);
  }).catch((e) => { console.error(e); process.exit(1); });
}
