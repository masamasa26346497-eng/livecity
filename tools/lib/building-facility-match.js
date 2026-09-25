// tools/lib/building-facility-match.js
// [Mission 35O] 建物と「実在する名称」を突き合わせる純関数群。
//
//   §0 の大原則: **名称は推測しない**。
//   ここにあるのは「重なっているか」「中に入っているか」を測る関数だけで、
//   住所・近さ・同じ町丁目といった間接的な根拠から名前を作る処理は置かない。

/** 表示名。name:ja を優先し、無ければ name。どちらも無ければ null。 */
export function osmName(t) {
  if (!t) return null;
  const n = String(t['name:ja'] || t.name || '').trim();
  return n || null;
}

/** OSM タグから種別を読む（名前からは決めない）。 */
export function osmCategory(t) {
  if (!t) return null;
  if (t.amenity) return t.amenity;
  if (t.shop) return t.shop === 'yes' ? 'shop' : t.shop;
  if (t.tourism) return t.tourism;
  if (t.office) return t.office === 'yes' ? 'office' : t.office;
  if (t.leisure) return t.leisure;
  if (t.healthcare) return t.healthcare;
  if (t.historic) return t.historic;
  if (t.building && t.building !== 'yes') return 'building:' + t.building;
  return null;
}

export const isBuildingTags = (t) => !!(t && t.building);

/**
 * §4-C 「建物全体がほぼその施設」と安全に言える種別。
 * ここに無い POI は施設として紐づけるだけで、建物名には昇格させない。
 */
export const WHOLE_BUILDING_CATEGORIES = new Set([
  'school', 'college', 'university', 'kindergarten',
  'hospital', 'clinic',
  'place_of_worship',
  'fire_station', 'police',
  'townhall', 'library', 'museum', 'theatre',
  'supermarket', 'department_store', 'mall',
  'hotel',
]);

/** §12 の優先カテゴリ（ラベルの出し分けに使う）。 */
export const PRIORITY_CATEGORY_RANK = {
  museum: 0, attraction: 0, castle: 0, theatre: 0,
  department_store: 1, mall: 1, supermarket: 1,
  hotel: 2,
  hospital: 3, clinic: 4,
  university: 3, college: 4, school: 4, kindergarten: 6,
  townhall: 3, library: 4,
  police: 4, fire_station: 4,
  place_of_worship: 4,
  office: 5,
  bank: 6, pharmacy: 6, restaurant: 8, cafe: 8, fast_food: 8, convenience: 9, shop: 8,
};
export const categoryRank = (c) => (PRIORITY_CATEGORY_RANK[c] != null ? PRIORITY_CATEGORY_RANK[c] : 7);

/** リングの符号付き面積（|値| が面積）。 */
export function ringArea(ring) {
  let a = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const [x1, z1] = ring[i], [x2, z2] = ring[(i + 1) % n];
    a += x1 * z2 - x2 * z1;
  }
  return a / 2;
}

export function ringBbox(ring) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const [x, z] of ring) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  return { minX, maxX, minZ, maxZ };
}

export function ringCentroid(ring) {
  let a = 0, cx = 0, cz = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const [x1, z1] = ring[i], [x2, z2] = ring[(i + 1) % n];
    const cr = x1 * z2 - x2 * z1;
    a += cr; cx += (x1 + x2) * cr; cz += (z1 + z2) * cr;
  }
  a /= 2;
  if (Math.abs(a) < 1e-9) {
    let sx = 0, sz = 0;
    for (const [x, z] of ring) { sx += x; sz += z; }
    return [sx / ring.length, sz / ring.length];
  }
  return [cx / (6 * a), cz / (6 * a)];
}

export function pointInRing(x, z, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i], [xj, zj] = ring[j];
    if (((zi > z) !== (zj > z)) && (x < ((xj - xi) * (z - zi)) / ((zj - zi) || Number.EPSILON) + xi)) inside = !inside;
  }
  return inside;
}

export function bboxOverlap(a, b) {
  return !(a.maxX < b.minX || b.maxX < a.minX || a.maxZ < b.minZ || b.maxZ < a.minZ);
}

