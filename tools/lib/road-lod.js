// tools/lib/road-lod.js
// [見た目改善 Mission02] 道路の距離LOD（純粋・THREE非依存）。
//   City Mode で大阪市全域を表示すると、住宅道路まで含めた全道路が同時に見えて灰色の網ノイズに
//   なる問題への対処。highway タグを3段階（MAJOR/MID/LOCAL）へ分類し、camera距離のband
//   （FAR/MID/NEAR）に応じてどのクラスを表示するかだけを決める（道路の幅付きribbon化はMission03）。
// canonical。public/osaka_3d_buildings.ward-ux-v1.html の CityTileLayer に同じロジックを inline する。

/**
 * highway タグ → 'major' | 'mid' | 'local'。
 * MAJOR: motorway/motorway_link/trunk/trunk_link/primary/primary_link（幹線・都市の骨格）
 * MID:   secondary/secondary_link/tertiary/tertiary_link（主要一般道路）
 * LOCAL: residential/unclassified/service 等・不明タグすべて（住宅道路・細街路）
 */
export const ROAD_LOD_CLASSES = Object.freeze({
  major: new Set(['motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link']),
  mid: new Set(['secondary', 'secondary_link', 'tertiary', 'tertiary_link']),
});

export function classifyRoadLod(highway) {
  if (ROAD_LOD_CLASSES.major.has(highway)) return 'major';
  if (ROAD_LOD_CLASSES.mid.has(highway)) return 'mid';
  return 'local'; // residential/unclassified/service 等・不明タグはすべて local
}

// [指示書2節] FAR: City Mode全域を一望する距離 → MAJORのみ。
//             MID: 中景 → MAJOR+MID。
//             NEAR: 近景（Ward Mode相当） → MAJOR+MID+LOCAL。
export const ROAD_LOD_BANDS = Object.freeze({ farM: 9000, midM: 3500 });

/** camera距離 → 'far' | 'mid' | 'near'。 */
export function roadLodBand(distance) {
  const d = Number.isFinite(distance) ? distance : 0;
  if (d > ROAD_LOD_BANDS.farM) return 'far';
  if (d > ROAD_LOD_BANDS.midM) return 'mid';
  return 'near';
}

/** クラス('major'|'mid'|'local')が指定距離で表示されるべきか。 */
export function roadClassVisible(cls, distance) {
  const band = roadLodBand(distance);
  if (cls === 'major') return true; // 常時（都市の骨格）
  if (cls === 'mid') return band !== 'far'; // FARでは非表示、MID/NEARで表示
  return band === 'near'; // local: NEARのみ
}

/**
 * feature配列（{highway}を持つ）を3クラスへ分類し件数を数える（実機確認・デバッグ用）。
 * @param {{highway?:string}[]} features
 * @returns {{major:number, mid:number, local:number, total:number}}
 */
export function countByRoadLodClass(features) {
  const counts = { major: 0, mid: 0, local: 0 };
  for (const f of (features || [])) counts[classifyRoadLod((f && f.highway) || '')]++;
  return { ...counts, total: counts.major + counts.mid + counts.local };
}
