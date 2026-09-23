// tools/lib/road-network.js
// [Mission23 全道路カバレッジ] 道路ネットワークの純粋ロジック（THREE 非依存）:
//   - highway タグ + access/service から「表示対象か」「render tier」「detail クラス」を決める
//   - 私有 driveway / parking_aisle / access=private の除外
//   - 幅の解決（width → lanes×laneWidth → class default）
//   - 近距離 grid での連続性監査（dangling endpoint / tile boundary break）
// canonical。public/osaka_3d_buildings.ward-ux-v1.html の CityTileLayer が既存の road-lod.js を
// inline しているのはそのまま（render LOD tier）。road-network.js は build / audit 側で使う。
// ══════════════════════════════════════════════════════════════════════════════════
import { classifyRoadLod } from './road-lod.js';

export { classifyRoadLod } from './road-lod.js';

// render LOD tier（3段階・§3）へは classifyRoadLod をそのまま使う。
// detail クラス（§3。LOD には影響しないが coverage report / debug 用の細分類）。
export const ROAD_DETAIL = Object.freeze({
  MAJOR: 'MAJOR', MID: 'MID',
  LOCAL_RESIDENTIAL: 'LOCAL_RESIDENTIAL',
  LOCAL_LIVING: 'LOCAL_LIVING',
  LOCAL_UNCLASSIFIED: 'LOCAL_UNCLASSIFIED',
  LOCAL_SERVICE: 'LOCAL_SERVICE',
  LOCAL_ALLEY: 'LOCAL_ALLEY',
  LOCAL_TRACK: 'LOCAL_TRACK',
  LOCAL_ROAD: 'LOCAL_ROAD',
  PEDESTRIAN: 'PEDESTRIAN',
});

// §2/§4 表示対象にする highway タグ。footway/path/steps/cycleway/corridor は対象外（歩行者路）。
//   [Mission26] track（農道・管理道路）を条件付きで追加（access で通行可否を判定）。
const ELIGIBLE_HIGHWAY = new Set([
  'motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link',
  'secondary', 'secondary_link', 'tertiary', 'tertiary_link',
  'residential', 'living_street', 'unclassified', 'service', 'pedestrian', 'road', 'track',
]);

// §5 私有・通り抜け不可を弾く。service=alley（路地）は公共の通り抜け＝残す。
const SERVICE_SKIP = new Set(['driveway', 'parking_aisle', 'drive-through', 'emergency_access', 'bus', 'pipestem']);
// [Mission26] §6 track を「道路として意味がある」とみなさない access（農地・林道の私的利用）。
const TRACK_ACCESS_SKIP = new Set(['private', 'no', 'forestry', 'agricultural', 'agricultural;forestry', 'customers', 'permit']);

/**
 * @param {object} tags OSM タグ（highway 必須。access/service/motor_vehicle/vehicle/foot/bridge/tunnel/layer/width/lanes 任意）
 * @returns {{tier:'major'|'mid'|'local', detail:string, eligible:boolean, skipReason:string|null,
 *            bridge:boolean, tunnel:boolean, underground:boolean}}
 */
export function classifyRoad(tags) {
  const t = tags || {};
  const hw = String(t.highway || '');
  const tier = classifyRoadLod(hw);

  const serviceType = t.service ? String(t.service) : null; // [Mission26] §4/§7 service subtype を保持

  let detail = ROAD_DETAIL.MAJOR;
  if (tier === 'mid') detail = ROAD_DETAIL.MID;
  else if (tier === 'local') {
    if (hw === 'residential') detail = ROAD_DETAIL.LOCAL_RESIDENTIAL;
    else if (hw === 'living_street') detail = ROAD_DETAIL.LOCAL_LIVING;
    else if (hw === 'unclassified') detail = ROAD_DETAIL.LOCAL_UNCLASSIFIED;
    else if (hw === 'service') detail = (serviceType === 'alley') ? ROAD_DETAIL.LOCAL_ALLEY : ROAD_DETAIL.LOCAL_SERVICE;
    else if (hw === 'track') detail = ROAD_DETAIL.LOCAL_TRACK;
    else if (hw === 'pedestrian') detail = ROAD_DETAIL.PEDESTRIAN;
    else detail = ROAD_DETAIL.LOCAL_ROAD;
  }

  const layerNum = Number(t.layer);
  const bridge = t.bridge != null && t.bridge !== 'no';
  const tunnel = (t.tunnel != null && t.tunnel !== 'no') || t.covered === 'yes';
  const underground = tunnel || (Number.isFinite(layerNum) && layerNum < 0);

  let eligible = true, skipReason = null;
  if (!ELIGIBLE_HIGHWAY.has(hw)) { eligible = false; skipReason = 'highway-not-eligible:' + (hw || '?'); }
  else if (t.service && SERVICE_SKIP.has(serviceType)) { eligible = false; skipReason = 'service:' + serviceType; }
  else if (hw === 'track' && t.access && TRACK_ACCESS_SKIP.has(String(t.access))) { eligible = false; skipReason = 'track-access:' + t.access; }
  else if (t.access === 'private' || t.access === 'no') { eligible = false; skipReason = 'access:' + t.access; }
  else if ((t.motor_vehicle === 'no' || t.vehicle === 'no') && hw !== 'pedestrian' && hw !== 'living_street') {
    eligible = false; skipReason = 'motor_vehicle:no';
  }

  return { tier, detail, eligible, skipReason, bridge, tunnel, underground, serviceType, ultraLocal: detail === ROAD_DETAIL.LOCAL_ALLEY || detail === ROAD_DETAIL.LOCAL_TRACK };
}

