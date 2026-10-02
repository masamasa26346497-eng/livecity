#!/usr/bin/env node
// tools/validate/high-lod-visual-quality.js
// [Mission 34B §30] 「高 LOD の屋根が読めるようになったか」「geometry は 1mm も動かしていないか」の検証。
//   geometryMutation = 0 / positionMutation = 0 / projectionMutation = 0
//   highLodRoofReadable = true / roofWallVisualSeparation = true
//   lodDiffQaAvailable = true / lodCameraPresetsAvailable = true
//   productionModified = false / protectedModified = false
//   → HIGH_LOD_VISUAL_QUALITY_SUCCESS / HIGH_LOD_VISUAL_QUALITY_FAILED
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { resolveProjectPath, isMainModule } from '../lib/paths.js';
import { writeJson } from '../lib/area.js';
import { stripComments } from './max-plateau-lod.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const F = {
  dev: P('public', 'osaka_3d_buildings.ward-ux-v1.html'),
  prod: P('public', 'osaka_3d_buildings.html'),
  prot: P('public', 'osaka_3d_buildings.fullward-v3.html'),
  area: P('config', 'areas', 'osaka-city.json'),
  vis: P('data', 'reports', 'high-lod-visual-qa.json'),
  build: P('data', 'reports', 'plateau-high-lod-build.json'),
  pre: P('data', 'reports', 'building-lod-precutover.json'),
  roof: P('data', 'reports', 'high-lod-roof-structure-qa.json'),
  landmarkModels: P('public', 'map-data', 'osaka-city', 'landmarks', 'landmark-models.json'),
  highDir: P('public', 'map-data', 'osaka-city', 'derived-v2-osmv2', 'building-lod-high'),
  canonManifest: P('data', 'processed', 'osaka-city', 'canonical', 'buildings-v2-osmv2', 'manifest.json'),
  prodBuild: P('data', 'reports', 'production-cutover-build.json'),
  baseline: P('data', 'reports', 'baselines', 'prod-protected-hashes.json'),
  out: P('data', 'reports', 'high-lod-visual-quality-validation.json'),
};
// §4 材質の許容範囲
export const MATERIAL_SPEC = {
  roughness: [0.72, 0.88], metalness: [0.00, 0.05],
  roofLumRatio: [1.06, 1.12],       // 屋根は壁より +6〜12% 明るい
  roofSatDrop: [0.00, 0.05],        // 彩度は 0〜5% 落とすだけ
};
// §7 主光の向き
export const LIGHT_SPEC = { azimuthDeg: [225, 247.5], elevationDeg: [40, 55] };
// §23-§27 各地点で描かれる高 LOD 棟数（34A cutover 前チェックの実測値）
export const SITE_HIGH_LOD_COUNT = { honmachi: 2842, umeda: 1221, nakanoshima: 1841, osakacastle: 1268, shinosaka: 1333 };
const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const inR = (v, [lo, hi]) => typeof v === 'number' && v >= lo && v <= hi;
function dirStat(dir) {
  let files = 0, bytes = 0, newest = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const q = path.join(d, e.name);
      if (e.isDirectory()) { walk(q); continue; }
      const st = fs.statSync(q);
      files++; bytes += st.size; newest = Math.max(newest, st.mtimeMs);
    }
  };
  try { walk(dir); } catch { return null; }
  return { files, bytes, newest };
}

