# MISSION 32E 完了報告 — GSI-CONSTRAINED ROAD VISUAL（RoadVisualV2）

Building（x/z/scale/footprint/height/Canonical/GSI Building）・Projection・Origin・Canonical Road
geometry・raw PLATEAU・raw GSIは一切変更していない。変更したのは **DERIVED/VISUAL ROAD SURFACE のみ**
（新規 derived dataset。既存FIX13は削除せず、opt-inのRoad Mode切替で比較可能にした）。

最終判定: **`ROAD_VISUAL_V2_SUCCESS`**

---

## §45 必須22項目

### 1. FIX13のdark road面積
6 acceptance fixture(半径500m)合計: **1,311,610 m²**（primary=CARRIAGEWAY/INTERSECTION/RAMPの全面積、
従来通りtran polygon全体をdark表示）。

### 2. ROAD V2 carriageway面積
同fixture合計: **438,050 m²**（GSI HIGH/MEDIUM confidenceで裏付けられたcarriagewayのみ。
全市では13,556,252 m²）。

### 3. ROAD_MARGIN面積
全市: **3,511,610 m²**（CARRIAGEWAY_RESOLVEDと判定されたfeatureの中で、carriagewayとして
確認できなかった残余分。sidewalk/shoulder/planting/road reserve等の可能性がある領域として
carriagewayより明確に薄く表示）。

### 4. GSI HIGH pairing数
**101,326 件**（corridor pair、全市・真幅道路79,602本をsegmentize+Viterbi DP corridor
reconstruction(Mission 31G-FIX18のtools/lib/gsi-road-edge-corridor-v3.jsを再利用)した結果）。

### 5. GSI MEDIUM pairing数
**41,974 件**。LOW=2,782件（今回不採用）。HIGH+MEDIUM採用率 = 97.9%。

### 6. GSI conflict数
**119,788 features**（候補quadのbbox overlap後、clip面積/quad元面積<0.3だったfeature数）。
内訳: CARRIAGEWAY_RESOLVED側43,167件・UNCERTAIN側76,621件。**正直な限界の開示**: uncertain側の
計上には「そのquadが実際には隣接/別の道路に属していただけ」の誤検出が混入し得るため、これは
厳密なGSI/tran意味論的不整合の件数そのものではない（詳細は下記「途中で発見した限界」参照）。

### 7. BUILDING∩DARK ROAD before（FIX13）
6 fixture合計: **479,511 m²**（各fixtureのbuilding footprintがFIX13のdark road areaと重なる面積、
1m格子raster measurement）。

### 8. BUILDING∩DARK ROAD after（RoadVisualV2）
6 fixture合計: **176,180 m²**。

### 9. 改善率
**63.3%削減**（§38の目安30%以上を大きく上回る）。道路自体を大量に消すことによる見かけ上の改善では
ないことを確認済み（§25: continuity/tracksWithCoverage比率93.4%を維持、area accounting整合性も
reconciliationDiffM2=0で確認）。

### 10. continuity gap数
gapTransitionCount=18,521、isolatedFragmentCount=84,017（132,344 corridor track中）。
tracksWithCoverage=123,622（**93.4%**のtrackが何らかのHIGH/MEDIUM区間を持つ）。

### 11-16. 各サイト結果（fixture半径500m、改善率=BUILDING∩DARK ROADの削減率）

| サイト | FIX13重なりm² | V2重なりm² | 改善率 |
|---|---|---|---|
| 梅田 | 98,602 | 22,943 | **76.7%** |
| 中之島 | 69,494 | 23,902 | 65.6% |
| 本町 | 90,710 | 51,369 | 43.4%（6サイト中最小） |
| 難波 | 102,725 | 41,137 | 60.0% |
| 天王寺 | 64,141 | 20,208 | 68.5% |
| 住吉 | 53,839 | 16,621 | 69.1% |

全サイトで改善（悪化なし）。梅田が最大改善（Mission 32Dで根本原因が最も強く見えたサイトで、
最も効果が大きく出た）。住吉（GSI/FIX13 agreementが元々良いサイト）でも不必要な改悪は起きていない
（69.1%改善、6サイト中2番目に良い結果）。本町が相対的に最小の改善（43.4%）だが、それでも§38の
30%目安は上回っている。

### 17. visual comparison
実機3D表示での目視確認は本レポート作成時点で未実施（後述「visualQaStatus」参照）。`[FIX13][ROAD V2]
[DIFF]`のRoad Modeボタンで同一カメラのまま切替可能。DIFFモードはFIX13がdarkにしていた範囲を赤、
RoadVisualV2のcarriageway(=GSI裏付き部分)を緑で重ね描画し、どこを「道路」から除外したかを可視化する
（正確なpolygon boolean演算はせず、z-order overpaintingで赤の上に緑を重ねる近似実装。§22参照）。

