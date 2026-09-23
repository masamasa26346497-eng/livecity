// tools/lib/landmark-registry.js
// [見た目改善 Mission11] 大阪主要ランドマークの canonical レジストリ（純粋データ + 純粋ロジック）。
// ══════════════════════════════════════════════════════════════════════════════════
// 役割:
//   - LANDMARK_SEED = OSM から確認したランドマークの検証済み事実（座標 / footprint bbox /
//     おおよその高さ / カテゴリ / 重要度 / OSM 参照）。名称・座標を HTML 各所へ増殖させない
//     ための「唯一の出典」。
//   - resolveLandmarkBuildings() = seed の footprint と 24区 building dataset を厳密照合して
//     buildingIds を確定する。距離だけの nearest 割当は行わない（誤識別より unresolved を選ぶ）。
//   - 視覚表現は明度係数のみ（Mission10 と同じ考え方。色相は変えない）。
//
// 座標系は znorth-neg-v1（HTML geoToThree と一致）。x = 東, z = 南が正 / 北が負。
//
// modelType / modelUrl は将来のリアル 3D モデル差し替え用のフィールド。現在は全て PROCEDURAL。
// ══════════════════════════════════════════════════════════════════════════════════

export const LANDMARK_CATEGORIES = Object.freeze([
  'HISTORIC', 'SKYSCRAPER', 'STATION', 'CIVIC', 'ENTERTAINMENT', 'STADIUM', 'CULTURAL', 'COMMERCIAL',
]);
export const LANDMARK_IMPORTANCE = Object.freeze(['MAJOR', 'REGIONAL', 'LOCAL']);
export const LANDMARK_MODEL_TYPES = Object.freeze(['PROCEDURAL', 'LOD1', 'LOD2', 'LOD3', 'GLTF']);

// height > この値 の建物はデータ異常（Mission10 で max=29997m を確認）。ランドマーク候補として
// 採用しない。元データは変更しない（将来の Building Height QA Mission 候補）。
export const SUSPICIOUS_HEIGHT_M = 500;

