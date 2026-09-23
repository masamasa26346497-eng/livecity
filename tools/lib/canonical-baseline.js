// tools/lib/canonical-baseline.js
// [Mission 35E] canonical レイヤーの「今の正しい件数」の正本。
//
//   これまで各 validator / test が 199658 のような数字を直書きしていた。
//   意図は「自分のミッションが canonical を勝手に書き換えていないこと」の確認で、
//   それ自体は正しい。ただし **source を正当に入れ替えたとき**（35E の北側道路補完など）に
//   41 ファイルを一斉に直す羽目になり、直し漏れると「不変」の意味が壊れる。
//
//   数字はここだけに置き、変えるときは下の履歴に理由を書く。
//   「勝手に変えてよい数字」ではない。変えるのは canonical を作り直したミッションだけ。

/** canonical roads の feature 数。 */
export const CANONICAL_ROAD_FEATURE_COUNT = 199840;
/** canonical buildings（V1 系）の feature 数。 */
export const CANONICAL_BUILDING_FEATURE_COUNT = 615617;
/** canonical water / rail / parks の feature 数。 */
export const CANONICAL_WATER_FEATURE_COUNT = 823;
export const CANONICAL_RAIL_FEATURE_COUNT = 3216;
export const CANONICAL_PARKS_FEATURE_COUNT = 4194;
/** canonical rail の駅数（線とは別 payload の stations.json）。 */
export const CANONICAL_STATION_COUNT = 253;
/**
 * FIX13 refined-road-surface.json の索引数。
 * canonical roads から作るので、roads を作り直すと一緒に動く。
 */
export const REFINED_ROAD_SURFACE_INDEXED_COUNT = 29942;

/**
 * 変更履歴。数字を動かすときは必ず 1 行足す。
 * 「いつ・どのミッションが・なぜ」作り直したのかが分からないと、
 * 次に見た人が「壊れたのか正当なのか」を判断できない。
 */
export const CANONICAL_BASELINE_HISTORY = [
  { layer: 'roads', from: null, to: 199658, missionId: '31C',
    reason: 'canonical roads を初めて生成（OSM centerline + PLATEAU tran polygon）' },
  { layer: 'roads', from: 199658, to: 199840, missionId: '35E',
    reason: 'OSM source を osaka-latest.osm.pbf（lat 34.73 で北が切れていた）から '
      + 'osaka-full-coverage.osm.pbf（Geofabrik kansai）へ入れ替え。'
      + '東淀川 260→3,841 ways / 淀川 2,068→3,382 ways / 旭 1,789→1,930 ways。'
      + 'ROAD V3 の意味・設計・描画方式は変更していない（入力だけ）。' },
  { layer: 'refined-road-surface', from: 30190, to: 29942, missionId: '35E',
    reason: 'canonical roads を作り直したことに伴う再生成。索引の作り方は変えていない。' },
  // 35F: 道路と同じ切断が rail / water / parks / 駅 にも効いていた。
  //   北側だけが増え、南側は 0.0% で動かない（data/reports/osm-shared-source-coverage.json）。
  { layer: 'rail', from: 2828, to: 3216, missionId: '35F',
    reason: 'OSM source を広域 PBF へ入れ替え。東淀川 13→173 / 淀川 295→498 ways。'
      + '鉄道の描画方式（tier 別 LineSegments）は変更していない（入力だけ）。' },
  { layer: 'stations', from: 233, to: 253, missionId: '35F',
    reason: '同上。railway=station node が北部で 39→55 に回復（新大阪・東淀川・淡路・下新庄 ほか）。'
      + '駅名のハードコード追加はしていない。' },
  { layer: 'water', from: 528, to: 823, missionId: '35F',
    reason: '同上。waterway way が北部で 135→197。神崎川水系が北端まで繋がった。'
      + 'canonical water の作り方（rivers-v2 + 海面ラスタ）は変更していない（入力だけ）。' },
  { layer: 'parks', from: 2954, to: 4194, missionId: '35F',
    reason: '同上。leisure=park が北部で 228→352。ParkLayer の分類・LOD 規則は変更していない。' },
];

/** そのレイヤーの期待値。 */
export function expectedCanonicalCount(layer) {
  switch (layer) {
    case 'roads': return CANONICAL_ROAD_FEATURE_COUNT;
    case 'buildings': return CANONICAL_BUILDING_FEATURE_COUNT;
    case 'water': return CANONICAL_WATER_FEATURE_COUNT;
    case 'rail': return CANONICAL_RAIL_FEATURE_COUNT;
    case 'parks': return CANONICAL_PARKS_FEATURE_COUNT;
    case 'stations': return CANONICAL_STATION_COUNT;
    default: return null;
  }
}
/** manifest の featureCount が期待どおりか。 */
export function isCanonicalUnchanged(layer, featureCount) {
  const want = expectedCanonicalCount(layer);
  return want != null && featureCount === want;
}

/**
 * そのレイヤーが **これまでに正当だった** 件数か。
 *
 * 過去ミッションが残した validation report は、その当時の canonical を見て書かれている。
 * それを「今日の件数」と突き合わせると、source を正当に入れ替えた瞬間に過去の記録が
 * 全部 FAIL になる。過去の記録は「書かれた時点で正しかったか」で判断する。
 */
export function isKnownCanonicalCount(layer, featureCount) {
  if (isCanonicalUnchanged(layer, featureCount)) return true;
  return CANONICAL_BASELINE_HISTORY.some((h) => h.layer === layer
    && (h.to === featureCount || h.from === featureCount));
}
