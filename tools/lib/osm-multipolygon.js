// tools/lib/osm-multipolygon.js
// OSMのmultipolygon relation（natural=water / waterway=riverbank 等）の member way を、
// 端点一致で連結して閉じたリングを組み立てる。
//
// 【なぜ必要か】Overpassの `out geom;` はrelationのmember wayを個別のgeometry配列として返す。
// 大きな河岸ポリゴンは複数のouter wayに分割されており、これを単純に1本ずつ閉ポリゴンとして
// 三角形分割すると、way終端とway始端を結ぶ「地物を横断する巨大な辺」が生成され、川面を
// 横切る不自然な三角形になる（tools/fetch-water.js の既知不具合）。
//
// 【方針】
//  - outer/inner を role で分け、それぞれ端点一致で連結する（OSM仕様準拠）。
//  - way は逆順（reversed）でも連結する。
//  - 連結しても閉じないリング片は「未連結フラグメント」として返し、呼び出し側が黙って
//    三角形分割せずに検出・報告できるようにする。
//  - inner ring（中州・島）は保持し、outer ring との内包関係を判定して割り当てる。
//
// 座標は [lon, lat] の配列で扱う（GeoJSON準拠）。連結・内外判定のみ行い、投影変換はしない。

const DEFAULT_EPS = 1e-7; // 約1cm。OSMの共有ノードは通常完全一致するが、浮動小数ノイズを吸収する。

function toCoordPairs(geometry) {
  // Overpass形式 [{lat,lon},...] とプレーン [[lon,lat],...] の両方を受け付ける。
  if (!Array.isArray(geometry)) return [];
  return geometry
    .map((pt) => {
      if (Array.isArray(pt)) return [Number(pt[0]), Number(pt[1])];
      if (pt && typeof pt === 'object') return [Number(pt.lon), Number(pt.lat)];
      return null;
    })
    .filter((p) => p && Number.isFinite(p[0]) && Number.isFinite(p[1]));
}

function samePoint(a, b, eps) {
  return Math.abs(a[0] - b[0]) <= eps && Math.abs(a[1] - b[1]) <= eps;
}

function isClosed(chain, eps) {
  return chain.length >= 4 && samePoint(chain[0], chain[chain.length - 1], eps);
}

/**
 * way（点列）の配列を端点一致で連結し、閉じたリング群と未連結フラグメントに分ける。
 * [P1-6F] way に id を付けて渡すと、各リング/未連結フラグメントを構成した member way id を返す
 *   （ringWayIds / unclosedWayIds）。id 省略時は入力インデックス。
 * @param {number[][][] | {points:number[][], id:(string|number)}[]} ways
 * @param {number} eps 端点一致の許容誤差
 * @returns {{rings:number[][][], unclosed:number[][][], ringWayIds:(string|number)[][], unclosedWayIds:(string|number)[][]}}
 */
export function stitchWays(ways, eps = DEFAULT_EPS) {
  const norm = (ways || []).map((w, i) => (
    Array.isArray(w) ? { points: w, id: i } : { points: w.points || [], id: w.id != null ? w.id : i }
  ));

  const rings = [];
  const ringWayIds = [];
  /** @type {{points:number[][], ids:Set}[]} */
  const open = [];

  for (const way of norm) {
    let chain = { points: way.points.slice(), ids: new Set([way.id]) };
    if (chain.points.length < 2) { open.push(chain); continue; }

    let merged = true;
    while (merged && !isClosed(chain.points, eps)) {
      merged = false;
      for (let i = 0; i < open.length; i++) {
        const oc = open[i];
        if (oc.points.length < 2) continue;
        const cp = chain.points, op = oc.points;
        const cs = cp[0], ce = cp[cp.length - 1];
        const os = op[0], oe = op[op.length - 1];

        if (samePoint(ce, os, eps)) chain.points = cp.concat(op.slice(1));
        else if (samePoint(ce, oe, eps)) chain.points = cp.concat(op.slice(0, -1).reverse());
        else if (samePoint(cs, oe, eps)) chain.points = op.slice(0, -1).concat(cp);
        else if (samePoint(cs, os, eps)) chain.points = op.slice().reverse().slice(0, -1).concat(cp);
        else continue;

        for (const id of oc.ids) chain.ids.add(id);
        open.splice(i, 1);
        merged = true;
        break;
      }
    }

    if (isClosed(chain.points, eps)) { rings.push(chain.points); ringWayIds.push([...chain.ids]); }
    else open.push(chain);
  }

  const unclosed = [];
  const unclosedWayIds = [];
  for (const chain of open) {
    if (isClosed(chain.points, eps)) { rings.push(chain.points); ringWayIds.push([...chain.ids]); }
    else { unclosed.push(chain.points); unclosedWayIds.push([...chain.ids]); }
  }

  return { rings, unclosed, ringWayIds, unclosedWayIds };
}

function ringArea2(ring) {
  // 符号付き面積の2倍（[lon,lat]空間。相対比較・内外判定用途のみ）。
  let a = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  return a;
}

