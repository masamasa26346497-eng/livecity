// tools/lib/building-coverage.js
// [Mission21B 全建物カバレッジ] 建物 coverage 監査の純粋ロジック（THREE 非依存）。
//   N03 24区の陸域 grid で「道路はあるが建物が無い（park/water/rail で説明できない）」cell を
//   suspectedBuildingGap とし、連続クラスタ化して原因分類する。
// ══════════════════════════════════════════════════════════════════════════════════
import { flattenWardPolygons, pointInRing } from './water-surface.js';

export { flattenWardPolygons, pointInRing } from './water-surface.js';

/** wards（N03）へ bbox を前計算。 */
export function indexWards(wardsRaw) {
  const flat = Array.isArray(wardsRaw) && wardsRaw[0] && wardsRaw[0].outer ? wardsRaw : flattenWardPolygons(wardsRaw);
  return flat.map((w) => {
    let a = Infinity, b = -Infinity, c = Infinity, d = -Infinity;
    for (const [x, z] of w.outer) { if (x < a) a = x; if (x > b) b = x; if (z < c) c = z; if (z > d) d = z; }
    return { ...w, _bb: { minX: a, maxX: b, minZ: c, maxZ: d } };
  });
}

/** 点が入る ward（穴考慮）。null=どの区にも入らない。 */
export function wardAt(x, z, idxWards) {
  for (const w of idxWards) {
    const b = w._bb;
    if (x < b.minX || x > b.maxX || z < b.minZ || z > b.maxZ) continue;
    if (!pointInRing(x, z, w.outer)) continue;
    let hole = false;
    for (const h of (w.holes || [])) if (pointInRing(x, z, h)) { hole = true; break; }
    if (!hole) return w.wardId;
  }
  return null;
}

function segLen(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1]); }

/** ポリライン群を cell(cellM) の格子へ「触れた長さ」で集計。roads / rails 用。 */
export function rasterizePolylineLength(features, cellM, origin) {
  const grid = new Map();
  const key = (cx, cz) => cx + ',' + cz;
  for (const f of features) {
    const p = f.p || f;
    if (!Array.isArray(p) || p.length < 2) continue;
    for (let i = 1; i < p.length; i++) {
      const a = p[i - 1], b = p[i];
      const L = segLen(a, b);
      const steps = Math.max(1, Math.ceil(L / (cellM / 2)));
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const x = a[0] + (b[0] - a[0]) * t, z = a[1] + (b[1] - a[1]) * t;
        const cx = Math.floor((x - origin.x) / cellM), cz = Math.floor((z - origin.z) / cellM);
        grid.set(key(cx, cz), (grid.get(key(cx, cz)) || 0) + L / steps);
      }
    }
  }
  return grid;
}

/** 面フィーチャ（outer ring 群）を cell の格子へ「頂点 bbox がかかる cell」で近似集計。parks/water 用。 */
export function rasterizePolygonCells(rings, cellM, origin) {
  const set = new Set();
  const key = (cx, cz) => cx + ',' + cz;
  for (const ring of rings) {
    if (!Array.isArray(ring) || ring.length < 3) continue;
    let a = Infinity, b = -Infinity, c = Infinity, d = -Infinity;
    for (const [x, z] of ring) { if (x < a) a = x; if (x > b) b = x; if (z < c) c = z; if (z > d) d = z; }
    for (let cx = Math.floor((a - origin.x) / cellM); cx <= Math.floor((b - origin.x) / cellM); cx++)
      for (let cz = Math.floor((c - origin.z) / cellM); cz <= Math.floor((d - origin.z) / cellM); cz++) {
        // cell 中心がリング内なら確定でマーク
        const mx = origin.x + (cx + 0.5) * cellM, mz = origin.z + (cz + 0.5) * cellM;
        if (pointInRing(mx, mz, ring)) set.add(key(cx, cz));
      }
  }
  return set;
}

/** 三角形 positions（[x,z,...]）を cell 格子へマーク。water-surface / land-surface 用。 */
export function rasterizeTriangleCells(positions, cellM, origin) {
  const set = new Set();
  const key = (cx, cz) => cx + ',' + cz;
  for (let i = 0; i + 6 <= positions.length; i += 6) {
    const xs = [positions[i], positions[i + 2], positions[i + 4]];
    const zs = [positions[i + 1], positions[i + 3], positions[i + 5]];
    const a = Math.min(...xs), b = Math.max(...xs), c = Math.min(...zs), d = Math.max(...zs);
    for (let cx = Math.floor((a - origin.x) / cellM); cx <= Math.floor((b - origin.x) / cellM); cx++)
      for (let cz = Math.floor((c - origin.z) / cellM); cz <= Math.floor((d - origin.z) / cellM); cz++)
        set.add(key(cx, cz));
  }
  return set;
}