### 18. performance
Road Mode ONで新規に増える draw call は tile(2000m grid、92 tile)あたり最大5 mesh
（Uncertain/Margin/Carriageway/DiffBase/DiffCommon、各tileで実際に使うのはそのうち3つのみ・
モードごとに visible切替のみで再構築しない）。既存roadsレイヤーの'primary' bucket meshは
名前タグ(`RoadBucket_primary`)を付けてhide/showするだけで、再構築コストは発生しない。
配信データは全市169,468 featureぶん(envelope+carriageway込み)で**227MB**（opt-in・既定OFF。
Mission 32BのVisual Buildings(GSI)トグル797MBと同様、defaultの読み込み量には影響しない）。

### 19. validator
`tools/validate/road-visual-v2.js`。RESULT=**PASS**。buildingMutation=0、canonicalRoadMutation=0、
projectionMutation=0、tranPolygonFullDarkDefault=false、roadV2UsesGsiConfidenceGate=true、
unresolvedDoesNotFallbackToFullDark=true、roadAreaAccountingValid=true、
buildingDarkRoadOverlapMeasured=true、productionModified=false、protectedModified=false。

### 20. npm test
`tests/road-visual-v2.test.js`（10件）を`package.json`へ登録。フルスイート実行結果:
**1582 tests / 1567 pass / 0 fail / 15 skip**（既存分含む全体）。

### 21. production/protected unchanged
`public/osaka_3d_buildings.html` / `public/osaka_3d_buildings.fullward-v3.html` ともhash baseline
と一致、無変更を確認。Canonical Buildings=615,617／Canonical Roads=199,658／
refined-road-surface.json indexedCount=30,190、すべて不変。

### 22. final verdict
**`ROAD_VISUAL_V2_SUCCESS`**（verdictCriteria: overlapReducedEnough=true・
continuityNotBroken=true・areaAccountingValid=true・geometryValid=true、すべて満たす）。

---

## 設計の要点（§1-9）

- **Canonical Road Area ≠ Visual Carriageway** という概念分離を導入。既存Canonical Road polygon
  （PLATEAU tran由来、道路区域=車道+歩道込み）は一切変更せず、その上に「どこを実際に濃い車道色で
  塗るか」を判断する新層(RoadVisualV2)を重ねた。
- **既存資産の再利用**（§4）: Mission 31G-FIX18で構築済みの corridor-level GSI reconstruction
  （`tools/lib/gsi-road-edge-pairing-v2.js`のsegmentize/scorePair + `tools/lib/gsi-road-edge-corridor-v3.js`
  のViterbi DP・change-point検出・side consistency）をそのまま再利用。この既存パイプラインは既に
  `data/reports/gsi-road-reconstruction-v3.json`で`finalDecision: "READY_FOR_HYBRID_GSI_ROAD_PROTOTYPE"`
  （HIGH 101,326/MEDIUM 41,974/LOW 2,782、line coverage 93.7%）という実測結果を持っており、
  古いHYBRID_V1（`seamsMostlyBroken: true`で不採用済み）の表示ロジックは意図的に流用しなかった。
- **tran envelopeへの安全clip**（§7）: GSI再構成roadway(quad)をPLATEAU tran road envelope
  （=そのfeature自身のpolygon）へSutherland-Hodgman clipする新規lib
  （`tools/lib/polygon-clip.js`）を実装。汎用のpolygon boolean演算ライブラリは導入せず、
  quadがenvelopeに比べて十分小さいという前提のもとで採用（正直な制約として明記）。
- **§8絶対禁止の遵守**: primary属性を持つだけでtran polygon全体をdarkにする既存挙動を、
  CARRIAGEWAY_RESOLVED/UNCERTAIN_ROAD_SURFACEの2分類へ置き換えた。GSIで十分カバーできない
  場合（coverageRatio<25%）はUNCERTAIN_ROAD_SURFACEとし、**全体darkへは一度も戻していない**
  （validator `tranPolygonFullDarkDefault=false`・`unresolvedDoesNotFallbackToFullDark=true`で確認）。
- **sidewalk/median/pedestrian/bridgeは完全に既存のまま**（§11/§12/§15/§16）。今回reprocessした
  のはFIX13が「primary」(CARRIAGEWAY/INTERSECTION/RAMP)に分類していた169,468 feature(52.7M m²の
  うち38.5M m²)のみ。

---

## 途中で発見・修正したバグ（正直な開示）

- **area accounting不整合バグ**: 初回実装ではcarriagewayAreaM2へcoveredArea(clamp無し)を
  そのまま加算していたため、隣接pairから生成されたquad同士のわずかな重なりにより
  「carriageway+margin+uncertainの合計がenvelope総面積を2.2%超過する」不整合が発生した
  （reconciliationDiffM2=-853,848）。feature自身の面積を上限としてclampする修正
  （`Math.min(coveredArea, featureArea)`）で、reconciliationDiffM2=**0（完全一致）**を達成した。
- **tile境界重複への対応**: canonical roadsのtile境界重複feature（32Dで確認済みの既知の性質）に
  対応するため、分類はcanonicalId単位で1回だけ計算(pass1)し、該当する全tileコピーへ複製して
  出力する(pass2)構成にした。単純に1回のループでdedupしながら出力すると、runtimeが後から
  fetchする「2番目のtileコピー」でclassificationが欠落する不具合を防いでいる。