// ── 検証済みシード（OSM osaka-latest.osm.pbf 由来。anchor は znorth-neg-v1 の footprint 重心）──
//   height: OSM の height タグ（m）。null は OSM に無いもの（levels 等からの概算はしない）。
//   footprintBbox: {w,h} OSM footprint の外接矩形サイズ（m）。resolution の sanity check 用。
export const LANDMARK_SEED = Object.freeze([
  { id: 'osaka-castle', name: '大阪城', nameEn: 'Osaka Castle', category: 'HISTORIC', importance: 'MAJOR', ward: 'chuo',
    osm: 'way/34619038', anchorX: 73.69, anchorZ: -9251.23, height: 58, footprintBbox: { w: 41, h: 45 } },
  { id: 'abeno-harukas', name: 'あべのハルカス', nameEn: 'Abeno Harukas', category: 'SKYSCRAPER', importance: 'MAJOR', ward: 'abeno',
    osm: 'way/187296989', anchorX: -993.87, anchorZ: -4633.22, height: 300, footprintBbox: { w: 269, h: 158 } },
  { id: 'umeda-sky-building', name: '梅田スカイビル', nameEn: 'Umeda Sky Building', category: 'SKYSCRAPER', importance: 'MAJOR', ward: 'kita',
    osm: 'relation/3389505', anchorX: -3195.25, anchorZ: -11249.05, height: 173, footprintBbox: { w: 112, h: 62 } },
  { id: 'kyocera-dome-osaka', name: '京セラドーム大阪', nameEn: 'Kyocera Dome Osaka', category: 'STADIUM', importance: 'MAJOR', ward: 'nishi',
    osm: 'way/149991212', anchorX: -4483.22, anchorZ: -7246.37, height: 83, footprintBbox: { w: 209, h: 209 } },
  { id: 'tsutenkaku', name: '通天閣', nameEn: 'Tsutenkaku', category: 'CULTURAL', importance: 'MAJOR', ward: 'naniwa',
    osm: 'way/254319878', anchorX: -1716.02, anchorZ: -5382.61, height: 108, footprintBbox: { w: 31, h: 32 } },
  { id: 'sakishima-cosmo-tower', name: '大阪府咲洲庁舎（コスモタワー）', nameEn: 'Osaka Prefectural Government Sakishima Building', category: 'SKYSCRAPER', importance: 'MAJOR', ward: 'suminoe',
    osm: 'way/43979655', anchorX: -10114.12, anchorZ: -3757.07, height: 256, footprintBbox: { w: 143, h: 149 } },
  { id: 'nakanoshima-festival-tower', name: '中之島フェスティバルタワー', nameEn: 'Nakanoshima Festival Tower', category: 'SKYSCRAPER', importance: 'MAJOR', ward: 'kita',
    osm: 'way/94188447', anchorX: -2620.17, anchorZ: -9942.31, height: 199, footprintBbox: { w: 84, h: 86 } },
  { id: 'nakanoshima-festival-tower-west', name: '中之島フェスティバルタワーウエスト', nameEn: 'Nakanoshima Festival Tower West', category: 'SKYSCRAPER', importance: 'REGIONAL', ward: 'kita',
    osm: 'way/94188457', anchorX: -2704.23, anchorZ: -9934.94, height: 200, footprintBbox: { w: 69, h: 77 } },
  { id: 'osaka-city-hall', name: '大阪市役所', nameEn: 'Osaka City Hall', category: 'CIVIC', importance: 'MAJOR', ward: 'kita',
    osm: 'way/173266876', anchorX: -2092.49, anchorZ: -9962.84, height: null, footprintBbox: { w: 107, h: 69 } },
  { id: 'osaka-pref-government', name: '大阪府庁本館', nameEn: 'Osaka Prefectural Government Building', category: 'CIVIC', importance: 'REGIONAL', ward: 'chuo',
    osm: 'way/87365327', anchorX: -472.1, anchorZ: -9143.67, height: 40, footprintBbox: { w: 76, h: 107 } },
  { id: 'kaiyukan', name: '海遊館', nameEn: 'Osaka Aquarium Kaiyukan', category: 'CULTURAL', importance: 'MAJOR', ward: 'minato',
    osm: 'node/4260333992', anchorX: -8763.31, anchorZ: -5671.89, height: null, footprintBbox: null },
  { id: 'atc', name: 'アジア太平洋トレードセンター（ATC）', nameEn: 'Asia and Pacific Trade Center', category: 'COMMERCIAL', importance: 'REGIONAL', ward: 'suminoe',
    osm: 'way/1029554610', anchorX: -10309.59, anchorZ: -3702.31, height: null, footprintBbox: { w: 436, h: 363 } },
  { id: 'grand-front-osaka', name: 'グランフロント大阪', nameEn: 'Grand Front Osaka', category: 'COMMERCIAL', importance: 'MAJOR', ward: 'kita',
    osm: 'relation/13166723', anchorX: -2766.16, anchorZ: -11195.54, height: null, footprintBbox: { w: 178, h: 560 } },
  { id: 'osaka-station-city', name: '大阪駅・大阪ステーションシティ', nameEn: 'Osaka Station City', category: 'STATION', importance: 'MAJOR', ward: 'kita',
    osm: 'node/346685291', anchorX: -2698.12, anchorZ: -10909.95, height: null, footprintBbox: null },
  { id: 'osaka-station-north-gate', name: 'ノースゲートビルディング（大阪ステーションシティ）', nameEn: 'North Gate Building', category: 'STATION', importance: 'REGIONAL', ward: 'kita',
    osm: 'way/162183788', anchorX: -2659.85, anchorZ: -11032.92, height: 150, footprintBbox: { w: 265, h: 182 } },
  { id: 'jp-tower-osaka', name: 'JPタワー大阪', nameEn: 'JP Tower Osaka', category: 'SKYSCRAPER', importance: 'REGIONAL', ward: 'kita',
    osm: 'way/1146510724', anchorX: -2822.12, anchorZ: -10732.52, height: 188, footprintBbox: { w: 136, h: 152 } },
  { id: 'kansai-electric-building', name: '関電ビルディング', nameEn: 'Kanden Building', category: 'SKYSCRAPER', importance: 'REGIONAL', ward: 'kita',
    osm: 'way/179071315', anchorX: -2984.05, anchorZ: -9843.35, height: 195, footprintBbox: { w: 68, h: 60 } },
  { id: 'obp-twin21', name: 'ツイン21（大阪ビジネスパーク）', nameEn: 'Twin 21', category: 'SKYSCRAPER', importance: 'REGIONAL', ward: 'chuo',
    osm: 'way/176306972', anchorX: 594.29, anchorZ: -9849.68, height: 157, footprintBbox: { w: 60, h: 60 } },
  { id: 'universal-studios-japan', name: 'ユニバーサル・スタジオ・ジャパン', nameEn: 'Universal Studios Japan', category: 'ENTERTAINMENT', importance: 'MAJOR', ward: 'konohana',
    osm: 'relation/5695002', anchorX: -8497.43, anchorZ: -6911.03, height: null, footprintBbox: { w: 891, h: 891 } },
]);

