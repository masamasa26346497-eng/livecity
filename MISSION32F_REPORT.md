# MISSION 32F 完了報告 — UMEDA VISUAL LAND BLOCK PoC

Building（移動/scale/footprint/clip/warp）・Canonical Road・raw GSI・Projection・Originは一切変更して
いない。ROAD V2（Mission 32E成果物）を道路の正本として使い、その上に「道路に囲まれた土地側」＝
**VISUAL LAND BLOCK**（≠ Parcel/Lot/筆界/敷地境界）を新規生成し、既存表示に重ねるPoC。梅田PoC範囲
（Mission 32C以来の既存bounds再利用）限定。大阪全域生成は行っていない。

最終判定: **`VISUAL_LAND_BLOCK_POC_SUCCESS`**

---

## §39 必須20項目

### 1. Land Block生成方法
raster mask（road/water除外）→ 4連結flood-fillでconnected components抽出 → tiny fragment/sliver除去 →
セル境界追跡（boundary-edge tracing、marching squares相当の簡易版）でvector化。repo内にpolygon
boolean/polygonizeライブラリが存在しないことを確認した上で採用（§6）。

### 2. resolution/vector方式
0.5m/1.0m/2.0mを比較した結果、componentCount（341/339/329）・tinyCount（119/121/120）ともほぼ差が
なかったため、既存ミッション（32C/32D/32E）と精度基準を揃える**1.0m**を採用。vector化は「セル境界を
そのままpolygon辺にする」階段状ポリゴン方式（正確なmarching squaresの補間はしていない。1m解像度なら
視覚上の影響は軽微と判断）。

### 3. Block数
**178件**（有効block。tiny 119件・sliver 2件を除去後）。

### 4. tiny/sliver数
tiny（面積<15m²）**119件**・sliver（面積<40m²かつaspect比>25）**2件**。raw component数299件のうち
40.5%がtiny/slivered。§28のfragmentation判定基準（tiny+sliverが全体の70%未満）はクリア。

### 5-9. Building containment
| 指標 | 件数 |
|---|---|
| total | 1,668 |
| inside99（insideRatio≥0.99） | 827 |
| inside95（0.95-0.99） | 53 |
| inside80（0.80-0.95） | 150 |
| below80（<0.80） | 638 |

classCounts（§14分類）: FULLY_INSIDE=827／MOSTLY_INSIDE=319／CROSSES_BLOCK=133／
**ROAD_CONFLICT=365**／SPECIAL_STRUCTURE=23／UNKNOWN=1。

### 10. Building∩Road V2
overlapRatio=**0.0616**（totalBuildingArea 611,025m²、resolved carriagewayとの重なり37,644m²）。
Mission 32Eの梅田site実測（overlapRatioV2=0.0565）とおおむね整合（fixture半径500m vs 本PoC範囲600m
の違いによる小差、SUCCESS判定基準の「32E実測から大きく乖離しない(<0.15)」はクリア）。

### 11. raw GSI Edge OFF効果
`[LAND BLOCK]`モードON中は既存の`[GSI Road Edge]`トグルを自動的にOFFへ切り替える実装を追加
（§4）。実ブラウザでの目視比較は未実施だが、ロジック上「濃い緑の生GSI線」が区画線のように見える
主要因の一つが構造的に排除されることは確認済み。定量的な「違和感減少度」は本レポート作成時点では
測定していない（visualQaStatus参照）。

### 12. FIX13比較
`[A:FIX13]`モード（既存の全面dark primary表示）が引き続き選択可能。Mission 32Eで実測済みの
Building∩DarkRoad改善（梅田76.7%削減）はそのまま維持（ROAD V2自体は本ミッションで一切変更していない、
roadV2Mutation=0で確認）。

### 13. ROAD V2比較
`[B:ROAD V2]`モードは32Eと同一の描画（carriageway=dark／margin・uncertain=淡色）。今回はこれに
Land Blockを重ねた`[C:+LAND BLOCK]`との対比が主眼。