/**
 * 建物 coverage grid 監査。
 * @param {object} o {
 *   wards, cellM=100,
 *   buildings: [{x,z,fpArea}]  (24区分類済み・rendered 対象),
 *   roads: [{p:[[x,z]...]}], rails: [{p}], parkRings: [[[x,z]...]], waterCells?: Set (key "cx,cz"),
 *   riverPositions?: number[]  (rivers.json の left/right ではなく representative。ここでは centerline 群を roads 同様に渡す)
 * }
 * @returns {{ cellM, origin, bbox, totalLandCells, cellsWithBuildings, cellsWithRoadsNoBuildings,
 *            suspectedGapCells, byWard, gapCells:[{cx,cz,x,z,ward,roadLen,buildingCount,parkFrac,railFrac,waterFrac}] }}
 */
export function auditBuildingCoverage(o) {
  const cellM = o.cellM || 100;
  const idxW = indexWards(o.wards);
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const w of idxW) { minX = Math.min(minX, w._bb.minX); maxX = Math.max(maxX, w._bb.maxX); minZ = Math.min(minZ, w._bb.minZ); maxZ = Math.max(maxZ, w._bb.maxZ); }
  const origin = { x: Math.floor(minX / cellM) * cellM, z: Math.floor(minZ / cellM) * cellM };
  const key = (cx, cz) => cx + ',' + cz;

  const roadGrid = rasterizePolylineLength(o.roads || [], cellM, origin);
  const railGrid = rasterizePolylineLength(o.rails || [], cellM, origin);
  const riverGrid = rasterizePolylineLength(o.rivers || [], cellM, origin);
  const parkCells = rasterizePolygonCells(o.parkRings || [], cellM, origin);
  const waterCells = o.waterCells || new Set();

  // 建物を cell へ。rep 点だけでなく footprint 頂点 bbox がかかる cell も「建物あり」にマークする
  //   （工業地帯の大型 footprint は 1 cell に rep 点、でも複数 cell を覆う。gap の過検出を防ぐ）。
  const bldgGrid = new Map(); // key -> {count, area}
  const bump = (k, cnt, area) => { const e = bldgGrid.get(k) || { count: 0, area: 0 }; e.count += cnt; e.area += area; bldgGrid.set(k, e); };
  for (const b of (o.buildings || [])) {
    if (b.x == null || b.z == null) continue;
    const cx = Math.floor((b.x - origin.x) / cellM), cz = Math.floor((b.z - origin.z) / cellM);
    bump(key(cx, cz), 1, b.fpArea || 0);
    // footprint bbox（あれば）で覆う cell もマーク（count は増やさず「建物あり」判定に使う）
    if (Array.isArray(b.fp) && b.fp.length >= 3) {
      let a = Infinity, bb2 = -Infinity, c = Infinity, d = -Infinity;
      for (const [x, z] of b.fp) { if (x < a) a = x; if (x > bb2) bb2 = x; if (z < c) c = z; if (z > d) d = z; }
      for (let ccx = Math.floor((a - origin.x) / cellM); ccx <= Math.floor((bb2 - origin.x) / cellM); ccx++)
        for (let ccz = Math.floor((c - origin.z) / cellM); ccz <= Math.floor((d - origin.z) / cellM); ccz++) {
          const kk = key(ccx, ccz);
          if (kk === key(cx, cz)) continue;
          bump(kk, 0, 0); // 存在マークだけ（count 0）
        }
    }
  }

  const cols = Math.ceil((maxX - origin.x) / cellM), rows = Math.ceil((maxZ - origin.z) / cellM);
  const byWard = {};
  let totalLandCells = 0, cellsWithBuildings = 0, cellsWithRoadsNoBuildings = 0, suspectedGapCells = 0;
  const gapCells = [];
  for (let cz = 0; cz < rows; cz++) {
    for (let cx = 0; cx < cols; cx++) {
      const x = origin.x + (cx + 0.5) * cellM, z = origin.z + (cz + 0.5) * cellM;
      const ward = wardAt(x, z, idxW);
      if (!ward) continue;
      totalLandCells++;
      byWard[ward] = byWard[ward] || { landCells: 0, buildingCells: 0, buildings: 0, footprintArea: 0, gapCells: 0 };
      byWard[ward].landCells++;
      const k = key(cx, cz);
      const b = bldgGrid.get(k);
      const roadLen = roadGrid.get(k) || 0;
      const railLen = railGrid.get(k) || 0;
      const riverLen = riverGrid.get(k) || 0;
      const inPark = parkCells.has(k);
      const inWater = waterCells.has(k);
      if (b) { // rep 点 or footprint bbox がこの cell を覆う
        cellsWithBuildings++;
        byWard[ward].buildingCells++;
        byWard[ward].buildings += b.count;
        byWard[ward].footprintArea += b.area;
        continue;
      }
      // 建物ゼロ（rep 点も footprint bbox も無い）
      if (roadLen > 30) {
        cellsWithRoadsNoBuildings++;
        // park / water / rail / river で説明できるか
        const explained = inPark || inWater || railLen > 40 || riverLen > 40;
        if (!explained) {
          suspectedGapCells++;
          byWard[ward].gapCells++;
          gapCells.push({ cx, cz, x: +x.toFixed(0), z: +z.toFixed(0), ward, roadLen: +roadLen.toFixed(0), railLen: +railLen.toFixed(0), riverLen: +riverLen.toFixed(0), inPark, inWater });
        }
      }
    }
  }
  for (const k of Object.keys(byWard)) {
    byWard[k].footprintArea = Math.round(byWard[k].footprintArea);
    byWard[k].coverageRatio = byWard[k].landCells ? +(byWard[k].buildingCells / byWard[k].landCells).toFixed(3) : 0;
  }
  return {
    cellM, origin, bbox: { minX, maxX, minZ, maxZ }, cols, rows,
    totalLandCells, cellsWithBuildings, cellsWithRoadsNoBuildings, suspectedGapCells,
    byWard, gapCells,
  };
}

