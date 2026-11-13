// Mission 153: CityGML(LOD2) 建物 → 三角形メッシュ → GLB → 3D Tiles(1.1, glb直接参照)
// 専用新規モジュール。既存HTML/変換器/地名・駅には触れない。
// 入力は planBuildingSources() が lod2Draw に選んだ建物のみ。LOD2が無い建物はここでは扱わない(LOD1側が描く)。
// 屋根は元データの面をそのまま三角形化する(AI推定屋根は使わない)。テクスチャは未対応(ソースに有っても色のみ)。
const A = 6378137, F = 1 / 298.257223563, E2 = F * (2 - F);

export function geodeticToEcef(latDeg, lonDeg, h) {
  const la = latDeg * Math.PI / 180, lo = lonDeg * Math.PI / 180;
  const s = Math.sin(la), c = Math.cos(la);
  const N = A / Math.sqrt(1 - E2 * s * s);
  return [(N + h) * c * Math.cos(lo), (N + h) * c * Math.sin(lo), (N * (1 - E2) + h) * s];
}

/** 原点(lat,lon,h)でのENU→ECEF 4x4(列優先, 3D Tiles transform 形式) */
export function enuToEcefMatrix(latDeg, lonDeg, h) {
  const la = latDeg * Math.PI / 180, lo = lonDeg * Math.PI / 180;
  const sl = Math.sin(la), cl = Math.cos(la), so = Math.sin(lo), co = Math.cos(lo);
  const o = geodeticToEcef(latDeg, lonDeg, h);
  return [-so, co, 0, 0, -sl * co, -sl * so, cl, 0, cl * co, cl * so, sl, 0, o[0], o[1], o[2], 1];
}

function toEnu(lat, lon, h, org) {
  const p = geodeticToEcef(lat, lon, h), o = geodeticToEcef(org.lat, org.lon, org.h);
  const d = [p[0] - o[0], p[1] - o[1], p[2] - o[2]];
  const la = org.lat * Math.PI / 180, lo = org.lon * Math.PI / 180;
  const sl = Math.sin(la), cl = Math.cos(la), so = Math.sin(lo), co = Math.cos(lo);
  return [-so * d[0] + co * d[1], -sl * co * d[0] - sl * so * d[1] + cl * d[2], cl * co * d[0] + cl * so * d[1] + sl * d[2]];
}

const SURF = { RoofSurface: 'roof', WallSurface: 'wall', GroundSurface: 'ground', OuterCeilingSurface: 'roof', OuterFloorSurface: 'ground', ClosureSurface: 'wall' };
// Mission 207: LOD2 を LOD1(tools/mission37b-build-3dtiles.cjs の colorFor)と同じ青灰系へ統一。
//  屋根 = colorFor(建物高さ)、壁 = 屋根×0.78(LOD1と同式)。地面面は壁色。形状/CRS/高さ/gml:id は不変。
function lod1Color(h) {
  const t = Math.min(Math.max(h, 0) / 60, 1);
  const roof = [Math.round(190 - 70 * t), Math.round(200 - 50 * t), Math.round(215 - 20 * t)];
  return { roof: roof.map((v) => v / 255), wall: roof.map((v) => Math.round(v * 0.78) / 255) };
}

/** 1棟のXMLから { surfaces:[{type, ring:[[lat,lon,h]...]}] } (lod2の面のみ) */
export function extractLod2Surfaces(bldgXml) {
  const out = [];
  for (const m of String(bldgXml).matchAll(/<bldg:(\w+Surface)\b[^>]*>([\s\S]*?)<\/bldg:\1>/g)) {
    const type = SURF[m[1]]; if (!type) continue;
    if (!/lod2MultiSurface|lod2Solid/.test(m[2])) continue;
    for (const p of m[2].matchAll(/<gml:Polygon\b[\s\S]*?<\/gml:Polygon>/g)) {
      const ext = p[0].match(/<gml:exterior>[\s\S]*?<gml:posList[^>]*>([^<]+)<\/gml:posList>/);
      if (!ext) continue;
      const n = ext[1].trim().split(/\s+/).map(Number);
      if (n.length % 3 || n.some((v) => !Number.isFinite(v))) continue;
      const ring = []; for (let i = 0; i < n.length; i += 3) ring.push([n[i], n[i + 1], n[i + 2]]);
      if (ring.length > 1 && ring[0].every((v, i) => v === ring[ring.length - 1][i])) ring.pop();
      if (ring.length >= 3) out.push({ type, ring });
    }
  }
  return out;
}