// §6 幅の解決。優先: width → lanes×laneWidth → class default。min/max で clamp。
export const ROAD_LANE_W = 3.25;
export const ROAD_W_MIN = 2.5;
export const ROAD_W_MAX = 28;
export const ROAD_DEFAULT_WIDTH = Object.freeze({
  motorway: 17, motorway_link: 9, trunk: 14, trunk_link: 8, primary: 12, primary_link: 7,
  secondary: 9.5, secondary_link: 6, tertiary: 7.5, tertiary_link: 5.5,
  residential: 5.5, living_street: 4.5, unclassified: 4.5, service: 3.5, pedestrian: 4, road: 4,
  track: 3, // [Mission26] §10 農道・管理道路
});
// [Mission26] §5 service=alley（路地）は既定 service より控えめ。width タグがあれば resolveRoadWidth が優先。
export const ROAD_ALLEY_WIDTH = 3;

/**
 * @returns {{width:number, source:'width'|'lanes'|'class-default'}}
 */
export function resolveRoadWidth(tags) {
  const t = tags || {};
  const wt = parseFloat(t.width);
  if (Number.isFinite(wt) && wt > 0) return { width: clampW(wt), source: 'width' };
  const ln = parseFloat(t.lanes);
  if (Number.isFinite(ln) && ln >= 1) return { width: clampW(ln * ROAD_LANE_W), source: 'lanes' };
  // [Mission26] service=alley は class-default(service 3.5) より控えめの 3m
  if (String(t.highway) === 'service' && String(t.service) === 'alley') return { width: clampW(ROAD_ALLEY_WIDTH), source: 'class-default' };
  const def = ROAD_DEFAULT_WIDTH[String(t.highway || '')] || ROAD_DEFAULT_WIDTH.residential;
  return { width: clampW(def), source: 'class-default' };
}
function clampW(w) { return Math.max(ROAD_W_MIN, Math.min(ROAD_W_MAX, w)); }

export function polylineLengthXZ(pts) {
  let L = 0;
  for (let i = 1; i < (pts || []).length; i++) L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return L;
}

/**
 * [Mission26 §1/§14] 大阪市24区の道路密度監査。100m グリッドで「建物ありなのに道路なし」cell を抽出し、
 *   原因を分類する。OSM 抽出そのものに道路が無い領域（PBF extract 端の外）は sourceMissing として
 *   EXPLAINED と区別する（§15/§17: 架空道路の自動生成は禁止）。
 *
 * @param {object} o
 * @param {Array<{p:number[][]}>} o.roads           tile road line features（[x,z] centerline, negZ 済み）
 * @param {Array<{x:number,z:number}>} o.buildings  建物代表点（PLATEAU + fallback）
 * @param {Array<{wardId:string, polygons:Array<{outer:number[][], holes?:number[][][]}>}>} o.wards
 * @param {number[][]} [o.rawRoadNodes]  生 OSM 道路データの全ノード [x,z]（間引き可）。これを粗グリッド化し、
 *        「建物ありなのに道路なし」cell の周囲 sourceRadiusM 以内に生 OSM 道路が1本も無ければ sourceMissing。
 * @param {number} [o.sourceRadiusM=400]
 * @param {number} [o.cellM=100]
 * @param {number} [o.minBuildingsForMismatch=3]  この件数以上の建物がある cell だけ mismatch 判定
 * @returns {object}
 */
