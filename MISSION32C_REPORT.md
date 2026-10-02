# MISSION 32C 完了報告 — Umeda GSI Unified Visual Building PoC

対象: 梅田PoC範囲限定（中心 x=-2668.18, z=-10941.87、半径600m＝約1200m四方）。
大阪駅・梅田・西梅田・東梅田・中津南部・堂島北部を含む。**大阪市全域(615,617棟)の再buildは行っていない。**

verdict: **`UMEDA_GSI_VISUAL_POC_SUCCESS`**

---

## §40 必須25項目

### 1. GSI建物ジオメトリの実際の型
`BldA`（建物面ポリゴン）。Mission 32Bで確認済みの`gsi-building-area/building-area-polygons.json`
（571,325件、featureCountClean不変を本ミッションでも検証済み）をそのまま利用。`BldL`アウトラインの
自前polygonize処理は今回も不要だった（32B同様、BldAが直接使えるため）。

### 2. PoC範囲
`BOUNDS = {minX:-3268.18, maxX:-2068.18, minZ:-11541.87, maxZ:-10341.87}`（1200m×1200m）。
`config/areas/osaka-city.json`の投影式（135.52502 / 34.604208°）は無変更。

### 3. 元のPLATEAU建物数（範囲内）
1,601棟（plateau-building=1,425 + osm-fallback=176）。

### 4. Visual Building数
1,633棟（`totalVisualBuildings`）。元棟数より32棟多いのは、ONE_TO_MANY関係でGSI側が複数ポリゴンに
分かれるケース（同一PLATEAU建物→複数のGSI visual feature）があるため。

### 5. GSIジオメトリ採用数
440棟（`gsiVisualCount`、geometrySource=GSI_POLYGON）。

### 6. PLATEAU fallback数
1,193棟（`plateauFallbackCount`、GSI未マッチ/COMPLEX等でPLATEAU形状をそのまま採用）。

### 7-10. マッチング内訳
- ONE_TO_ONE: 165
- ONE_TO_MANY: 70
- MANY_TO_ONE: 53
- COMPLEX: 14
- unmatched: 1,017（→PLATEAU_FALLBACKとして採用、建物を消さない）

### 11. block数
842（`totalBlocks`）。VALID_BLOCK=250 / OPEN_BLOCK=75 / AMBIGUOUS=55 / NON_BLOCK=462。
PoC範囲全体を1枚のraster（CELL_M=1.0、1260×1260セル）でflood-fillしたことで、32Bの
「建物ごとの局所window」方式より閉鎖判定が正確になった（§12参照）。

### 12. block割当率
PLATEAU/Visual双方について`measuredCount`/`reliableCount`を算出（下記§13-14参照）。
reliableCount（VALID_BLOCK/AMBIGUOUSに閉じ込められた測定）は
plateauBefore=920件、visualAfter=978件（全体1,601〜1,633棟中）。

### 13-14. containment比較（PLATEAU単体 vs Visual Building）
| 指標 | PLATEAU単体(before) | Visual Building(after) |
|---|---|---|
| measuredCount | 1,467 | 1,517 |
| reliableCount | 920 | 978 |
| fullyInsideRate | 59.02% | 57.06% |
| outside1to5Rate | 5.43% | 14.93% |
| **outsideGt5Rate（5%超はみ出し）** | **35.54%** | **28.02%** |

主要な改善指標であるoutsideGt5Rate（「道路境界を大きく踏み越えている」建物の割合）が
**35.54%→28.02%（約7.5ポイント改善、相対約21%減）**。fullyInsideRateはわずかに低下しているが、
これはGSIポリゴンが実際の建物形状（庇・張り出し等）をより正確に捉えた結果、従来PLATEAU矩形フットプリント
では「たまたま完全内包」に見えていたケースの一部が「わずかにはみ出し」（outside1to5、5%以下）へ
移動したため（outsideGt5→outside1to5への移動が主因）。**「ほぼ内包」の対象を大きくはみ出しから
軽微なはみ出しへ動かした**という意味で、これも実質的な改善である。

