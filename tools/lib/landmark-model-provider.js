// tools/lib/landmark-model-provider.js
// [見た目改善 Mission11B] LandmarkModelProvider — レジストリの modelType/proceduralShape から
//   ランドマーク 3D モデルの仕様と（procedural の場合は）ジオメトリを供給する canonical モジュール。
// ══════════════════════════════════════════════════════════════════════════════════
//   Landmark Registry
//       ↓  modelPlanFor(id) → {modelType, proceduralShape, modelUrl}
//   LandmarkModelProvider（このファイル）
//       ↓  getModelSpec(entry) → {available, kind:'procedural'|'gltf'|'lod', shape, params, estimate}
//       ↓  buildGeometry(spec) → {positions, indices, triangleCount, bbox}   ※ procedural のみ
//   HTML LandmarkLayer
//       ↓  modelType 別 loader（procedural=即生成 / gltf=将来 lazy load）
//   実世界座標で表示（anchor(x,z) + y は z0..height。スケール倍率なし）
//
// THREE 非依存（Node でテスト可能）。座標は「ランドマーク中心を XZ 原点」「y は地面 0 から上」。
//   HTML 側で anchor へ平行移動する。footprint bbox（m）と検証済み高さ（m）だけを使い、
//   見栄え目的の拡大はしない（指示書 8 節）。
// ══════════════════════════════════════════════════════════════════════════════════

export const PROCEDURAL_SHAPES = Object.freeze(['tower', 'dome', 'twin-tower-ring']);
export const MODEL_KINDS = Object.freeze(['procedural', 'gltf', 'lod']);

// ── 低レベル: 平坦配列へプリミティブを積む ────────────────────────────────────────
function pushQuad(pos, idx, a, b, c, d) {
  // a,b,c,d = [x,y,z]（反時計回りで法線が外向き）
  const base = pos.length / 3;
  pos.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2], d[0], d[1], d[2]);
  idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
}
/** 矩形フラスタム（下 w0×d0 → 上 w1×d1、y0→y1）の 4 側面 + 上面キャップ。 */
function pushRectFrustum(pos, idx, y0, y1, w0, d0, w1, d1, cx = 0, cz = 0, cap = true) {
  const hx0 = w0 / 2, hz0 = d0 / 2, hx1 = w1 / 2, hz1 = d1 / 2;
  const b = [
    [cx - hx0, y0, cz - hz0], [cx + hx0, y0, cz - hz0], [cx + hx0, y0, cz + hz0], [cx - hx0, y0, cz + hz0],
  ];
  const t = [
    [cx - hx1, y1, cz - hz1], [cx + hx1, y1, cz - hz1], [cx + hx1, y1, cz + hz1], [cx - hx1, y1, cz + hz1],
  ];
  pushQuad(pos, idx, b[0], b[1], t[1], t[0]); // -z 面
  pushQuad(pos, idx, b[1], b[2], t[2], t[1]); // +x 面
  pushQuad(pos, idx, b[2], b[3], t[3], t[2]); // +z 面
  pushQuad(pos, idx, b[3], b[0], t[0], t[3]); // -x 面
  if (cap) pushQuad(pos, idx, t[0], t[1], t[2], t[3]); // 上面
}
/** 円筒側面（y0→y1、半径 r0→r1）。segments 分割。上面キャップ任意。 */
function pushCylinder(pos, idx, y0, y1, r0, r1, segments, cap = false) {
  for (let i = 0; i < segments; i++) {
    const a0 = (i / segments) * Math.PI * 2, a1 = ((i + 1) / segments) * Math.PI * 2;
    const p0b = [Math.cos(a0) * r0, y0, Math.sin(a0) * r0];
    const p1b = [Math.cos(a1) * r0, y0, Math.sin(a1) * r0];
    const p1t = [Math.cos(a1) * r1, y1, Math.sin(a1) * r1];
    const p0t = [Math.cos(a0) * r1, y1, Math.sin(a0) * r1];
    pushQuad(pos, idx, p0b, p1b, p1t, p0t);
  }
  if (cap) {
    const base = pos.length / 3;
    pos.push(0, y1, 0);
    for (let i = 0; i < segments; i++) pos.push(Math.cos((i / segments) * Math.PI * 2) * r1, y1, Math.sin((i / segments) * Math.PI * 2) * r1);
    for (let i = 0; i < segments; i++) idx.push(base, base + 1 + i, base + 1 + ((i + 1) % segments));
  }
}