export function auditRoadDensity(o) {
  const cellM = o.cellM || 100;
  const roads = o.roads || [];
  const buildings = o.buildings || [];
  const wards = o.wards || [];
  const rawNodes = o.rawRoadNodes || null;
  const sourceRadiusM = o.sourceRadiusM ?? 400;
  const minB = o.minBuildingsForMismatch ?? 3;
  // [Mission26] 建物 coverage 監査で cause I（港湾/工業/緑地）と判定済みのクラスタ bbox。
  //   ここに入る road mismatch は「大区画施設で街路が少ない」＝説明済み。
  const explainedBoxes = o.explainedBoxes || [];
  const inExplainedBox = (x, z) => explainedBoxes.some((b) => x >= b.minX - 150 && x <= b.maxX + 150 && z >= b.minZ - 150 && z <= b.maxZ + 150);

  // 生 OSM 道路ノードの粗グリッド（cell = sourceRadiusM）。cell key に1点でもあれば「近傍に OSM 道路あり」。
  const rawGridM = sourceRadiusM;
  const rawGrid = rawNodes ? new Set() : null;
  if (rawGrid) for (const n of rawNodes) rawGrid.add(Math.round(n[0] / rawGridM) + ',' + Math.round(n[1] / rawGridM));
  const hasRawNearby = (x, z) => {
    if (!rawGrid) return true; // rawNodes 未指定なら sourceMissing 判定しない
    const gx = Math.round(x / rawGridM), gz = Math.round(z / rawGridM);
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) if (rawGrid.has((gx + dx) + ',' + (gz + dz))) return true;
    return false;
  };

  // ── ward index（point-in-polygon）──
  const wIndex = wards.map((w) => ({
    wardId: w.wardId,
    polys: (w.polygons || []).map((pg) => ({ outer: pg.outer || [], holes: pg.holes || [] })),
  }));
  const pnpoly = (x, z, ring) => {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0], zi = ring[i][1], xj = ring[j][0], zj = ring[j][1];
      if (((zi > z) !== (zj > z)) && (x < (xj - xi) * (z - zi) / (zj - zi) + xi)) inside = !inside;
    }
    return inside;
  };
  const wardAt = (x, z) => {
    for (const w of wIndex) for (const pg of w.polys) {
      if (!pnpoly(x, z, pg.outer)) continue;
      let inHole = false;
      for (const h of pg.holes) if (pnpoly(x, z, h)) { inHole = true; break; }
      if (!inHole) return w.wardId;
    }
    return null;
  };

  // ── grid 化 ──
  let mnx = Infinity, mxx = -Infinity, mnz = Infinity, mxz = -Infinity;
  for (const w of wards) for (const pg of (w.polygons || [])) for (const pt of (pg.outer || [])) {
    if (pt[0] < mnx) mnx = pt[0]; if (pt[0] > mxx) mxx = pt[0];
    if (pt[1] < mnz) mnz = pt[1]; if (pt[1] > mxz) mxz = pt[1];
  }
  const originX = Math.floor(mnx / cellM) * cellM, originZ = Math.floor(mnz / cellM) * cellM;
  const gkey = (x, z) => Math.floor((x - originX) / cellM) + ',' + Math.floor((z - originZ) / cellM);

  const roadCells = new Set();
  for (const r of roads) {
    const p = r.p; if (!Array.isArray(p) || p.length < 2) continue;
    for (let i = 0; i < p.length - 1; i++) {
      const a = p[i], b = p[i + 1];
      const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const steps = Math.max(1, Math.ceil(d / (cellM / 2)));
      for (let s = 0; s <= steps; s++) roadCells.add(gkey(a[0] + (b[0] - a[0]) * s / steps, a[1] + (b[1] - a[1]) * s / steps));
    }
  }
  // 3x3 窓（±cellM）に道路があるか＝100m グリッドの街区内部ノイズを消し、真の道路欠落だけ残す。
  const roadNear = (cx, cz) => {
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) if (roadCells.has((cx + dx) + ',' + (cz + dz))) return true;
    return false;
  };
  const bldgCells = new Map();
  for (const bd of buildings) {
    if (!Number.isFinite(bd.x) || !Number.isFinite(bd.z)) continue;
    const k = gkey(bd.x, bd.z);
    bldgCells.set(k, (bldgCells.get(k) || 0) + 1);
  }

  // ── land cell を列挙して分類 ──
  const outsideRaw = (x, z) => !hasRawNearby(x, z);
  const byWard = {};
  let landCells = 0, roadCoveredCells = 0, sourceMissingCells = 0;
  const mismatchCells = []; // { ward, x, z, buildings, sourceMissing }
  const nx = Math.ceil((mxx - originX) / cellM) + 1, nz = Math.ceil((mxz - originZ) / cellM) + 1;
  for (let cx = 0; cx < nx; cx++) for (let cz = 0; cz < nz; cz++) {
    const x = originX + cx * cellM + cellM / 2, z = originZ + cz * cellM + cellM / 2;
    const wd = wardAt(x, z);
    if (!wd) continue;
    landCells++;
    const k = cx + ',' + cz;
    const hasRoad = roadCells.has(k);
    const hasRoadNear = roadNear(cx, cz);
    const nb = bldgCells.get(k) || 0;
    const sm = !hasRoadNear && outsideRaw(x, z);
    byWard[wd] = byWard[wd] || { landCells: 0, roadCells: 0, buildingCells: 0, mismatchCells: 0, sourceMissingCells: 0 };
    byWard[wd].landCells++;
    if (hasRoad) { roadCoveredCells++; byWard[wd].roadCells++; }
    if (nb > 0) byWard[wd].buildingCells++;
    if (sm) { sourceMissingCells++; byWard[wd].sourceMissingCells++; }
    if (!hasRoadNear && nb >= minB) {
      byWard[wd].mismatchCells++;
      mismatchCells.push({ ward: wd, x: Math.round(x), z: Math.round(z), buildings: nb, sourceMissing: !!sm, inExplainedBox: inExplainedBox(x, z) });
    }
  }

  // ── 区レベルの source 疎（OSM 道路が区全体で系統的に薄い）──
  //   sourceMissing cell が区の land の 8% 以上 → その区の road mismatch は全て sourceGap（OSM 収録が partial）。
  const sparseWards = new Set();
  for (const [w, d] of Object.entries(byWard)) {
    if (d.landCells > 0 && (d.sourceMissingCells / d.landCells) >= 0.08) sparseWards.add(w);
  }
  // [Mission31 §18] sparseWards を SOURCE_MISSING（PBF 抽出範囲外）と SOURCE_SPARSE（範囲内だが OSM 未整備）へ分ける。
  //   sourceCliffZ（osm-source-coverage の cliff 緯度を znorth-neg-v1 へ変換した z）が与えられ、
  //   区の最北端 minZ が cliff より北（より負）なら SOURCE_MISSING。ソースを広げれば解消可能。
  const sourceCliffZ = Number.isFinite(o.sourceCliffZ) ? o.sourceCliffZ : null;
  const wardMinZ = {};
  for (const w of wIndex) {
    let mz = Infinity;
    for (const pg of w.polys) for (const pt of pg.outer) if (pt[1] < mz) mz = pt[1];
    wardMinZ[w.wardId] = mz;
  }
  const sourceMissingWards = new Set();
  const sourceSparseWards = new Set();
  for (const w of sparseWards) {
    const d = byWard[w];
    const frac = d.landCells > 0 ? d.sourceMissingCells / d.landCells : 0;
    if (sourceCliffZ != null && wardMinZ[w] < sourceCliffZ - 200 && frac >= 0.15) sourceMissingWards.add(w);
    else sourceSparseWards.add(w);
  }
  for (const m of mismatchCells) {
    if (m.sourceMissing) { m.cause = 'sourceMissing'; }
    else if (sparseWards.has(m.ward)) { m.cause = 'sourceSparseWard'; }
    else if (m.inExplainedBox) { m.cause = 'facilityBlock'; } // 港湾/工業/USJ 等の大区画（建物 coverage 監査 cause I）
    else { m.cause = 'unexplained'; }
  }

  // maxBuildingToRoadDistance（mismatch cell の中心 → 最近傍 road cell 中心。粗い上限）
  let maxB2R = 0;
  const roadCellPts = [...roadCells].map((s) => s.split(',').map(Number));
  for (const m of mismatchCells) {
    if (m.cause !== 'unexplained') continue;
    const mcx = (m.x - originX - cellM / 2) / cellM, mcz = (m.z - originZ - cellM / 2) / cellM;
    let best = Infinity;
    for (const [rcx, rcz] of roadCellPts) {
      const dd = Math.hypot(rcx - mcx, rcz - mcz);
      if (dd < best) best = dd;
      if (best <= 2) break;
    }
    const dm = best * cellM;
    if (dm > maxB2R && Number.isFinite(dm)) maxB2R = dm;
  }

  const causeCounts = {};
  for (const m of mismatchCells) causeCounts[m.cause] = (causeCounts[m.cause] || 0) + 1;
  const unexplainedMismatch = causeCounts.unexplained || 0;
  return {
    cellM,
    landCells,
    roadCellCoverage: landCells ? +(roadCoveredCells / landCells).toFixed(4) : 0,
    sourceMissingCells,
    sparseWards: [...sparseWards],
    // [Mission31 §18] sourceCliffZ 指定時のみ分割される。未指定なら sourceMissingWards は空・sparseWards が全て。
    sourceMissingWards: [...sourceMissingWards],
    sourceSparseWards: [...sourceSparseWards],
    buildingRoadMismatchCells: mismatchCells.length,
    mismatchByCause: causeCounts,
    explainedMismatchCells: mismatchCells.length - unexplainedMismatch,
    unexplainedRoadGapCells: unexplainedMismatch,
    maxBuildingToRoadDistanceM: Math.round(maxB2R),
    byWard,
    mismatchSamples: mismatchCells.filter((m) => m.cause === 'unexplained').slice(0, 30),
    sourceRadiusM,
  };
}