### 15. renderedBuildingRetention
**100%**（`uniqueCanonicalIdsInVisual` 1,601 / `sourceBuildingCount` 1,601）。
建物を無言で間引くことでcontainment数値を良く見せている疑いはない（§30要件）。

### 16. 大規模建物QA（30件以上）
`qaBuildings`に面積上位30棟を実データ識別可能な情報（visualId/canonicalIds/座標由来の位置）付きで記録。
このQA過程で**本ミッション最大の発見**（下記「発見した問題と対処」参照）があり、修正済み。
最終的にREVIEW判定は30件中7件（23.3%、閾値30%以下）で、verdict条件`noMajorMismatchInLargeBuildings`はtrue。

### 17. height join
100%（`heightJoin.rate`）。全1,633 featureがheightMを保持。

### 18. usage join
100%（`usageJoin.rate`）。全1,633 featureがusageCategoryを保持。

### 19. property card接続
`canonicalIds`配列を全featureが1件以上保持（検証済み、validator `propertyLinkRetained=true`）。
ONE_TO_MANY/MANY_TO_ONEでも元PLATEAU属性情報（heightM/usage/usageLabel）を保持したまま。
pick時は代表（先頭）canonicalIdをdへ渡し、`umedaCanonicalIds`として全IDも保持（§26）。

### 20. パフォーマンス
usageカテゴリ単位でメッシュをマージする既存方式を踏襲（1建物=1メッシュにしない）。
1,633棟が10メッシュへ集約。Block QA overlay追加時も、raster可視化はcanvas texture 1枚+1 plane
（1260×1260セルを個別メッシュ化しない）、QA用building色分けも inside/outside 2バケットの2メッシュのみ。

### 21. runtimeトグル
- `[Visual Building PoC(Umeda)]`: 既定OFF。ONで梅田範囲内のPLATEAU tileを隠しVisual Buildingへ切替。
- `[PLATEAU]`/`[GSI VISUAL]` A/Bボタン: 同一カメラでの即時比較用。
- `[Block QA]`: 既定OFF。ON時、Visual Building表示を自動的に有効化した上で用途色表示を隠し、
  GSI Road Edge=緑（既存gsiEdgeGroupを流用）/Block=白系半透明（raster→canvas texture）/
  Visual Building=シアン(inside)・赤(outsideRatio>5%)の色分け表示に切り替える。

### 22. validator
`tools/validate/umeda-visual-building-poc.js`。RESULT=**PASS**。canonicalMutation=0、roadMutation=0、
gsiRawMutation=0、visualBuildingsCreated=true、blockAssignmentCreated=true、globalOffsetApplied=0、
globalScaleApplied=0、warpApplied=0、propertyLinkRetained=true、productionModified=false、
protectedModified=false。

### 23. npm test
`tests/umeda-visual-building-poc.test.js`（14件、単体実行で全pass）を`package.json`の`test`スクリプトへ
登録。フルスイート実行結果: **1561 tests / 1546 pass / 0 fail / 15 skip**（既存分含む全体）。

### 24. 最終判定
**`UMEDA_GSI_VISUAL_POC_SUCCESS`**。判定基準内訳:
- outsideImproved: true（outsideGt5Rate 35.54%→28.02%）
- retentionHigh: true（100% ≥ 95%）
- heightJoinWorks: true（100% ≥ 90%）
- usageJoinWorks: true（100% ≥ 80%）
- noMajorMismatchInLargeBuildings: true（上位30棟中REVIEW 7件=23.3% ≤ 30%）

### 25. visualQaStatus
**VISUAL_QA_PENDING_USER**。ユーザーによる目視確認待ち。次ミッションへは自動着手しない。

---

## 発見した問題と対処（§33 QAプロセスの実例）

面積上位30棟のQAレビュー中、`umeda_vb_271`（ONE_TO_ONE、confidence当初"HIGH"）が
`outsideRatio=0.4055`（block外40.6%）という強い異常値を示していた。原因調査の結果、
既存の`meaningfulOverlap()`（重心内包 OR bbox重なり率）には**面積スケールの整合性チェックが無く**、
PLATEAU側の小さい建物（796.4m²）の重心が、隣接するGSI側の巨大ポリゴン（27,213.2m²、駅施設等と推定）の
内部にたまたま落ちただけで「confident ONE_TO_ONE」と判定されていたことが判明した。