// ── 形状生成器（純粋。THREE 非依存）────────────────────────────────────────────────

/** 通天閣型: 基部の箱 → 段階的に細くなる塔 → 展望台の張り出し → 細い尖塔。 */
export function generateTower({ baseW, baseD, height }) {
  const pos = [], idx = [];
  const H = height;
  const w = Math.max(6, baseW), d = Math.max(6, baseD);
  pushRectFrustum(pos, idx, 0, H * 0.22, w, d, w * 0.92, d * 0.92);           // 基部
  pushRectFrustum(pos, idx, H * 0.22, H * 0.60, w * 0.60, d * 0.60, w * 0.42, d * 0.42); // 下部塔
  pushRectFrustum(pos, idx, H * 0.60, H * 0.78, w * 0.42, d * 0.42, w * 0.30, d * 0.30); // 中部塔
  pushRectFrustum(pos, idx, H * 0.78, H * 0.86, w * 0.46, d * 0.46, w * 0.44, d * 0.44); // 展望台（張り出し）
  pushRectFrustum(pos, idx, H * 0.86, H * 0.95, w * 0.30, d * 0.30, w * 0.12, d * 0.12); // 上部
  pushRectFrustum(pos, idx, H * 0.95, H, w * 0.06, d * 0.06, w * 0.03, d * 0.03);         // 尖塔
  return finalize(pos, idx);
}

/** 京セラドーム型: 低い円筒の胴 + 半楕円ドーム。 */
export function generateDome({ radius, apex, ringHeight, segments = 20, rings = 6 }) {
  const pos = [], idx = [];
  const R = Math.max(20, radius);
  const rh = Math.min(ringHeight, apex * 0.5);
  pushCylinder(pos, idx, 0, rh, R, R, segments, false); // 外周の胴
  // 半楕円ドーム（rh → apex、水平半径 R → 0）
  const domeH = apex - rh;
  for (let r = 0; r < rings; r++) {
    const t0 = r / rings, t1 = (r + 1) / rings;
    const y0 = rh + Math.sin(t0 * Math.PI / 2) * domeH;
    const y1 = rh + Math.sin(t1 * Math.PI / 2) * domeH;
    const rad0 = Math.cos(t0 * Math.PI / 2) * R;
    const rad1 = Math.cos(t1 * Math.PI / 2) * R;
    pushCylinder(pos, idx, y0, y1, rad0, rad1, segments, r === rings - 1);
  }
  return finalize(pos, idx);
}

/** 梅田スカイビル型: 2 枚のスラブ + 頂部の連結リング。 */
export function generateTwinTowerRing({ totalW, depth, height, gap = 20, segments = 20 }) {
  const pos = [], idx = [];
  const H = height;
  const g = Math.min(gap, totalW * 0.4);
  const towerW = (Math.max(30, totalW) - g) / 2;
  const D = Math.max(20, depth);
  const towerTop = H * 0.965;
  const cxW = -(g / 2 + towerW / 2), cxE = (g / 2 + towerW / 2);
  pushRectFrustum(pos, idx, 0, towerTop, towerW, D, towerW, D, cxW, 0);
  pushRectFrustum(pos, idx, 0, towerTop, towerW, D, towerW, D, cxE, 0);
  // 空中庭園リング（gap をまたぐ短い円環。外周 + 内周 + 上面の帯）。footprint 内に収める。
  const ringOuter = Math.min(D * 0.5, D / 2 - 0.5), ringInner = D * 0.30;
  const yb = H * 0.90, yt = H;
  pushCylinder(pos, idx, yb, yt, ringOuter, ringOuter, segments, false);
  pushCylinder(pos, idx, yb, yt, ringInner, ringInner, segments, false);
  for (let i = 0; i < segments; i++) {
    const a0 = (i / segments) * Math.PI * 2, a1 = ((i + 1) / segments) * Math.PI * 2;
    pushQuad(pos, idx,
      [Math.cos(a0) * ringInner, yt, Math.sin(a0) * ringInner],
      [Math.cos(a1) * ringInner, yt, Math.sin(a1) * ringInner],
      [Math.cos(a1) * ringOuter, yt, Math.sin(a1) * ringOuter],
      [Math.cos(a0) * ringOuter, yt, Math.sin(a0) * ringOuter]);
  }
  return finalize(pos, idx);
}