// ブラウザで取った指紋（CR_lodHigh_tx_tz|kind → "頂点数,Σx,Σy,Σz,minX,maxX,minY,maxY,minZ,maxZ,index数,part数"）を
//   タイル JSON から同じ順序で組み直したものと突き合わせる。
//   §14/§15 LOD VIEW の距離（900m）は mid band なので、描かれる surface は roof / wall / closure のみ。
export const MID_BAND_KINDS = new Set(['roof', 'wall', 'closure']);
export const FP_TOLERANCE = { sum: 1.0, bbox: 0.01 };   // Float32 と倍精度の差を吸収する
export function fingerprintTileFromSource(doc, kind, skipIds) {
  let count = 0, sx = 0, sy = 0, sz = 0, idx = 0, parts = 0;
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const b of (doc.buildings || [])) {
    // §18 LandmarkHD が承認済みモデルを出している棟は runtime 側で描かれない
    if (skipIds && skipIds.has(b.canonicalId)) continue;
    for (const p of (b.parts || [])) {
      if (p.kind !== kind) continue;
      parts++;
      idx += p.indices.length;
      for (let i = 0; i < p.positions.length; i += 3) {
        const x = Math.fround(p.positions[i]), y = Math.fround(p.positions[i + 1]), z = Math.fround(p.positions[i + 2]);
        count++; sx += x; sy += y; sz += z;
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
        if (z < z0) z0 = z; if (z > z1) z1 = z;
      }
    }
  }
  return { count, sx, sy, sz, x0, x1, y0, y1, z0, z1, idx, parts };
}
function compareRuntimeFingerprintToSource(after) {
  const out = { compared: 0, mismatched: 0, landmarkSuppressed: 0, worst: [] };
  if (!after) return out;
  // LandmarkHD が持っている棟は高 LOD 側では描かれないので、再現側からも外す。
  //   （地点を移動しても前の地点のタイルは scene に残るため、大阪城のタイルは
  //     どの地点の指紋にも現れうる。地点で場合分けせず id で外すのが正しい）
  const skipIds = new Set();
  for (const l of ((rj(F.landmarkModels) || {}).landmarks || [])) {
    for (const id of (l.suppressBuildingIds || [])) skipIds.add(id);
  }
  out.landmarkSuppressed = skipIds.size;
  const cache = new Map();
  for (const s of (after.sites || [])) {
    for (const [key, val] of Object.entries((s.high && s.high.geomFp) || {})) {
      const [grp, kind] = key.split('|');
      const m = grp.match(/^CR_lodHigh_(-?\d+)_(-?\d+)$/);
      if (!m || !MID_BAND_KINDS.has(kind)) continue;
      const file = path.join(F.highDir, `tile_${m[1]}_${m[2]}.json`);
      if (!cache.has(file)) cache.set(file, rj(file));
      const doc = cache.get(file);
      if (!doc) continue;
      const src = fingerprintTileFromSource(doc, kind, skipIds);
      const got = val.split(',').map(Number);
      const bad = [];
      if (got[0] !== src.count) bad.push(`頂点数 ${got[0]}≠${src.count}`);
      if (got[10] !== src.idx) bad.push(`index 数 ${got[10]}≠${src.idx}`);
      if (got[11] !== src.parts) bad.push(`part 数 ${got[11]}≠${src.parts}`);
      const sums = [[got[1], src.sx], [got[2], src.sy], [got[3], src.sz]];
      for (const [a, b] of sums) if (Math.abs(a - b) > FP_TOLERANCE.sum) bad.push(`座標和 ${a}≠${b.toFixed(2)}`);
      const box = [[got[4], src.x0], [got[5], src.x1], [got[6], src.y0], [got[7], src.y1], [got[8], src.z0], [got[9], src.z1]];
      for (const [a, b] of box) if (Math.abs(a - b) > FP_TOLERANCE.bbox) bad.push(`bbox ${a}≠${b.toFixed(3)}`);
      out.compared++;
      if (bad.length) { out.mismatched++; if (out.worst.length < 5) out.worst.push({ key, site: s.site, issues: bad }); }
    }
  }
  return out;
}