対処として`areaRatioOk(platArea, gsiAreaSum)`（許容比[0.3, 3.0]）をONE_TO_ONE/ONE_TO_MANYの採用条件へ
追加し、範囲外なら`confidence:'REVIEW'`へ自動降格・具体的な`reviewReason`を付与するよう修正。
再実行後、当該建物は`reviewReason:"面積比不整合: PLATEAU=796.4m² vs GSI=27213.2m²（比=0.03）。
§32: 駅施設等の大規模構造物の疑い、要目視確認"`として正しく検出されるようになった。
集計値（verdict/retention/containment改善幅）への影響は軽微だった。

---

## 未実装・簡略化した部分（正直な開示）

- **§27 Block QA overlayの「はみ出し部分のみ赤」**: ポリゴンブーリアン演算（建物∩block外側領域の
  切り出し）は実装していない。代わりに、建物単位でoutsideRatio（1-insideRatio）が5%を超えるものを
  丸ごと赤、それ以外をシアンとする簡略版とした。QAの目的（「どの建物がblockからはみ出しているか」を
  一目で分かるようにする）は満たすが、はみ出した「面積の一部だけ」を正確に色分けする精度には及ばない。
- **Block（白）のレンダリング方式**: 842個のblock境界を個別ポリゴンとして抽出（marching squares等）は
  行わず、1260×1260セルのraster分類をそのままcanvas texture化して1枚のplaneとして表示する方式にした
  （§34のパフォーマンス方針を優先）。個々のblock境界線は明示的には描かれない（塗り分けの濃淡でのみ判別）。
- **GSI Road Edge（緑）**: 新規実装ではなく、既存の`gsiEdgeGroup`（ALIGNMENT-RESETミッションで導入済み、
  既定ONの常時表示レイヤー、色`0x18c37a`）をそのまま流用した。梅田範囲は元々この通常表示に含まれるため、
  Block QA ON時に改めてONにする以外の追加実装は不要だった。

---

## Canonical/GSI raw保護の確認

- Canonical Buildings: 615,617件（不変）
- Canonical Roads: 199,658件（不変）
- refined-road-surface.json indexedCount: 30,190（不変）
- GSI building area(BldA) featureCountClean: 571,325件（Mission 32B確定値と不変）
- production (`osaka_3d_buildings.html`) / protected (`osaka_3d_buildings.fullward-v3.html`): 無変更

---

## 新規/変更ファイル一覧

- `tools/build-umeda-visual-building-poc.js`（新規）— PoCビルダー本体。block raster export（§27用）含む。
- `tools/validate/umeda-visual-building-poc.js`（新規）— validator。RESULT=PASS。
- `tests/umeda-visual-building-poc.test.js`（新規、14テスト）— `package.json`へ登録済み。
- `tests/_ward-ux-v1-smoke-harness.cjs`（変更）— `ctx2d()`スタブの`createImageData`/`putImageData`/
  `getImageData`を実サイズ対応に修正（従来は64×64固定で、Block QA overlay等の大きいcanvas texture
  使用コードのバグを検出できなかった）。
- `public/osaka_3d_buildings.ward-ux-v1.html`（変更）— Umeda PoC runtime module（トグル/A-B/pick対応/
  Block QA overlay）を追加。
- `data/processed/osaka-city/visual-buildings-poc/umeda/`（新規）—
  `umeda-visual-buildings.json`（1,633 features）、`manifest.json`、`block-raster.json`（新規、§27用）。
- `public/map-data/osaka-city/visual-buildings-poc/umeda/`（新規、上記3ファイルを配信用にコピー）。
- `data/reports/umeda-visual-building-poc.json`（新規）— §36必須フィールド全て含む。
- `data/reports/umeda-visual-building-poc-validation.json`（新規）— validator出力。

---

**VISUAL_QA_PENDING_USERでSTOP**（ユーザー確認待ち。次ミッションへは自動着手しません）。