### 14. ROAD V2+LandBlock比較
`[C:+LAND BLOCK]`モードでは、ROAD V2の描画（§13と同じ）に加え、道路に囲まれた土地側を薄いニュートラル
色（§19: 0xd6d0bc、派手なdebug色は不使用）で重ねる。境界線は太く引かない（§20）。実機での自然さの
最終判断はユーザー確認待ち。

### 15. Picking/property
Building geometry・footprint・座標を一切変更していないため、既存のhover/click/property cardの経路は
無変更（§31）。Land Block/QAオーバーレイは既存の`tileCache`（buildingsレイヤー）の`footprints`を
**再利用するだけ**で、building独自のgeometry再構築は行っていない（テストで静的確認済み）。

### 16. performance
Land Block本体は**全block合計1 mesh**（merged geometry、§32遵守）。QA表示の建物色分けも
inside/conflictの2 mesh（1-block-1-meshにしていない）。配信データは6.6MB（blocks.json + 
building-assignment.json、opt-in・既定OFF）。

### 17. validator
`tools/validate/umeda-visual-land-block-poc.js`。RESULT=**PASS**。buildingMutation=0、
buildingScaleMutation=0、buildingPositionMutation=0、canonicalRoadMutation=0、roadV2Mutation=0、
visualLandBlocksCreated=true、rawGsiEdgeHiddenInNormalPoc=true、buildingRetention=100%、
productionModified=false、protectedModified=false。

### 18. npm test
`tests/umeda-visual-land-block-poc.test.js`（11件）を`package.json`へ登録。フルスイート実行結果:
**1593 tests / 1578 pass / 0 fail / 15 skip**（既存分含む全体）。

### 19. production/protected unchanged
`public/osaka_3d_buildings.html` / `public/osaka_3d_buildings.fullward-v3.html` ともhash baseline
と一致、無変更を確認。Canonical Buildings=615,617／Canonical Roads=199,658／
refined-road-surface.json indexedCount=30,190／ROAD V2 uniqueFeatureCount=169,468、すべて不変。

### 20. verdict
**`VISUAL_LAND_BLOCK_POC_SUCCESS`**（verdictCriteria: notFragmented=true・retentionFull=true・
mostlyContained=true・roadOverlapConsistentWith32E=true・geometryValid=true、すべて満たす）。

---

## 設計の核心的な発見と変更（正直な開示）

**最重要**: 当初は§8の「最低限」の指示通り、道路maskをROAD V2 carriageway（resolved、HIGH/MEDIUM
confidenceのみ）だけで構成したところ、実データで検証した結果、**梅田PoC範囲(1200m×1200m)がほぼ1個の
巨大component（1,401,969m²、範囲全体の約97%）になってしまった**。原因はROAD V2のresolved率が
citywide約30%に留まる（Mission 32E実測）ため、残り約70%の「UNCERTAIN_ROAD_SURFACE」区間に壁が無く、
flood-fillが街区の境目を越えて漏れたこと。

ROAD V2の「UNCERTAIN」分類は「濃い車道色で塗るには確信が持てない」という**表示上の判断**であり、
Canonical Road（PLATEAU tran）自体が「道路の一部」と分類していることを否定するものではない。この
区別に基づき、**block分離の壁にはprimary bucket全体（resolved carriageway + uncertain、= ROAD V2
tileのenvelope）を使う**よう設計を変更した。実際に濃く塗るcarriagewayだけの重なり測定（§10/§17 KPI）
は、壁とは別のmaskで独立して行っている。

この変更により、raw component数が84→299、有効block数が17→178へ増加し、地図として意味のある街区
分割が得られるようになった。

## 途中で発見した限界（正直な開示・修正はしていない）

