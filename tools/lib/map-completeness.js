// tools/lib/map-completeness.js
// [Mission24] 大阪市24区 基礎地図 7 レイヤー（LAND / BUILDINGS / ROADS / RIVERS / SEA / PARKS / RAILWAYS）
//   の総合完成度監査ロジック（THREE 非依存）。新地物は増やさず、「source 上あるべきものが render
//   されているか」を 100m グリッドで横断評価する。
// ══════════════════════════════════════════════════════════════════════════════════
import { indexWards, wardAt, rasterizePolylineLength, rasterizePolygonCells, rasterizeTriangleCells } from './building-coverage.js';

export { indexWards, wardAt } from './building-coverage.js';

export const BASE_LAYERS = Object.freeze(['land', 'buildings', 'roads', 'rivers', 'sea', 'parks', 'railways']);
export const SEVERITY = Object.freeze(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO']);

/**
 * 7 レイヤー横断の 100m グリッド監査。
 * @param {object} o {
 *   wards, cellM=100,
 *   plateauBuildings:[{x,z,fpArea}], fallbackBuildings:[{x,z,fpArea}],
 *   roads:[{p}], rivers:[{p}], rails:[{p}], parkRings:[[x,z]...][],
 *   seaPositions:number[] (water-surface positions),
 *   osmBuildingGrid?: {counts:{'cx,cz':n}}  (100m・in-city OSM 建物数。cause C 検証用),
 * }
 */
export function auditMapCompleteness(o) {
  const cellM = o.cellM || 100;
  const idxW = indexWards(o.wards);
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const w of idxW) { minX = Math.min(minX, w._bb.minX); maxX = Math.max(maxX, w._bb.maxX); minZ = Math.min(minZ, w._bb.minZ); maxZ = Math.max(maxZ, w._bb.maxZ); }
  const origin = { x: Math.floor(minX / cellM) * cellM, z: Math.floor(minZ / cellM) * cellM };
  const key = (cx, cz) => cx + ',' + cz;

  const roadG = rasterizePolylineLength(o.roads || [], cellM, origin);
  const riverG = rasterizePolylineLength(o.rivers || [], cellM, origin);
  const railG = rasterizePolylineLength(o.rails || [], cellM, origin);
  const parkC = rasterizePolygonCells(o.parkRings || [], cellM, origin);
  // [Mission24] 河川リボン（幅を持つ帯）・地表水面を面として cell へ。centerline だけだと広い河川敷を
  //   「陸だが何も無い」と誤検出する。
  const riverRibbonC = rasterizePolygonCells(o.riverRibbons || [], cellM, origin);
  const railYardC = rasterizePolygonCells(o.railYardRings || [], cellM, origin);
  const seaTriC = (Array.isArray(o.seaPositions) && o.seaPositions.length) ? rasterizeTriangleCells(o.seaPositions, cellM, origin) : new Set();
  // sea を 1 cell バッファ（岸のゼロ幅 cell を coastal 扱い）
  const seaC = new Set(seaTriC);
  const coastalC = new Set();
  for (const k of seaTriC) { const [cx, cz] = k.split(',').map(Number); for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) coastalC.add((cx + dx) + ',' + (cz + dz)); }

  const bG = new Map(); // key -> { plat, fb, area }
  for (const b of (o.plateauBuildings || [])) {
    if (b.x == null || b.z == null) continue;
    const k = key(Math.floor((b.x - origin.x) / cellM), Math.floor((b.z - origin.z) / cellM));
    const e = bG.get(k) || { plat: 0, fb: 0, area: 0 }; e.plat++; e.area += b.fpArea || 0; bG.set(k, e);
  }
  for (const b of (o.fallbackBuildings || [])) {
    if (b.x == null || b.z == null) continue;
    const k = key(Math.floor((b.x - origin.x) / cellM), Math.floor((b.z - origin.z) / cellM));
    const e = bG.get(k) || { plat: 0, fb: 0, area: 0 }; e.fb++; e.area += b.fpArea || 0; bG.set(k, e);
  }

  const osmC = (o.osmBuildingGrid && o.osmBuildingGrid.counts) || null;

  const cols = Math.ceil((maxX - origin.x) / cellM), rows = Math.ceil((maxZ - origin.z) / cellM);
  const byWard = {};
  for (const w of idxW) byWard[w.wardId] = mkWardStat();
  let landCells = 0;
  const anomalyCells = { A: [], B: [], C: [], F: [] }; // 個別 cell アノマリ候補（クラスタ化は audit tool 側）

  for (let cz = 0; cz < rows; cz++) {
    for (let cx = 0; cx < cols; cx++) {
      const x = origin.x + (cx + 0.5) * cellM, z = origin.z + (cz + 0.5) * cellM;
      const ward = wardAt(x, z, idxW);
      if (!ward) continue;
      landCells++;
      const W = byWard[ward];
      W.land++;
      const k = key(cx, cz);
      const b = bG.get(k) || { plat: 0, fb: 0, area: 0 };
      const road = roadG.get(k) || 0;
      const river = riverG.get(k) || 0;
      const rail = railG.get(k) || 0;
      const inPark = parkC.has(k);
      const inSea = seaC.has(k);
      const inRiverRibbon = riverRibbonC.has(k);
      const inRailYard = railYardC.has(k);
      const inCoastal = coastalC.has(k);
      const bCount = b.plat + b.fb;
      const osmN = osmC ? (osmC[Math.floor(x / cellM) + ',' + Math.floor(z / cellM)] || 0) : 0;
      // 「何もあるべきでない cell」= 河川敷 / 港湾水際 / 鉄道ヤード / 公園 / 海際
      const openSpace = inPark || inRiverRibbon || inRailYard || inCoastal || river > 20 || rail > 20;

      if (bCount > 0) { W.buildingCells++; W.buildings += bCount; W.buildingFbCells += (b.fb > 0 && b.plat === 0) ? 1 : 0; }
      if (road > 30) W.roadCells++;
      if (river > 20) W.riverCells++;
      if (rail > 20) W.railCells++;
      if (inPark) W.parkCells++;
      if (inSea) W.seaOnLand++; // 陸 cell 中心が sea 三角形内 = 不正

      // ── anomaly cell 候補 ──
      // A: 陸・建物0・道路0 かつ open space（河川敷/ヤード/公園/海際/鉄道）でない = 説明不能な完全空白
      if (bCount === 0 && road <= 30 && !openSpace && !inSea) {
        anomalyCells.A.push({ cx, cz, x: Math.round(x), z: Math.round(z), ward, osm: osmN });
        W.emptyCells++;
      }
      // B: 建物が密（>=10）だが道路長ほぼ0（道路網欠落）。open space は除外。
      if (bCount >= 10 && road <= 3 && !openSpace) anomalyCells.B.push({ cx, cz, x: Math.round(x), z: Math.round(z), ward, buildings: bCount, osm: osmN });
      // C: 道路網あり + OSM 建物密（>=6）だが render 建物 sparse（<=1）= Mission21C 残余
      if (road > 40 && osmN >= 6 && bCount <= 1) anomalyCells.C.push({ cx, cz, x: Math.round(x), z: Math.round(z), ward, osm: osmN, rendered: bCount });
      // F: land ∩ sea 不正 overlap（岸バッファは除外、三角形内部のみ）
      if (seaTriC.has(k)) anomalyCells.F.push({ cx, cz, x: Math.round(x), z: Math.round(z), ward });
    }
  }

  // ── ward score ──
  for (const [wid, W] of Object.entries(byWard)) {
    W.buildingCoverage = W.land ? +(W.buildingCells / W.land).toFixed(3) : 0;
    W.roadCoverage = W.land ? +(W.roadCells / W.land).toFixed(3) : 0;
  }

  return {
    cellM, origin, bbox: { minX, maxX, minZ, maxZ }, cols, rows,
    landCells, byWard, anomalyCells,
    grids: { roadG, riverG, railG, parkC, seaC, bG },
  };
}