/**
 * suspectedGap cell を 8近傍で連結クラスタ化。
 * @returns {Array<{id, ward, bbox, center, cells, areaKm2, roadLengthKm, likelyCause, unexplained}>}
 */
export function clusterGapCells(gapCells, cellM, opts = {}) {
  const minCells = opts.minCells || 3;
  const set = new Map();
  for (const g of gapCells) set.set(g.cx + ',' + g.cz, g);
  const seen = new Set();
  const clusters = [];
  for (const g of gapCells) {
    const start = g.cx + ',' + g.cz;
    if (seen.has(start)) continue;
    const stack = [start]; const cells = [];
    seen.add(start);
    while (stack.length) {
      const cur = stack.pop();
      const cg = set.get(cur);
      cells.push(cg);
      const [cx, cz] = cur.split(',').map(Number);
      for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
        if (!dx && !dz) continue;
        const nk = (cx + dx) + ',' + (cz + dz);
        if (set.has(nk) && !seen.has(nk)) { seen.add(nk); stack.push(nk); }
      }
    }
    if (cells.length < minCells) continue;
    let a = Infinity, b = -Infinity, c = Infinity, d = -Infinity, roadKm = 0;
    const wardCount = {};
    for (const cc of cells) {
      if (cc.x < a) a = cc.x; if (cc.x > b) b = cc.x; if (cc.z < c) c = cc.z; if (cc.z > d) d = cc.z;
      roadKm += cc.roadLen / 1000;
      wardCount[cc.ward] = (wardCount[cc.ward] || 0) + 1;
    }
    const ward = Object.entries(wardCount).sort((x, y) => y[1] - x[1])[0][0];
    const areaKm2 = +(cells.length * cellM * cellM / 1e6).toFixed(3);
    clusters.push({
      id: 'bgap-' + clusters.length, ward,
      bbox: { minX: a, maxX: b, minZ: c, maxZ: d },
      center: [Math.round((a + b) / 2), Math.round((c + d) / 2)],
      cells: cells.length, areaKm2, roadLengthKm: +roadKm.toFixed(2),
      likelyCause: null, unexplained: true,
    });
  }
  clusters.sort((x, y) => y.cells - x.cells);
  return clusters;
}