/**
 * 2 つのリングの重なり具合を、**サンプル点**で近似して測る。
 * 正確なポリゴンクリッピングは重く、ここで必要なのは「ほぼ同じ形か」の判定なので、
 * 建物リングの bbox を格子状にサンプルして「両方の内側」の割合を出す。
 *
 * @returns {{ratioOfA:number, ratioOfB:number, samples:number}}
 *   ratioOfA … A の内側の点のうち B にも入る割合
 */
export function overlapRatio(ringA, ringB, grid = 12) {
  const ba = ringBbox(ringA), bb = ringBbox(ringB);
  if (!bboxOverlap(ba, bb)) return { ratioOfA: 0, ratioOfB: 0, samples: 0 };
  let inA = 0, inB = 0, both = 0;
  const dx = (ba.maxX - ba.minX) / grid, dz = (ba.maxZ - ba.minZ) / grid;
  for (let i = 0; i < grid; i++) {
    for (let j = 0; j < grid; j++) {
      const x = ba.minX + dx * (i + 0.5), z = ba.minZ + dz * (j + 0.5);
      const a = pointInRing(x, z, ringA);
      const b = pointInRing(x, z, ringB);
      if (a) inA++;
      if (b) inB++;
      if (a && b) both++;
    }
  }
  return {
    ratioOfA: inA ? both / inA : 0,
    ratioOfB: inB ? both / inB : 0,
    samples: grid * grid,
  };
}

/** §4-A/B の採用しきい値。 */
export const MATCH = {
  /** 建物 way 自身の名称: 建物ポリゴン同士がこの割合以上重なれば同一とみなす */
  BUILDING_SELF_OVERLAP: 0.55,
  /** 施設 way の名称を建物名にするときの、施設が建物を覆う割合 */
  FACILITY_COVERS_BUILDING: 0.60,
  /** 逆に、建物が施設をほぼ覆っているとき（大きい建物の中の一区画は採らない） */
  FACILITY_INSIDE_BUILDING_MAX: 0.85,
  /** nearest を使ってよい上限距離（§5。証拠が揃ったときだけ） */
  NEAREST_MAX_M: 25,
};

/** 名称の正規化（重複判定用）。表示名は変えない。 */
export function normalizeName(s) {
  return String(s || '')
    .normalize('NFKC')
    .replace(/[\s　]+/g, '')
    .replace(/[（）()「」『』・,、.。]/g, '')
    .toLowerCase();
}

/**
 * §10 既存 landmark と同じものかどうか。
 * 名称の正規化一致 + 距離で見る。どちらか片方だけでは同一としない。
 */
export function isSameAsLandmark(name, x, z, landmarks, maxDistM = 260) {
  const n = normalizeName(name);
  if (!n) return null;
  for (const lm of landmarks) {
    const ln = normalizeName(lm.name);
    if (!ln) continue;
    // 名前が**完全に一致**するときは距離を見ない。
    //   landmark の名前は固有名詞で、アンカーは施設の重心に置かれている。
    //   天王寺公園のように広い施設では、同名の建物がアンカーから 300m 以上離れることがあり、
    //   距離で切ると画面に同じ名前が 2 回出てしまう（実機で確認）。
    if (ln === n) return lm;
    // 部分一致は根拠が弱いので、近いときだけ同一とみなす
    if (Math.hypot(lm.x - x, lm.z - z) <= maxDistM && (ln.includes(n) || n.includes(ln))) return lm;
  }
  return null;
}

/**
 * §9 ラベルをどのズーム帯から出すか。
 *   far  … ランドマーク級（ここでは建物ラベルは出さない）
 *   mid  … 主要ビル・大型施設
 *   near … 一般の建物名
 *   veryNear … 店舗・クリニック等の施設名
 */
export function labelTier({ height, category, isPrimaryFacility, footprintAreaM2 }) {
  const h = Number(height) || 0;
  const a = Number(footprintAreaM2) || 0;
  const rank = categoryRank(category);
  if (h >= 90 || a >= 12000 || rank <= 1) return 'mid';
  if (h >= 31 || a >= 2500 || rank <= 4) return 'near';
  if (isPrimaryFacility) return 'near';
  return 'veryNear';
}