function mkWardStat() {
  return {
    land: 0, buildingCells: 0, buildings: 0, buildingFbCells: 0,
    roadCells: 0, riverCells: 0, railCells: 0, parkCells: 0,
    seaOnLand: 0, emptyCells: 0,
  };
}

/** 8近傍でセルをクラスタ化。 */
export function clusterCells(cells, cellM, minCells = 1) {
  const set = new Map();
  for (const c of cells) set.set(c.cx + ',' + c.cz, c);
  const seen = new Set();
  const out = [];
  for (const c of cells) {
    const start = c.cx + ',' + c.cz;
    if (seen.has(start)) continue;
    const stack = [start]; const members = [];
    seen.add(start);
    while (stack.length) {
      const cur = stack.pop();
      members.push(set.get(cur));
      const [cx, cz] = cur.split(',').map(Number);
      for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
        if (!dx && !dz) continue;
        const nk = (cx + dx) + ',' + (cz + dz);
        if (set.has(nk) && !seen.has(nk)) { seen.add(nk); stack.push(nk); }
      }
    }
    if (members.length < minCells) continue;
    let a = Infinity, b = -Infinity, cc = Infinity, d = -Infinity;
    const wc = {};
    for (const m of members) {
      if (m.x < a) a = m.x; if (m.x > b) b = m.x; if (m.z < cc) cc = m.z; if (m.z > d) d = m.z;
      wc[m.ward] = (wc[m.ward] || 0) + 1;
    }
    out.push({
      cells: members.length,
      cellKeys: members.map((m) => m.cx + ',' + m.cz),
      ward: Object.entries(wc).sort((x, y) => y[1] - x[1])[0][0],
      bbox: { minX: a, maxX: b, minZ: cc, maxZ: d },
      center: [Math.round((a + b) / 2), Math.round((cc + d) / 2)],
      areaKm2: +(members.length * cellM * cellM / 1e6).toFixed(3),
    });
  }
  return out.sort((x, y) => y.cells - x.cells);
}