// ── [Mission11B] ランドマーク 3D モデル計画 ──────────────────────────────────────
// modelType: LOD1（既存 building dataset で resolved）/ PROCEDURAL（OSM footprint+height から特徴形状生成）
//   / LOD2 / LOD3 / GLTF（将来。modelUrl を持つ）。
// proceduralShape: LandmarkModelProvider が知っている生成器名。null = 生成器なし（表示しない）。
//   'tower'           … 先細りの塔（通天閣）
//   'dome'            … 低い胴 + 半楕円ドーム（京セラドーム）
//   'twin-tower-ring' … 2 枚のスラブ + 頂部の連結リング（梅田スカイビル）
// heightSource: 高さの出典（実世界スケール尊重の根拠）。
// modelUrl: GLTF 等の実ファイル。現在は全て null（loader 未実装）。
export const LANDMARK_MODEL_PLAN = Object.freeze({
  // ── PoC 3 件（OSM footprint + 検証済み高さ / ODbL）──
  'tsutenkaku':          { modelType: 'PROCEDURAL', proceduralShape: 'tower',           modelUrl: null, heightSource: 'OSM height=108（公表値 108m と一致）' },
  'kyocera-dome-osaka':  { modelType: 'PROCEDURAL', proceduralShape: 'dome',            modelUrl: null, heightSource: '頂部 83m（公表値。OSM height=36 は外周屋根高）/ footprint は OSM way/149991212' },
  'umeda-sky-building':  { modelType: 'PROCEDURAL', proceduralShape: 'twin-tower-ring', modelUrl: null, heightSource: 'OSM height=173（空中庭園 173m と一致）' },
  // ── 既存 LOD1 で resolved（Mission11）。専用モデルは作らない ──
  'abeno-harukas':       { modelType: 'LOD1', proceduralShape: null, modelUrl: null, heightSource: 'PLATEAU LOD1 building dataset（dz 328.4m）' },
  // ── LOD2 待ち。単純な箱押し出しは禁止（指示書 5 節）→ 生成器なし ──
  'osaka-castle':        { modelType: 'LOD2', proceduralShape: null, modelUrl: null, heightSource: 'PLATEAU LOD2 未取得。天守閣 OSM height=58' },
});
export const DEFAULT_MODEL_PLAN = Object.freeze({ modelType: 'PROCEDURAL', proceduralShape: null, modelUrl: null, heightSource: null });

/** seed id のモデル計画（未定義は DEFAULT_MODEL_PLAN）。 */
export function modelPlanFor(id) {
  return LANDMARK_MODEL_PLAN[id] || DEFAULT_MODEL_PLAN;
}

/** id の重複が無いか（build 前の健全性チェック）。 */
export function findDuplicateIds(seed = LANDMARK_SEED) {
  const seen = new Set();
  const dups = [];
  for (const s of seed) { if (seen.has(s.id)) dups.push(s.id); seen.add(s.id); }
  return dups;
}

/** 座標が有限か。 */
export function hasFiniteAnchor(s) {
  return Number.isFinite(s.anchorX) && Number.isFinite(s.anchorZ);
}

/** height が異常値（> SUSPICIOUS_HEIGHT_M）か。null は false（不明）。 */
export function isSuspiciousHeight(h) {
  return typeof h === 'number' && Number.isFinite(h) && h > SUSPICIOUS_HEIGHT_M;
}

// ── footprint 照合 ───────────────────────────────────────────────────────────────
export function pointInRing(x, z, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], zi = ring[i][1], xj = ring[j][0], zj = ring[j][1];
    if (((zi > z) !== (zj > z)) && (x < ((xj - xi) * (z - zi)) / (zj - zi) + xi)) inside = !inside;
  }
  return inside;
}
export function ringBboxXZ(ring) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const [x, z] of ring) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  return { minX, maxX, minZ, maxZ, w: maxX - minX, h: maxZ - minZ };
}
export function ringAreaXZ(ring) {
  let a = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const [x1, z1] = ring[i], [x2, z2] = ring[(i + 1) % n];
    a += x1 * z2 - x2 * z1;
  }
  return Math.abs(a) / 2;
}

/**
 * 1 つのランドマーク seed を建物リストへ厳密照合する。
 * 優先度:
 *   A. anchor(検証座標) を footprint に内包し、かつ高さが妥当（height 既知なら比が [0.55, 1.9]、
 *      未知なら dz >= 25m）→ resolved（method: 'containment'）
 *   B. A が無く、height 既知で、anchor から 30m 以内に「高さ比 [0.7,1.5] の 1 棟だけ」がある
 *      → resolved（method: 'proximity-height-unique'。距離のみの nearest ではなく高さ一致 + 一意性が条件）
 *   それ以外 → unresolved（reason つき）
 * @param {object} seed
 * @param {Array<{id,fp,dz,_ward?}>} buildings 近傍候補（呼び出し側で bbox 事前絞り込み済みでよい）
 */