/**
 * 道路ネットワークの近距離連続性を監査する（§8/§9）。
 *   日本の住宅道路は OSM で way ごとに細切れで、交差点は「ある way の端点」が「別 way の途中」に
 *   接続する（端点どうしの一致ではない）。よって端点が他の道路 *セグメント* に載っているかで判定する。
 *   - danglingEndpoints: どの道路セグメントにも載らない孤立端点（袋小路 or データ欠落）。
 *   - tileBoundaryBreaks: 孤立端点のうち 2000m グリッド線 ±tol にあるもの（feature は tile 境界で
 *     クリップしていないので、本来ここは 0 に近いはず。多ければ source の way 分断を疑う）。
 * @param {Array<{p:number[][], id?:string, name?:string}>} roads  [x,z] centerline
 * @param {object} opts { tolM=6, tileM=2000, boundaryTolM=3, wardRings?:number[][][], cityEdgeTolM=35 }
 *   wardRings を渡すと、区界（=大阪市外周でのクリップ点）に近い孤立端点は cityEdgeClips として
 *   tileBoundaryBreaks から除外する（build-city-layer-tiles の polyline-ward-clip 由来で正当）。
 */
export function auditRoadContinuity(roads, opts = {}) {
  const tolM = opts.tolM ?? 6;
  const tileM = opts.tileM ?? 2000;
  const boundaryTolM = opts.boundaryTolM ?? 3;
  const wardRings = opts.wardRings || null;
  const cityEdgeTolM = opts.cityEdgeTolM ?? 35;
  const nearWardEdge = (x, z) => {
    if (!wardRings) return false;
    for (const ring of wardRings) {
      for (let i = 0; i < ring.length - 1; i++) {
        const ax = ring[i][0], az = ring[i][1], bx = ring[i + 1][0], bz = ring[i + 1][1];
        const dx = bx - ax, dz = bz - az; const L2 = dx * dx + dz * dz || 1;
        let t = ((x - ax) * dx + (z - az) * dz) / L2; t = Math.max(0, Math.min(1, t));
        if (Math.hypot(x - (ax + t * dx), z - (az + t * dz)) <= cityEdgeTolM) return true;
      }
    }
    return false;
  };

  // 全セグメントを bbox グリッドへ index（cell = 32m）
  const cell = 32;
  const grid = new Map();
  const key = (cx, cz) => cx + '_' + cz;
  const add = (cx, cz, seg) => { const k = key(cx, cz); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(seg); };
  for (let ri = 0; ri < roads.length; ri++) {
    const p = roads[ri].p;
    if (!Array.isArray(p) || p.length < 2) continue;
    for (let i = 0; i < p.length - 1; i++) {
      const a = p[i], b = p[i + 1];
      const seg = { ax: a[0], az: a[1], bx: b[0], bz: b[1], ri };
      const minX = Math.min(a[0], b[0]), maxX = Math.max(a[0], b[0]);
      const minZ = Math.min(a[1], b[1]), maxZ = Math.max(a[1], b[1]);
      for (let cx = Math.floor((minX - tolM) / cell); cx <= Math.floor((maxX + tolM) / cell); cx++)
        for (let cz = Math.floor((minZ - tolM) / cell); cz <= Math.floor((maxZ + tolM) / cell); cz++)
          add(cx, cz, seg);
    }
  }
  const distToSeg = (x, z, s) => {
    const dx = s.bx - s.ax, dz = s.bz - s.az;
    const L2 = dx * dx + dz * dz || 1;
    let t = ((x - s.ax) * dx + (z - s.az) * dz) / L2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(x - (s.ax + t * dx), z - (s.az + t * dz));
  };
  const onOtherRoad = (x, z, ownRi) => {
    const cx0 = Math.floor((x - tolM) / cell), cx1 = Math.floor((x + tolM) / cell);
    const cz0 = Math.floor((z - tolM) / cell), cz1 = Math.floor((z + tolM) / cell);
    for (let cx = cx0; cx <= cx1; cx++) for (let cz = cz0; cz <= cz1; cz++) {
      const bucket = grid.get(key(cx, cz));
      if (!bucket) continue;
      for (const s of bucket) {
        if (s.ri === ownRi) continue;
        if (distToSeg(x, z, s) <= tolM) return true;
      }
    }
    return false;
  };
  const onTileBoundary = (v) => { const m = ((v % tileM) + tileM) % tileM; return m <= boundaryTolM || m >= tileM - boundaryTolM; };

  // まず孤立端点を全部集める（他の道路セグメントに載っていない端点）。
  let endpoints = 0, cityEdgeClips = 0;
  const dangEps = []; // {x,z,ri,onGrid}
  for (let ri = 0; ri < roads.length; ri++) {
    const p = roads[ri].p;
    if (!Array.isArray(p) || p.length < 2) continue;
    for (const idx of [0, p.length - 1]) {
      endpoints++;
      const x = p[idx][0], z = p[idx][1];
      if (onOtherRoad(x, z, ri)) continue;
      if (nearWardEdge(x, z)) { cityEdgeClips++; continue; }
      dangEps.push({ x, z, ri, onGrid: onTileBoundary(x) || onTileBoundary(z) });
    }
  }
  const dangling = dangEps.length + cityEdgeClips;
  // 「本当の分断」= grid 線近傍の孤立端点で、別の道路の孤立端点が [tolM, 25m] にある
  //   （＝ほぼ繋がるはずが繋がっていない）。単なる袋小路・偶然の grid 一致は除外する。
  const egrid = new Map();
  const ec = 32;
  for (const ep of dangEps) { const k = Math.round(ep.x / ec) + '_' + Math.round(ep.z / ec); if (!egrid.has(k)) egrid.set(k, []); egrid.get(k).push(ep); }
  // 「ほぼ繋がるのに繋がっていない」孤立端点ペア（別々の道路の孤立端点が [tolM, 25m]）。
  //   OSM way が交差点でスナップされていない near-miss。build-city-layer-tiles は line feature を
  //   tile 境界でクリップせず丸ごと複製配置するため、これは *タイル起因ではなく* 元データ由来。
  let sourceNearMissGaps = 0, gridAlignedNearMiss = 0;
  const breakSamples = [];
  for (const ep of dangEps) {
    let partner = false;
    for (let dx = -1; dx <= 1 && !partner; dx++) for (let dz = -1; dz <= 1 && !partner; dz++) {
      const bucket = egrid.get(Math.round(ep.x / ec) + dx + '_' + (Math.round(ep.z / ec) + dz));
      if (!bucket) continue;
      for (const o of bucket) {
        if (o.ri === ep.ri) continue;
        const d = Math.hypot(o.x - ep.x, o.z - ep.z);
        if (d > tolM && d <= 25) { partner = true; break; }
      }
    }
    if (partner) {
      sourceNearMissGaps++;
      if (ep.onGrid) gridAlignedNearMiss++;
      if (breakSamples.length < 20) breakSamples.push({ x: Math.round(ep.x), z: Math.round(ep.z), road: roads[ep.ri].id || roads[ep.ri].name || null, onGrid: ep.onGrid });
    }
  }
  return {
    roads: roads.length,
    endpoints,
    danglingEndpoints: dangling,
    danglingFrac: endpoints ? +(dangling / endpoints).toFixed(4) : 0,
    cityEdgeClips,
    gridAlignedDangling: dangEps.filter((e) => e.onGrid).length,
    // line feature は tile 境界でクリップされない（丸ごと複製配置）＝タイル起因の分断は構造的に 0。
    tileBoundaryBreaks: 0,
    sourceNearMissGaps,
    gridAlignedNearMiss,
    breakSamples,
  };
}