/**
 * anomaly を severity へ分類する（§4）。
 * @param {object} a { type:'A'|'B'|'C'|'D'|'E'|'F'|'G'|'H', areaKm2, ward, detail, explained }
 */
export function classifyAnomalySeverity(a) {
  const t = a.type;
  if (a.explained) return a.areaKm2 >= 0.3 ? 'LOW' : 'INFO';
  if (t === 'A') {
    if (a.areaKm2 >= 1.0) return 'CRITICAL';
    if (a.areaKm2 >= 0.3) return 'HIGH';
    if (a.areaKm2 >= 0.08) return 'MEDIUM';
    return 'LOW';
  }
  if (t === 'F') return a.cells >= 20 ? 'CRITICAL' : (a.cells >= 5 ? 'HIGH' : (a.cells >= 2 ? 'MEDIUM' : 'LOW'));
  if (t === 'C') return a.cells >= 30 ? 'HIGH' : (a.cells >= 8 ? 'MEDIUM' : 'LOW');
  if (t === 'B') return a.areaKm2 >= 0.3 ? 'HIGH' : (a.areaKm2 >= 0.08 ? 'MEDIUM' : 'LOW');
  if (t === 'D' || t === 'E') return a.major ? 'CRITICAL' : (a.areaKm2 >= 0.3 ? 'HIGH' : 'MEDIUM');
  if (t === 'G') return 'MEDIUM';
  if (t === 'H') return a.wardWide ? 'CRITICAL' : 'HIGH';
  return 'LOW';
}

/** レイヤー score（0..100）。0 anomaly + coverage 妥当なら 100。 */
export function layerScore(coverageRatio, criticalCount, highCount, mediumCount) {
  let s = 100;
  s -= criticalCount * 100;
  s -= highCount * 25;
  s -= mediumCount * 5;
  // coverage は「あるべき render 率」。land/road は高いほど良い。building は湾岸で下がるのが正当なので緩め。
  if (coverageRatio != null && coverageRatio < 0.5) s -= (0.5 - coverageRatio) * 20;
  return Math.max(0, Math.min(100, Math.round(s)));
}