function finalize(positions, indices) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  return {
    positions, indices, triangleCount: indices.length / 3,
    bbox: { minX, maxX, minY, maxY, minZ, maxZ, w: maxX - minX, d: maxZ - minZ, h: maxY - minY },
  };
}

const GENERATORS = { tower: generateTower, dome: generateDome, 'twin-tower-ring': generateTwinTowerRing };

/** shape 名から生成パラメータを footprintBbox + height で組む（純粋）。 */
export function shapeParams(shape, footprintBbox, height) {
  if (!footprintBbox || !Number.isFinite(height) || height <= 0) return null;
  const w = footprintBbox.w, d = footprintBbox.h;
  if (!Number.isFinite(w) || !Number.isFinite(d) || w <= 0 || d <= 0) return null;
  if (shape === 'tower') return { baseW: w, baseD: d, height };
  if (shape === 'dome') return { radius: (w + d) / 4, apex: height, ringHeight: Math.min(height * 0.38, 32) };
  if (shape === 'twin-tower-ring') return { totalW: w, depth: d, height, gap: Math.max(14, w * 0.16) };
  return null;
}

/**
 * レジストリ 1 エントリのモデル仕様。geometry はここでは作らない（buildGeometry で）。
 * @param {object} entry landmarks.json の 1 landmark（{modelType, proceduralShape, footprintBbox, osmHeight, modelUrl, resolved, ...}）
 * @returns {{available:true, kind, shape?, params?, url?, estimate}|{available:false, reason}}
 */
export function getModelSpec(entry) {
  const mt = entry.modelType;
  if (mt === 'GLTF') {
    if (!entry.modelUrl) return { available: false, reason: 'GLTF 指定だが modelUrl が無い' };
    return { available: true, kind: 'gltf', url: entry.modelUrl, estimate: { triangles: null, bytes: null, note: 'GLTF は外部ファイル。loader 未実装' } };
  }
  if (mt === 'LOD1') return { available: false, reason: '既存 LOD1 building で表示（専用モデル不要）' };
  if (mt === 'LOD2' || mt === 'LOD3') return { available: false, reason: `${mt} データ未取得（PLATEAU から別途）` };
  if (mt === 'PROCEDURAL') {
    const shape = entry.proceduralShape;
    if (!shape) return { available: false, reason: 'proceduralShape 未定義（特徴形状の生成器なし）' };
    if (!PROCEDURAL_SHAPES.includes(shape) || !GENERATORS[shape]) return { available: false, reason: `未知の proceduralShape: ${shape}` };
    const params = shapeParams(shape, entry.footprintBbox, entry.osmHeight);
    if (!params) return { available: false, reason: 'footprintBbox または height が不足' };
    const geo = GENERATORS[shape](params);
    return {
      available: true, kind: 'procedural', shape, params,
      estimate: {
        triangles: geo.triangleCount,
        bytes: geo.positions.length * 4 + geo.indices.length * 2, // Float32 pos + Uint16 idx（概算）
        textures: 0,
        bboxH: +geo.bbox.h.toFixed(1),
      },
    };
  }
  return { available: false, reason: `未知の modelType: ${mt}` };
}

/**
 * procedural モデルのジオメトリを生成する（HTML から呼ぶ。THREE 非依存の平坦配列を返す）。
 * @returns {{positions:number[], indices:number[], triangleCount:number, bbox:object}|null}
 */
export function buildGeometry(spec) {
  if (!spec || !spec.available || spec.kind !== 'procedural') return null;
  const gen = GENERATORS[spec.shape];
  if (!gen) return null;
  return gen(spec.params);
}

/** landmarks.json 全体からモデル計画のサマリ（validator / debug 用）。 */
export function summarizeModels(landmarks) {
  const rows = landmarks.map((l) => {
    const spec = getModelSpec(l);
    return {
      id: l.id, modelType: l.modelType, shape: l.proceduralShape || null,
      available: spec.available, reason: spec.available ? null : spec.reason,
      triangles: spec.available && spec.estimate ? spec.estimate.triangles : 0,
      kind: spec.available ? spec.kind : null,
    };
  });
  return {
    total: rows.length,
    available: rows.filter((r) => r.available).length,
    proceduralAvailable: rows.filter((r) => r.available && r.kind === 'procedural').length,
    totalTriangles: rows.reduce((n, r) => n + r.triangles, 0),
    rows,
  };
}