/** 3D多角形(ENU)を耳切り三角形化。退化/自己交差は空配列(→呼び出し側でその建物をLOD1へ) */
export function triangulate(pts) {
  const n = pts.length; if (n < 3) return [];
  let nx = 0, ny = 0, nz = 0;
  for (let i = 0; i < n; i++) { const a = pts[i], b = pts[(i + 1) % n]; nx += (a[1] - b[1]) * (a[2] + b[2]); ny += (a[2] - b[2]) * (a[0] + b[0]); nz += (a[0] - b[0]) * (a[1] + b[1]); }
  const len = Math.hypot(nx, ny, nz); if (len < 1e-9) return [];
  const ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
  const drop = ax >= ay && ax >= az ? 0 : ay >= az ? 1 : 2;
  const P = pts.map((p) => drop === 0 ? [p[1], p[2]] : drop === 1 ? [p[2], p[0]] : [p[0], p[1]]);
  const sign = (drop === 0 ? nx : drop === 1 ? ny : nz) >= 0 ? 1 : -1;
  const idx = [...Array(n).keys()], tris = [];
  const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  let guard = n * n;
  while (idx.length > 3 && guard-- > 0) {
    let ear = false;
    for (let k = 0; k < idx.length; k++) {
      const i0 = idx[(k + idx.length - 1) % idx.length], i1 = idx[k], i2 = idx[(k + 1) % idx.length];
      if (cross(P[i0], P[i1], P[i2]) * sign <= 1e-12) continue;
      let inside = false;
      for (const j of idx) {
        if (j === i0 || j === i1 || j === i2) continue;
        if (cross(P[i0], P[i1], P[j]) * sign >= 0 && cross(P[i1], P[i2], P[j]) * sign >= 0 && cross(P[i2], P[i0], P[j]) * sign >= 0) { inside = true; break; }
      }
      if (inside) continue;
      tris.push([i0, i1, i2]); idx.splice(k, 1); ear = true; break;
    }
    if (!ear) return [];
  }
  if (idx.length === 3 && cross(P[idx[0]], P[idx[1]], P[idx[2]]) * sign > 1e-12) tris.push([idx[0], idx[1], idx[2]]);
  return tris;
}

/**
 * 建物群 → メッシュ。triangulation失敗の面を含む建物は failed に入れ(= LOD1へフォールバックすべき)、メッシュに含めない。
 * @param {Map<string,string>} bldgXmlById
 */