export function resolveLandmarkBuildings(seed, buildings) {
  if (!hasFiniteAnchor(seed)) return { resolved: false, buildingIds: [], method: null, reason: 'anchor-not-finite' };
  const x = seed.anchorX, z = seed.anchorZ;
  const okH = (dz) => {
    if (isSuspiciousHeight(dz)) return false;
    if (typeof seed.height === 'number') { const r = dz / seed.height; return r >= 0.55 && r <= 1.9; }
    return dz >= 25;
  };

  // A. containment
  const contained = [];
  for (const b of buildings) {
    if (!b.fp || b.fp.length < 3 || isSuspiciousHeight(b.dz)) continue;
    const bb = ringBboxXZ(b.fp);
    if (x < bb.minX - 2 || x > bb.maxX + 2 || z < bb.minZ - 2 || z > bb.maxZ + 2) continue;
    if (pointInRing(x, z, b.fp)) contained.push(b);
  }
  const containedOk = contained.filter((b) => okH(b.dz));
  if (containedOk.length) {
    // 内包かつ高さ妥当。複数なら全部（同一ランドマークの分割棟の可能性）
    return { resolved: true, buildingIds: containedOk.map((b) => b.id), method: 'containment',
      matchedHeights: containedOk.map((b) => b.dz) };
  }
  if (contained.length && typeof seed.height === 'number') {
    return { resolved: false, buildingIds: [], method: null,
      reason: `contained building height mismatch (dz=${contained.map((b) => b.dz).join('/')} vs osm ${seed.height})` };
  }

  // B. proximity + height + uniqueness（height 既知のときのみ）
  if (typeof seed.height === 'number') {
    const near = buildings.filter((b) => {
      if (!b.fp || b.fp.length < 3 || isSuspiciousHeight(b.dz)) return false;
      const c = centroidXZ(b.fp);
      const d = Math.hypot(c[0] - x, c[1] - z);
      const r = b.dz / seed.height;
      return d <= 30 && r >= 0.7 && r <= 1.5;
    });
    if (near.length === 1) {
      return { resolved: true, buildingIds: [near[0].id], method: 'proximity-height-unique', matchedHeights: [near[0].dz] };
    }
    if (near.length > 1) {
      return { resolved: false, buildingIds: [], method: null, reason: `ambiguous: ${near.length} height-matching buildings within 30m` };
    }
  }

  return { resolved: false, buildingIds: [], method: null,
    reason: typeof seed.height === 'number'
      ? `no containing or height-matching PLATEAU building near anchor (data gap)`
      : `no containing PLATEAU building at anchor and osm height unknown` };
}

export function centroidXZ(ring) {
  let x = 0, z = 0;
  for (const p of ring) { x += p[0]; z += p[1]; }
  return [x / ring.length, z / ring.length];
}

// ── 視覚表現（明度係数のみ。色相は変えない）───────────────────────────────────────
// Mission10 の合成順序: base shade × height style × landmark style → clamp。
// landmark は「わずかに明るい壁・屋根・edge」。派手にしない。
export const LANDMARK_STYLE = Object.freeze({
  // mode: 'detail' = 近景の実体壁 / 'cityLOD' = 遠景 merged
  detail:  Object.freeze({ wallMul: 1.035, roofMul: 1.05, edgeMul: 1.30 }),
  cityLOD: Object.freeze({ wallMul: 1.025, roofMul: 1.04, edgeMul: 1.00 }),
});
export const LANDMARK_SHADE_CEIL = 1.12;

export function getLandmarkStyle(mode = 'detail') {
  return mode === 'cityLOD' ? LANDMARK_STYLE.cityLOD : LANDMARK_STYLE.detail;
}

/** seed の妥当性検証（validator / test 共用）。 */
export function validateSeed(seed = LANDMARK_SEED) {
  const errors = [];
  const dups = findDuplicateIds(seed);
  if (dups.length) errors.push(`duplicate landmark id: ${dups.join(', ')}`);
  for (const s of seed) {
    if (!s.id || !/^[a-z0-9-]+$/.test(s.id)) errors.push(`invalid id: ${JSON.stringify(s.id)}`);
    if (!s.name) errors.push(`${s.id}: name 空`);
    if (!LANDMARK_CATEGORIES.includes(s.category)) errors.push(`${s.id}: category 不正 (${s.category})`);
    if (!LANDMARK_IMPORTANCE.includes(s.importance)) errors.push(`${s.id}: importance 不正 (${s.importance})`);
    if (!hasFiniteAnchor(s)) errors.push(`${s.id}: anchor が非有限`);
    if (s.height != null && (!Number.isFinite(s.height) || s.height <= 0)) errors.push(`${s.id}: height 不正 (${s.height})`);
    if (isSuspiciousHeight(s.height)) errors.push(`${s.id}: height が異常値 ${s.height} > ${SUSPICIOUS_HEIGHT_M}`);
    if (!/^(way|node|relation)\/\d+$/.test(s.osm || '')) errors.push(`${s.id}: osm 参照が不正 (${s.osm})`);
  }
  return { ok: errors.length === 0, errors };
}