export async function validateHighLodVisualQuality() {
  const errors = [], warnings = [];
  const raw = fs.readFileSync(F.dev, 'utf-8');
  const html = stripComments(raw);
  const vis = rj(F.vis), build = rj(F.build), pre = rj(F.pre);
  const after = vis && vis.phases ? vis.phases.after : null;
  const before = vis && vis.phases ? vis.phases.before : null;

  // ── §1 geometry は一切変えない ──────────────────────────────────────────
  // 高 LOD のタイルは 34A のビルド成果物そのままか（ファイル数・総バイト・更新時刻）
  const hs = dirStat(F.highDir);
  const buildStamp = build ? Date.parse(build.generatedAt) : 0;
  const tileBytesMatch = !!(hs && build && hs.bytes === build.outputBytes);
  const tileUntouched = !!(hs && buildStamp && hs.newest <= buildStamp + 60000);
  if (!tileBytesMatch) errors.push(`§1: 高 LOD タイルの総バイトが 34A ビルドと違う now=${hs && hs.bytes} build=${build && build.outputBytes}`);
  if (!tileUntouched) errors.push('§1: 高 LOD タイルが 34A ビルド後に書き換えられている');
  // 頂点座標をそのまま積む経路が変わっていない（スケール・オフセットを挟んでいない）
  const vertexPathIntact = /acc\.pos\.push\(p\.positions\[i\], p\.positions\[i \+ 1\], p\.positions\[i \+ 2\]\);/.test(html);
  if (!vertexPathIntact) errors.push('§1: 高 LOD の頂点座標をそのまま積む経路が変わっている');
  // 描いているものの指紋（before / after の両方が取れている場合のみ照合）
  const cmp = (vis && vis.comparison) || [];
  const fpCompared = cmp.reduce((a, c) => a + ((c.geometry && c.geometry.comparedMeshes) || 0), 0);
  const fpChanged = cmp.reduce((a, c) => a + ((c.geometry && c.geometry.changedMeshes) || 0), 0);
  if (fpCompared > 0 && fpChanged > 0) errors.push('§1: 描画中の geometry 指紋が before / after で違う ' + fpChanged);
  // 画面に出ている頂点が 34A のタイルデータそのものか（runtime で拡大縮小・平行移動していないか）。
  //   タイル JSON から同じ手順で指紋を組み直し、ブラウザで取った指紋と突き合わせる。
  const srcCheck = compareRuntimeFingerprintToSource(after);
  if (srcCheck.compared > 0 && srcCheck.mismatched > 0) {
    errors.push('§1: 描画中の頂点がタイルデータと一致しない ' + JSON.stringify(srcCheck.worst.slice(0, 3)));
  }
  if (srcCheck.compared === 0) warnings.push('§1: 描画中の頂点とタイルデータの照合ができていない');
  const geometryMutation = (!tileBytesMatch || !tileUntouched || !vertexPathIntact || fpChanged > 0 || srcCheck.mismatched > 0) ? 1 : 0;

  // ── §1 建物の位置は変えない ─────────────────────────────────────────────
  const canon = rj(F.canonManifest) || {};
  const canonOk = canon.featureCount === 600764;
  if (!canonOk) errors.push('§1: canonical V2N の建物数が 600,764 でない: ' + canon.featureCount);
  // 各地点で描かれる高 LOD 棟数が 34A から変わっていない（消失・増加がない）
  const siteCounts = [];
  if (after) for (const s of (after.sites || [])) {
    const got = s.high && s.high.lod ? (s.high.lod.visibleLod2 + s.high.lod.visibleLod3) : null;
    const want = SITE_HIGH_LOD_COUNT[s.site];
    siteCounts.push({ site: s.site, expected: want, actual: got, ok: got === want });
    if (want != null && got !== want) errors.push(`§1: ${s.site} の高 LOD 棟数が変わっている expected=${want} actual=${got}`);
  }
  const positionMutation = (!canonOk || siteCounts.some((s) => !s.ok)) ? 1 : 0;

  // ── §1 投影は変えない ──────────────────────────────────────────────────
  const proj = (rj(F.area) || {}).projection || {};
  const projectionMutation = (proj.type === 'local-equirectangular' && proj.centerLat === 34.604208
    && proj.centerLon === 135.52502 && proj.metersPerDegree === 111320) ? 0 : 1;
  if (projectionMutation) errors.push('§1: projection が変わっている');
  const zoneVIIProjectionUsed = /latLonToJPRect\s*\(|jprect/i.test(html);
  if (zoneVIIProjectionUsed) errors.push('§1: Zone VII 変換が復活している');

  // ── §4/§5 屋根と壁の見分け ─────────────────────────────────────────────
  const dbg = after && after.sites && after.sites[0] && after.sites[0].high && after.sites[0].high.lod;
  const pbr = dbg ? dbg.surfacePbr : null;
  const tint = dbg ? dbg.roofTint : null;
  const materialType = dbg ? dbg.materialType : null;
  const flatShading = dbg ? !!dbg.flatShading : null;
  const roughnessOk = !!(pbr && inR(pbr.roof.roughness, MATERIAL_SPEC.roughness) && inR(pbr.wall.roughness, MATERIAL_SPEC.roughness));
  const metalnessOk = !!(pbr && inR(pbr.roof.metalness, MATERIAL_SPEC.metalness) && inR(pbr.wall.metalness, MATERIAL_SPEC.metalness));
  if (!roughnessOk) errors.push('§4: roughness が 0.72〜0.88 の外 ' + JSON.stringify(pbr));
  if (!metalnessOk) errors.push('§4: metalness が 0.00〜0.05 の外 ' + JSON.stringify(pbr));
  const tintOk = !!(tint && inR(tint.lumRatio, MATERIAL_SPEC.roofLumRatio) && inR(1 - tint.sat, MATERIAL_SPEC.roofSatDrop));
  if (!tintOk) errors.push('§4: 屋根の明度・彩度の設定が範囲外 ' + JSON.stringify(tint));
  // 実測：屋根面と壁面の色の明るさの比（用途色 × 屋根補正）
  const roofRatios = after ? (after.sites || []).map((s) => ({ site: s.site, colorRatio: s.high.roofWall.colorRatio, litRatio: s.high.roofWall.litRatio })) : [];
  const colorSepOk = roofRatios.length > 0 && roofRatios.every((r) => inR(r.colorRatio, MATERIAL_SPEC.roofLumRatio));
  if (!colorSepOk) errors.push('§4: 実測の屋根/壁の明るさ比が 1.06〜1.12 の外 ' + JSON.stringify(roofRatios));
  // 受ける光まで含めて屋根が壁より暗くない（旧実装は 0.61 = 屋根が 39% 暗かった）
  const litSepOk = roofRatios.length > 0 && roofRatios.every((r) => typeof r.litRatio === 'number' && r.litRatio >= 1.0);
  if (!litSepOk) errors.push('§4: 受光まで含めると屋根が壁より暗い ' + JSON.stringify(roofRatios));
  const roofWallVisualSeparation = !!(roughnessOk && metalnessOk && tintOk && colorSepOk && litSepOk);

  // ── §6 用途色（33A/33B の palette）は変えない ───────────────────────────
  const paletteIntact = /residential_low: 0xcaa870,/.test(html) && /commercial:\s+0xd6a259,/.test(html)
    && /const CR_VIVID = \{ sat: 1\.24, light: 1\.03 \};/.test(html)
    && /const CR_USAGE_WHITEN = \{ far: 0\.46, mid: 0\.20, near: 0\.06 \};/.test(html);
  if (!paletteIntact) errors.push('§6: 用途色の palette が変わっている');
  // 高 LOD の色は LOD1 と同じ material から取っている
  const sameUsageColor = /CanonicalRuntime\.buildingMaterial\(cat, band === 'near' \? 'near' : 'mid'\)/.test(html);
  if (!sameUsageColor) errors.push('§6: 高 LOD の用途色が LOD1 と別になっている');

  // ── §7/§8/§9 光 ────────────────────────────────────────────────────────
  const light = after ? after.lighting : null;
  const sunAz = light && light.sun ? light.sun.azimuthDeg : null;
  const sunEl = light && light.sun ? light.sun.elevationDeg : null;
  const sunDirOk = inR(sunAz, LIGHT_SPEC.azimuthDeg) && inR(sunEl, LIGHT_SPEC.elevationDeg);
  if (!sunDirOk) errors.push(`§7: 主光の向きが範囲外 azimuth=${sunAz} elevation=${sunEl}`);
  const fillKept = !!(light && light.fill && light.fill.intensity > 0);
  if (!fillKept) errors.push('§8: 補助光が消えている（影が黒く潰れる）');
  // §9 環境光を上げていない（33A の CR_STYLE のまま）
  const ambientNotRaised = /const CR_STYLE = \{ exposure: 0\.93, hemi: 0\.74, sun: 1\.28, fill: 0\.26 \};/.test(html)
    && !!(light && light.hemi && light.hemi.intensity <= 0.75 && light.exposure <= 0.94);
  if (!ambientNotRaised) errors.push('§9: 環境光 / 露出を上げてしまっている ' + JSON.stringify(light && { hemi: light.hemi, exposure: light.exposure }));

  // ── §11 全建物への黒 outline は禁止 ─────────────────────────────────────
  const noGlobalOutline = !/EdgesGeometry|LineSegments/.test(html.slice(html.indexOf('const BuildingLODLayer'), html.indexOf('const CanonicalRuntime')));
  if (!noGlobalOutline) errors.push('§11: 高 LOD に全建物 outline を入れている');
  // §12 通常表示では透明化しない
  const lodBlock = raw.slice(raw.indexOf('function materialFor(kind)'), raw.indexOf('function qaMaterialFor'));
  const noTransparency = !/transparent:\s*true/.test(lodBlock);
  if (!noTransparency) errors.push('§12: 通常の高 LOD 表示で透明化している');

  // ── §22 比較モード ──────────────────────────────────────────────────────
  const lodDiffQaAvailable = /window\.__BUILDING_LOD_MODE__ = \(m\) => BuildingLODLayer\.setViewMode\(m\);/.test(html)
    && /const mode = \(m === 'lod1' \|\| m === 'diff' \|\| m === 'roof'\) \? m : 'high';/.test(html)
    && /CanonicalRuntime\.setBuildingDiffGray\(mode === 'diff'\)/.test(html)
    && /id = 'lod-view-mode-' \+ mk;/.test(html)
    && /id = 'lod-roof-qa-toggle'/.test(html);
  if (!lodDiffQaAvailable) errors.push('§22: LOD1 ONLY / HIGH LOD / LOD DIFF / ROOF QA が揃っていない');
  // 実際に 4 モードとも動いたか（after 実行時の記録）
  const modesExercised = !!(after && (after.sites || []).every((s) => s.high && s.lod1 && s.diff));
  if (!modesExercised) warnings.push('§22: after の実行で 3 モードの記録が揃っていない');

  // ── §13 camera preset ───────────────────────────────────────────────────
  const lodCameraPresetsAvailable = /const LOD_VIEW_PRESET = \{ pitchDeg: 50, fov: 44, r: 900, headingDeg: -35 \};/.test(html)
    && /window\.__LOD_VIEW__ = \(siteId\) => lodViewApply\(siteId \|\| null\);/.test(html)
    && ['honmachi', 'umeda', 'nakanoshima', 'osakacastle', 'shinosaka'].every((s) => html.includes(`id: '${s}'`))
    && /id = 'lod-view-site-' \+ s\.id;/.test(html)
    && /id = 'lod-view-toggle'/.test(html);
  if (!lodCameraPresetsAvailable) errors.push('§13: LOD VIEW / 地点別 preset が揃っていない');
  const presetPitchOk = !!(after && after.view && after.view.pitchDeg >= 45 && after.view.pitchDeg <= 55
    && after.view.fov >= 40 && after.view.fov <= 48 && after.view.r >= 600 && after.view.r <= 1200);
  if (!presetPitchOk) errors.push('§13: preset の pitch / fov / 距離が範囲外 ' + JSON.stringify(after && after.view));

  // ── §2/§3 屋根形状が読めるようになったか ────────────────────────────────
  //   同一 camera の HIGH LOD と LOD1 ONLY を比べ、画面の局所コントラスト
  //   （隣り合う画素の明るさの差＝面の切り替わりの多さ）が高 LOD 側で増えていること。
  const readable = [];
  if (after) for (const s of (after.sites || [])) {
    const hi = s.high.pixels.localContrast, lo = s.lod1.pixels.localContrast;
    readable.push({ site: s.site, highLod: hi, lod1Only: lo, gain: +((hi / lo - 1) * 100).toFixed(1) });
  }
  const readableOk = readable.length > 0 && readable.every((r) => r.highLod > r.lod1Only);
  if (!readableOk) errors.push('§3: 高 LOD でも LOD1 と画面の階調が変わらない地点がある ' + JSON.stringify(readable));
  // 変更前より良くなったか（before があるときだけ）
  const improved = cmp.filter((c) => c.contrastVsLod1).map((c) => ({ site: c.site,
    before: c.contrastVsLod1.before, after: c.contrastVsLod1.after,
    roofWallLit: c.roofWallLitRatio, roofWallColor: c.roofWallColorRatio }));
  const improvedOk = improved.length === 0 || improved.every((i) => i.after >= i.before);
  if (!improvedOk) warnings.push('§2: 変更前より LOD1 との差が縮んだ地点がある ' + JSON.stringify(improved));
  const highLodRoofReadable = !!(readableOk && sunDirOk && materialType === 'MeshStandardMaterial' && flatShading && roofWallVisualSeparation);

  // ── §23-§27 地点ごとの受入条件 ──────────────────────────────────────────
  const roofQa = rj(F.roof);
  let roofStructure = null, landmarkPriority = null, roofOverhang = null;
  if (!roofQa) warnings.push('§23: high-lod-roof-structure-qa.json が無い（屋根の段差を数値で確かめていない）');
  else {
    roofStructure = (roofQa.sites || []).map((s) => ({ site: s.site, siteName: s.siteName,
      buildings: s.roof.buildingsWithRoof, multiLevelPct: s.roof.multiLevelPct,
      avgRoofLevels: s.roof.avgRoofLevels, roofHeightSpreadP90: s.roof.roofHeightSpreadM.p90 }));
    // 箱の上面 1 枚だけではない棟が一定割合ある＝段差・塔屋が見える
    const flat = roofStructure.filter((s) => !(s.multiLevelPct >= 15));
    if (flat.length) errors.push('§23: 屋根が 1 段しかない地点がある ' + JSON.stringify(flat));
    // §27 屋根が canonical footprint からはみ出していないか（新大阪の線路上への張り出し確認）。
    //   ここで測っているのは 34A が作った geometry の性質であり、34B では 1mm も変えていない
    //   （geometryMutation の照合を参照）。34A は bboxAreaRatio ≤ 4 まで許容しているので、
    //   大きな建物で数 m の差が残るのは想定内。問題になるのは「多数の棟でずれている」場合。
    roofOverhang = (roofQa.sites || []).map((s) => ({ site: s.site, checked: s.roof.overhang.checked,
      maxM: s.roof.overhang.maxM, over2m: s.roof.overhang.over2m,
      over2mPct: s.roof.overhang.checked ? +(100 * s.roof.overhang.over2m / s.roof.overhang.checked).toFixed(2) : null,
      worst: s.roof.overhang.worst }));
    const spread = roofOverhang.filter((s) => s.over2mPct != null && s.over2mPct > 2);
    if (spread.length) errors.push('§27: 屋根が footprint からはみ出す棟が多い ' + JSON.stringify(spread.map((s) => [s.site, s.over2mPct])));
    const far = roofOverhang.filter((s) => s.maxM > 5);
    if (far.length) warnings.push('§27: 5m 以上はみ出す棟がある（34A の geometry 由来・34B では未変更） '
      + JSON.stringify(far.map((s) => ({ site: s.site, maxM: s.maxM, over2m: s.over2m, checked: s.checked }))));
    // §26 大阪城は LandmarkHD が高 LOD より優先
    const castle = (roofQa.sites || []).find((s) => s.site === 'osakacastle');
    if (castle && castle.landmark) {
      landmarkPriority = castle.landmark.available && castle.landmark.landmarkOwnedDrawnByHighLod === 0;
      if (!landmarkPriority) errors.push('§26: LandmarkHD が持つ棟を高 LOD も描いている ' + JSON.stringify(castle.landmark));
    }
  }

  // ── §28 性能 ────────────────────────────────────────────────────────────
  const perf = after ? (after.performance || []) : [];
  const perfPairs = [...new Set(perf.map((p) => p.site))].map((site) => {
    const on = perf.find((p) => p.site === site && p.highLod), off = perf.find((p) => p.site === site && !p.highLod);
    return { site, fpsHighLod: on ? on.fpsAverage : null, fpsLod1Only: off ? off.fpsAverage : null,
      deltaPct: (on && off && off.fpsAverage) ? +(((on.fpsAverage / off.fpsAverage) - 1) * 100).toFixed(1) : null,
      trianglesHigh: on ? on.trianglesAvg : null, trianglesLod1: off ? off.trianglesAvg : null,
      drawCallsHigh: on ? on.drawCallsAvg : null, drawCallsLod1: off ? off.drawCallsAvg : null };
  });
  const perfBad = perfPairs.filter((p) => p.deltaPct != null && p.deltaPct < -20);
  if (perfBad.length) warnings.push('§28: 高 LOD で FPS が 20% 以上落ちた地点 ' + JSON.stringify(perfBad));

  // ── production / protected ──────────────────────────────────────────────
  const prodBuild = rj(F.prodBuild) || {};
  const baseline = rj(F.baseline) || {};
  const productionModified = prodBuild.productionSha256 ? sha(F.prod) !== prodBuild.productionSha256 : null;
  const protectedModified = baseline.prot ? sha(F.prot) !== baseline.prot : null;
  if (productionModified !== false) errors.push('production HTML が変更されている（34B は development のみ）');
  if (protectedModified !== false) errors.push('protected HTML が変更されている');
  // production には QA 用の仕組みを出さない
  const prodHtml = (() => { try { return fs.readFileSync(F.prod, 'utf-8'); } catch { return ''; } })();
  if (/__BUILDING_LOD_MODE__|__LOD_VIEW__/.test(prodHtml)) errors.push('§22: production に QA モードが入っている');

  if (!vis) errors.push('§2: high-lod-visual-qa.json が無い（実ブラウザ計測が未実行）');
  if (!after) errors.push('§2: after の計測結果が無い');
  if (!before) warnings.push('§2: before の計測結果が無い（変更前との比較ができない）');

  const RESULT = errors.length ? 'FAIL' : 'PASS';
  const out = {
    version: 1, generatedAt: new Date().toISOString(), missionId: '34B', RESULT,
    classification: errors.length ? 'HIGH_LOD_VISUAL_QUALITY_FAILED' : 'HIGH_LOD_VISUAL_QUALITY_SUCCESS',
    geometryMutation, positionMutation, projectionMutation, zoneVIIProjectionUsed,
    highLodRoofReadable, roofWallVisualSeparation, lodDiffQaAvailable, lodCameraPresetsAvailable,
    productionModified, protectedModified,
    material: { type: materialType, flatShading, pbr, tint, roughnessOk, metalnessOk, tintOk },
    roofWall: roofRatios,
    lighting: { azimuthDeg: sunAz, elevationDeg: sunEl, sunDirOk, fillKept, ambientNotRaised,
      before: before ? before.lighting : null, after: light },
    palette: { paletteIntact, sameUsageColor },
    outline: { noGlobalOutline, noTransparency },
    geometry: { tileBytesMatch, tileUntouched, vertexPathIntact, fingerprintMeshesCompared: fpCompared, fingerprintMeshesChanged: fpChanged,
      sourceFingerprint: srcCheck, tileDir: hs, buildRecordBytes: build ? build.outputBytes : null },
    siteHighLodCounts: siteCounts,
    readability: readable, improvement: improved,
    roofStructure, roofOverhang, landmarkPriority,
    shadow: { followsTarget: /sun\.position\.set\(cs\.tgt\.x \+ SUN_OFFSET\.x/.test(html),
      throttleEveryNFrames: (html.match(/const SHADOW_THROTTLE = \{ every: (\d+), tick: 0 \};/) || [])[1] || null,
      autoUpdateOff: /renderer\.shadowMap\.autoUpdate = false;/.test(html) },
    cameraPreset: after ? after.view : null,
    modesExercised,
    performance: perfPairs,
    precutoverReference: pre ? { generatedAt: pre.generatedAt } : null,
    errors, warnings,
  };
  await writeJson(F.out, out);
  return out;
}

if (isMainModule(import.meta.url)) {
  validateHighLodVisualQuality().then((o) => { console.log(JSON.stringify(o, null, 2)); process.exit(o.RESULT === 'PASS' ? 0 : 1); })
    .catch((e) => { console.error(e); process.exit(1); });
}