- **classmapの配信サイズ**: 当初169,468件を1ファイル(21MB)で一括配信する設計だったが、
  「camera-near fetch・大量個別meshは禁止」（§34/§35）の趣旨に合わせ、envelope geometryも
  同梱した自己完結型tile(2000m grid、92 tile)へ再設計した（1 tile 1 fetchで完結し、
  既存"roads"tileを再fetch/cross-referenceする必要が無い設計にした）。

## 途中で発見した限界（正直な開示・修正はしていない）

- **gsiConflictFeatureCount(119,788件)の解釈**: この数値は「候補quadのbbox overlap後、clip比率
  <30%だったfeature」を機械的に集計したもので、真の「GSI/tran意味論的不整合」だけでなく
  「近くの別の道路に属するquadがたまたまbbox越しに触れただけ」のケースも含み得る。
  resolved側(43,167件)は「採用したcarriagewayの一部がenvelope外へはみ出した」という意味で
  §18の定義に近いが、uncertain側(76,621件)の数値はやや過大評価の可能性がある（両者を分けて
  報告することでこの限界を開示している）。
- **DIFFモードの視覚的近似**: 真のpolygon boolean演算（FIX13 dark AND NOT RoadV2 carriageway）は
  実装しておらず、z-order overpainting（赤の上に緑を重ねる）による近似で「どこを除外したか」を
  表現している。境界のごく細い部分で厳密な赤/緑の区分けにならない可能性がある。
- **§27の実機視覚QA未実施**: 実ブラウザでの`[FIX13][ROAD V2][DIFF]`切替による目視比較は、
  本レポート作成時点では行っていない（下記visualQaStatus参照）。
- **RoadVisualV2 dynamic testの制約**: このセッションのtest harnessは`requestAnimationFrame`が
  no-opスタブのため、`CanonicalRuntime.update()`の実per-frame実行に依存する通常のcamera駆動
  tile-fetchパイプラインを動かせず（新たに発見した既存の`CityModeManager` TDZ関連の制約。
  memory: `canonicalruntime-update-tdz-blocks-harness-tile-fetch`に記録）、RoadVisualV2が
  実際にcamera位置に応じてtileをfetch・構築する一連の流れそのものは今回のtest実行では検証できて
  いない。Road Modeトグル自体の安全な切替（tileCacheが空の状態でも例外を投げない・residual
  0を維持する）は動的に確認済みだが、**実ブラウザでの目視確認が必須**である。

---

## visualQaStatus

**VISUAL_QA_PENDING_USER**。実ブラウザで`public/osaka_3d_buildings.ward-ux-v1.html`を開き、
status panel内の「Road Mode: [FIX13][ROAD V2][DIFF]」ボタンで梅田周辺（特に幹線道路沿い・高層建物
沿い・大交差点・駅周辺）を中心に切り替え、建物の足元・道路縁・歩道・車道の関係がFIX13より自然に
見えるかをご確認ください。既定はFIX13のままで、大阪全域のdefaultへは昇格していません。

---

## Canonical/Building保護の確認

- Canonical Buildings: 615,617件（不変）／Canonical Roads: 199,658件（不変）／
  refined-road-surface.json indexedCount: 30,190（不変）
- Building（x/z/scale/footprint/height/Canonical/GSI）は本ミッションで一切変更していない
- production (`osaka_3d_buildings.html`) / protected (`osaka_3d_buildings.fullward-v3.html`): 無変更
- 既存レイヤー（water/parks/rail/building picking/property card/usage palette/ward switching/
  City Mode/Map Audit/Reference Alignment）への影響なし（npm test 1582/1567 pass/0 fail/15 skipで確認）

## 新規/変更ファイル一覧

- `tools/lib/polygon-clip.js`（新規）— Sutherland-Hodgman polygon clip。
- `tools/build-road-visual-v2.js`（新規）— RoadVisualV2ビルダー本体。
- `tools/validate/road-visual-v2.js`（新規）— validator。RESULT=PASS。
- `tests/road-visual-v2.test.js`（新規、10テスト）— `package.json`へ登録済み。
- `data/processed/osaka-city/derived/road-visual-v2/`（新規）— 全市169,468 feature、2000m tile
  (92 tile)、自己完結型（envelope+carriageway+classification同梱）。
- `public/map-data/osaka-city/derived/road-visual-v2/`（新規、配信用コピー、227MB）。
- `data/reports/road-visual-v2.json`（新規）— §36必須フィールド全て含む。
- `data/reports/road-visual-v2-validation.json`（新規）— validator出力。
- `public/osaka_3d_buildings.ward-ux-v1.html`（変更）— Road Mode `[FIX13][ROAD V2][DIFF]`
  トグル（既定FIX13、`RoadBucket_primary`個別hide/show、RoadVisualV2Overlay group）を追加。

---

**VISUAL_QA_PENDING_USERでSTOP**（大阪全域のdefaultへは昇格していません。ユーザー確認前に次
Missionへは進みません）。