function pointInRing(pt, ring) {
  let inside = false;
  const [x, y] = pt;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    const intersect = ((yi > y) !== (yj > y)) && (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

/**
 * OSM relation の members からmultipolygonを組み立てる。
 * @param {Array<{role?:string, geometry?:any}>} members Overpass relation.members 相当
 * @param {{eps?:number, treatEmptyRoleAsOuter?:boolean}} [options]
 * @returns {{
 *   polygons: Array<{outer:number[][], holes:number[][][]}>,
 *   outerRings:number[][][], innerRings:number[][][],
 *   unclosed: Array<{role:string, points:number, first:number[], last:number[]}>,
 *   stats:{outerWays:number, innerWays:number, outerRings:number, innerRings:number, unclosed:number, holesAssigned:number, holesOrphan:number}
 * }}
 */
export function assembleMultipolygon(members, options = {}) {
  const eps = options.eps ?? DEFAULT_EPS;
  const treatEmptyRoleAsOuter = options.treatEmptyRoleAsOuter !== false;

  const outerWays = [];
  const innerWays = [];
  let idx = 0;
  for (const m of members || []) {
    if (!m || m.type === 'node') continue;
    const pts = toCoordPairs(m.geometry);
    if (!pts.length) continue;
    const id = m.ref != null ? m.ref : (m.id != null ? m.id : `idx${idx++}`);
    const rec = { points: pts, id };
    const role = (m.role || '').trim();
    if (role === 'inner') innerWays.push(rec);
    else outerWays.push(rec); // outer / 空role / 未知role はすべて outer 扱い（黙って捨てない）
  }

  const outer = stitchWays(outerWays, eps);
  const inner = stitchWays(innerWays, eps);

  const unclosed = [
    ...outer.unclosed.map((c, i) => frag('outer', c, outer.unclosedWayIds[i])),
    ...inner.unclosed.map((c, i) => frag('inner', c, inner.unclosedWayIds[i])),
  ];

  // outer ring を面積降順に並べ（way id 対応も保つ）、各 inner ring を内包する最小の outer へ割り当てる。
  const outerSorted = outer.rings
    .map((ring, i) => ({ ring, area: Math.abs(ringArea2(ring)), wayIds: outer.ringWayIds[i] || [] }))
    .sort((a, b) => b.area - a.area);

  const polygons = outerSorted.map((o) => ({ outer: o.ring, holes: [], memberWayIds: o.wayIds.slice() }));
  let holesAssigned = 0;
  let holesOrphan = 0;
  const orphanInnerWayIds = [];
  inner.rings.forEach((hole, hi) => {
    // inner representative point（重心が hole 内に無い凹リングもあるため頂点も併用）
    const probe = ringRepPoint(hole);
    let target = null;
    let targetArea = Infinity;
    for (const poly of polygons) {
      if (pointInRing(probe, poly.outer) || pointInRing(hole[0], poly.outer)) {
        const a = Math.abs(ringArea2(poly.outer));
        if (a < targetArea) { target = poly; targetArea = a; }
      }
    }
    if (target) {
      target.holes.push(hole);
      target.memberWayIds.push(...(inner.ringWayIds[hi] || []));
      holesAssigned++;
    } else { holesOrphan++; orphanInnerWayIds.push(...(inner.ringWayIds[hi] || [])); }
  });

  return {
    polygons,
    outerRings: outer.rings,
    innerRings: inner.rings,
    ringWayIds: outer.ringWayIds,
    innerRingWayIds: inner.ringWayIds,
    orphanInnerWayIds,
    unclosed,
    stats: {
      outerWays: outerWays.length,
      innerWays: innerWays.length,
      outerRings: outer.rings.length,
      innerRings: inner.rings.length,
      unclosed: unclosed.length,
      holesAssigned,
      holesOrphan,
    },
  };
}

/** リングの内部にある確率が高い代表点（重心。凹で外れる場合は最初の辺の中点を少し内側へ）。 */
function ringRepPoint(ring) {
  let x = 0, y = 0;
  for (const p of ring) { x += p[0]; y += p[1]; }
  const c = [x / ring.length, y / ring.length];
  if (pointInRing(c, ring)) return c;
  // fallback: スキャンラインで内点を1つ探す
  const ys = ring.map((p) => p[1]).sort((a, b) => a - b);
  const midY = ys[Math.floor(ys.length / 2)] + (ys[Math.floor(ys.length / 2) + 1] || ys[Math.floor(ys.length / 2)]) * 0 + 1e-6;
  const xs = [];
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const yi = ring[i][1], yj = ring[j][1];
    if ((yi > midY) !== (yj > midY)) {
      xs.push(ring[j][0] + ((midY - yj) / (yi - yj)) * (ring[i][0] - ring[j][0]));
    }
  }
  xs.sort((a, b) => a - b);
  if (xs.length >= 2) return [(xs[0] + xs[1]) / 2, midY];
  return c;
}

function frag(role, chain, wayIds) {
  return {
    role,
    points: chain.length,
    first: chain[0] || null,
    last: chain[chain.length - 1] || null,
    wayIds: wayIds || [],
  };
}