- **ROAD_CONFLICT=365件（21.9%）**: block分離の壁がprimary bucket全体（uncertain含む）を使うため、
  「壁との重なり」判定は32Eの「濃い車道色との重なり」より保守的（広め）になっている。つまり
  ROAD_CONFLICTに分類された建物が、実際の画面上で「濃い車道色に乗っている」とは限らない（uncertain
  = 淡色表示のエリアに重なっているだけの可能性がある）。この解釈の違いを認識した上で使う必要がある。
- **lblk_0（最大block、330,376m²）はPoC範囲境界に接している**（`boundaryTouchingCount=13`）。
  範囲外に道路網が続いている可能性があり、実際の街区としては細分化される可能性がある。32C/32Dの
  OPEN_BLOCK概念と同じ注意点。
- **階段状ポリゴン**: vector化は1mグリッドのセル境界をそのままpolygon辺にする簡易方式のため、
  block境界を拡大すると微小な階段状のギザギザが見える（マージンとして塗りつぶし表示なので通常視認
  距離ではほぼ影響ないと判断したが、アウトライン表示をした場合は目立つ可能性がある）。
- **実機ブラウザでの目視QA未実施**（下記visualQaStatus参照）。

---

## visualQaStatus

**VISUAL_QA_PENDING_USER**。実ブラウザで`public/osaka_3d_buildings.ward-ux-v1.html`を開き、
status panel内の「Road Mode: [A:FIX13][B:ROAD V2][C:+LAND BLOCK][DIFF]」および「[LAND BLOCK QA]」
ボタンで梅田周辺を確認してください。特に:
1. Cモード（ROAD V2 + LAND BLOCK）で、建物が土地側に自然に収まって見えるか
2. raw GSI Road Edgeが自動的に消え、違和感が減るか
3. Orthographic Top Down（既存のReference Alignment/Map Audit用カメラを流用可能）でも同様の確認
4. `[LAND BLOCK QA]`で inside(cyan)/conflict(red) の分布が妥当に見えるか（特にROAD_CONFLICT
   365件が実際にどう見えるか）

---

## Canonical/Building/ROAD V2保護の確認

- Canonical Buildings: 615,617件（不変）／Canonical Roads: 199,658件（不変）／
  refined-road-surface.json indexedCount: 30,190（不変）／ROAD V2 uniqueFeatureCount: 169,468（不変）
- Building（移動/scale/footprint/clip/warp）は本ミッションで一切変更していない
- production (`osaka_3d_buildings.html`) / protected (`osaka_3d_buildings.fullward-v3.html`): 無変更

## 新規/変更ファイル一覧

- `tools/build-umeda-visual-land-block-poc.js`（新規）— Visual Land Blockビルダー本体。
- `tools/validate/umeda-visual-land-block-poc.js`（新規）— validator。RESULT=PASS。
- `tests/umeda-visual-land-block-poc.test.js`（新規、11テスト）— `package.json`へ登録済み。
- `tests/road-visual-v2.test.js`（変更）— Road Modeボタン配列がLAND_BLOCK追加で変わったための
  既存テスト更新（4ボタン化: A:FIX13/B:ROAD V2/C:+LAND BLOCK/DIFF）。
- `data/processed/osaka-city/visual-land-block-poc/umeda/`（新規）— `blocks.json`（178block）、
  `building-assignment.json`（1,668棟の所属・containment）。
- `public/map-data/osaka-city/visual-land-block-poc/umeda/`（新規、配信用コピー、6.6MB）。
- `data/reports/umeda-visual-land-block-poc.json`（新規）— §33必須フィールド全て含む。
- `data/reports/umeda-visual-land-block-poc-validation.json`（新規）— validator出力。
- `public/osaka_3d_buildings.ward-ux-v1.html`（変更）— Road Modeへ`[LAND BLOCK]`（4つ目のモード、
  §18の[LAND BLOCK POC]相当）を統合、`[LAND BLOCK QA]`トグル追加。既定はFIX13のまま。

---

**VISUAL_QA_PENDING_USERでSTOP**（次Missionへは自動的に進みません。ユーザー確認待ち）。