export function convexHull(points) {
  const p = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = [];
  for (const q of p) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (const q of [...p].reverse()) { while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}

/**
 * opts.groundToZero: true なら建物ごとに最低点を z=0 に置く(垂直方向のみ。水平は一切動かさない)。
 *   Live City の Cesium は地形なし・楕円体 h=0 の平面基準で道路等を描くため、PLATEAU の標高(ジオイド基準)を
 *   そのまま楕円体高に使うと浮く。元の最低標高は ok[].groundH に残す。
 * 戻り値 footprints: 建物ごとの凸包(lon,lat)。LOD1 側の重複除外(クリップ)に使う。
 */
export function buildLod2Mesh(bldgXmlById, org, opts = {}) {
  const pos = [], col = [], fid = [], ok = [], failed = [], footprints = [];
  let minH = Infinity, maxH = -Infinity, bx = [Infinity, -Infinity], by = [Infinity, -Infinity];
  for (const [id, xml] of bldgXmlById) {
    const surfs = extractLod2Surfaces(xml);
    const bp = [], bc = []; let bad = !surfs.length;
    const gH = surfs.length ? Math.min(...surfs.flatMap((s) => s.ring.map((r) => r[2]))) : 0;
    const dz = opts.groundToZero ? toEnu(org.lat, org.lon, gH, org)[2] : 0;
    const rings = surfs.map((s) => s.ring.map((r) => { const q = toEnu(r[0], r[1], r[2], org); q[2] -= dz; return q; }));
    const hz = rings.flat().map((q) => q[2]);
    const pal = lod1Color(hz.length ? Math.max(...hz) - Math.min(...hz) : 0);
    for (const s of surfs) {
      const e = s.ring.map((r) => { const q = toEnu(r[0], r[1], r[2], org); q[2] -= dz; return q; });
      const tr = triangulate(e);
      if (!tr.length) { bad = true; break; }
      for (const t of tr) for (const i of t) { bp.push(e[i]); bc.push(s.type === 'roof' ? pal.roof : pal.wall); }
    }
    if (bad) { failed.push(id); continue; }
    for (const p of bp) { pos.push(p); minH = Math.min(minH, p[2]); maxH = Math.max(maxH, p[2]); bx = [Math.min(bx[0], p[0]), Math.max(bx[1], p[0])]; by = [Math.min(by[0], p[1]), Math.max(by[1], p[1])]; }
    for (const c of bc) col.push(c);
    for (let q = 0; q < bp.length; q++) fid.push(ok.length); // Mission 208: 頂点→建物(ok の添字)。クリック時の canonicalId(=gml:id) 解決用
    ok.push({ id, triangles: bp.length / 3, groundH: gH });
    footprints.push({ id, hull: convexHull(surfs.flatMap((s) => s.ring.map((r) => [r[1], r[0]]))) });
  }
  return { positions: pos, colors: col, featureIds: fid, ok, failed, footprints, extentEnu: { x: bx, y: by, z: [minH, maxH] } };
}

// Mission 205: 黒表示の原因調査
//  既定の PBR 材質は Cesium の scene.light(=クロックの太陽方向)に依存する。Live City は scene.sun.show=false にするだけで
//  クロックは「現在時刻」のまま(夜の日本時間では太陽が地平線下)なので、PBR+頂点色は夜間に暗転し得る(色値自体は非ゼロ)。
//  → 既定を「固定の昼光を頂点色へ焼き込み + KHR_materials_unlit」に変更。照明・時刻に依存せず、幾何/座標は不変。
//  opts.material: 'unlit-baked'(既定) | 'pbr'(従来。A/B検証用)。夜景は将来 tileset 側のスタイル/ライトで別途扱う。
export const BAKE_SUN = (() => { const el = 55 * Math.PI / 180, az = 150 * Math.PI / 180; // 南東・仰角55°(glTF: x東,y上,z=-北)
  return [Math.cos(el) * Math.sin(az), Math.sin(el), -Math.cos(el) * Math.cos(az)]; })();
const BAKE_AMBIENT = 0.62; // 影側でも roof/wall が判別できる下限

/** ENU(x東,y北,z上) → glTF(Y-up: x東, y上, z=-北) で最小GLB。 */
export function meshToGlb(mesh, opts = {}) {
  const unlit = (opts.material || 'unlit-baked') !== 'pbr';
  const n = mesh.positions.length;
  const P = new Float32Array(n * 3), N = new Float32Array(n * 3), C = new Float32Array(n * 3);
  for (let i = 0; i < n; i += 3) {
    const v = [0, 1, 2].map((k) => { const p = mesh.positions[i + k]; return [p[0], p[2], -p[1]]; });
    const u = [v[1][0] - v[0][0], v[1][1] - v[0][1], v[1][2] - v[0][2]], w = [v[2][0] - v[0][0], v[2][1] - v[0][1], v[2][2] - v[0][2]];
    let nn = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    const l = Math.hypot(...nn) || 1; nn = nn.map((x) => x / l);
    for (let k = 0; k < 3; k++) for (let c = 0; c < 3; c++) { P[(i + k) * 3 + c] = v[k][c]; N[(i + k) * 3 + c] = nn[c]; C[(i + k) * 3 + c] = mesh.colors[i + k][c]; }
    if (unlit && opts.bakeShade) { // 既定は無陰影(LOD1 と同色)。bakeShade:true で従来の固定昼光焼き込み。巻き順が不定でも破綻しないよう |n·L| を使う(二面)
      const d = Math.abs(nn[0] * BAKE_SUN[0] + nn[1] * BAKE_SUN[1] + nn[2] * BAKE_SUN[2]);
      const f = BAKE_AMBIENT + (1 - BAKE_AMBIENT) * d;
      for (let k = 0; k < 3; k++) for (let c = 0; c < 3; c++) C[(i + k) * 3 + c] *= f;
    }
  }
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) { mn[c] = Math.min(mn[c], P[i * 3 + c]); mx[c] = Math.max(mx[c], P[i * 3 + c]); }
  const bl = n * 12;
  const parts = [P, N, C].map((a) => Buffer.from(a.buffer));
  const withIds = Array.isArray(mesh.featureIds) && mesh.featureIds.length === n && Array.isArray(mesh.ok) && mesh.ok.length > 0;
  const bufferViews = [0, 1, 2].map((k) => ({ buffer: 0, byteOffset: k * bl, byteLength: bl, target: 34962 }));
  const accessors = [
    { bufferView: 0, componentType: 5126, count: n, type: 'VEC3', min: mn, max: mx },
    { bufferView: 1, componentType: 5126, count: n, type: 'VEC3' },
    { bufferView: 2, componentType: 5126, count: n, type: 'VEC3' }];
  const attributes = { POSITION: 0, NORMAL: 1, COLOR_0: 2 };
  const prim = { attributes, material: 0, mode: 4 };
  const extUsed = unlit ? ['KHR_materials_unlit'] : [];
  let rootExt = null;
  if (withIds) {
    // Mission 208: EXT_mesh_features(頂点ごと _FEATURE_ID_0) + EXT_structural_metadata(canonicalId=gml:id の文字列表)。
    // 37G のクリック処理は Cesium3DTileFeature.getProperty('canonicalId') を読むため、LOD2 でも同じ経路で建物が特定できる。形状/色/座標は不変。
    const F = new Float32Array(n); for (let i = 0; i < n; i++) F[i] = mesh.featureIds[i];
    const strs = mesh.ok.map((o) => Buffer.from(String(o.id), 'utf8'));
    const offs = new Uint32Array(strs.length + 1); strs.forEach((b, i) => { offs[i + 1] = offs[i] + b.length; });
    const vals = Buffer.concat(strs); const valsPad = Buffer.concat([vals, Buffer.alloc((4 - vals.length % 4) % 4)]);
    const offB = Buffer.from(offs.buffer);
    let at = 3 * bl;
    const add = (buf, target) => { const v = { buffer: 0, byteOffset: at, byteLength: buf.length }; if (target) v.target = target; bufferViews.push(v); parts.push(buf); at += buf.length; return bufferViews.length - 1; };
    const fv = add(Buffer.from(F.buffer), 34962);
    accessors.push({ bufferView: fv, componentType: 5126, count: n, type: 'SCALAR' });
    attributes._FEATURE_ID_0 = 3;
    const vv = add(valsPad); bufferViews[vv].byteLength = vals.length; // 実長(パディングは本体側)
    const ov = add(offB);
    prim.extensions = { EXT_mesh_features: { featureIds: [{ featureCount: mesh.ok.length, attribute: 0, propertyTable: 0 }] } };
    rootExt = { EXT_structural_metadata: {
      schema: { id: 'livecity_lod2', classes: { building: { properties: { canonicalId: { type: 'STRING' } } } } },
      propertyTables: [{ class: 'building', count: mesh.ok.length, properties: { canonicalId: { values: vv, stringOffsets: ov } } }] } };
    extUsed.push('EXT_mesh_features', 'EXT_structural_metadata');
  }
  const bin = Buffer.concat(parts);
  const json = {
    asset: { version: '2.0', generator: 'livecity-mission153' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [prim] }],
    materials: [unlit
      ? { pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 1 }, alphaMode: 'OPAQUE', doubleSided: true, extensions: { KHR_materials_unlit: {} } }
      : { pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 0.9 }, alphaMode: 'OPAQUE', doubleSided: true }],
    ...(extUsed.length ? { extensionsUsed: extUsed } : {}),
    ...(rootExt ? { extensions: rootExt } : {}),
    buffers: [{ byteLength: bin.length }], bufferViews, accessors,
  };
  let js = Buffer.from(JSON.stringify(json)); js = Buffer.concat([js, Buffer.alloc((4 - js.length % 4) % 4, 0x20)]);
  const b = Buffer.concat([bin, Buffer.alloc((4 - bin.length % 4) % 4)]);
  const h = Buffer.alloc(12); h.write('glTF'); h.writeUInt32LE(2, 4); h.writeUInt32LE(12 + 8 + js.length + 8 + b.length, 8);
  const jh = Buffer.alloc(8); jh.writeUInt32LE(js.length, 0); jh.write('JSON', 4);
  const bh = Buffer.alloc(8); bh.writeUInt32LE(b.length, 0); bh.write('BIN\0', 4);
  return Buffer.concat([h, jh, js, bh, b]);
}

/** 単一タイルの tileset.json(3D Tiles 1.1、content=glb)。box は原点ENU系、transform で ECEF へ。 */
export function buildTileset(mesh, org, glbUri = 'lod2.glb') {
  const e = mesh.extentEnu, cx = (e.x[0] + e.x[1]) / 2, cy = (e.y[0] + e.y[1]) / 2, cz = (e.z[0] + e.z[1]) / 2;
  const hx = (e.x[1] - e.x[0]) / 2 + 1, hy = (e.y[1] - e.y[0]) / 2 + 1, hz = (e.z[1] - e.z[0]) / 2 + 1;
  return {
    asset: { version: '1.1', tilesetVersion: 'mission153-poc' },
    geometricError: 500,
    root: {
      transform: enuToEcefMatrix(org.lat, org.lon, org.h),
      boundingVolume: { box: [cx, cy, cz, hx, 0, 0, 0, hy, 0, 0, 0, hz] }, // 3D Tiles は Z-up(ENU)基準のtransform後の箱
      geometricError: 0, refine: 'REPLACE', content: { uri: glbUri },
    },
  };
}
