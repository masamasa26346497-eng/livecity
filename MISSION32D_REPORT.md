# MISSION 32D 完了報告 — MAP-SIDE ROOT CAUSE AUDIT

Building（PLATEAU/GSI/Canonical/Visual いずれも）は完全 READ ONLY。今回は道路・街区・地表側（map side）
だけを測定し、「建物が地図区画からはみ出して見える」原因を特定する**監査専用ミッション**。
原因が見つかっても**その場で補正はしない**（§30）。

最終判定: **`MAP_SIDE_ROOT_CAUSE_IDENTIFIED`**（classification: `ROAD_SEMANTICS_MISMATCH`,
`BLOCK_SEMANTICS_MISMATCH`, `MULTI_LAYER_VISUAL_CONFLICT`）

---

## §37 必須20項目

### 1. 緑線の正体
`GSI_ROAD_EDGE`（基盤地図情報 道路縁 `RdEdg`、112,199件、既定ON・常時表示）。色`0x18c37a`。
実データ内訳: 真幅道路79,602件(70.9%)／庭園路等32,364件(28.8%)／トンネル内の道路149件／徒歩道84件。
**RdEdgは「道路と道路以外の境界線」＝道路の物理的な縁を表す線**であり、PLATEAU道路区域（歩道込み）
とは別概念（Mission 31G-FIX16の既存結論を本監査で再確認）。

### 2. 灰色道路面の正体
`FIX13_ROAD_SURFACE`。実体は **Canonical Road**（199,658件、そのうち99.3%がPLATEAU tran:Road
lod1polygon由来）に`refined-road-surface.json`のrenderClassで濃淡を付けたもの。Canonical Road自体は
無変更（clip/offsetなし）、描く濃さとYだけが変わる。

### 3. blockの正体
GSI Road Edgeを壁とみなしたflood-fillで生成した**ROAD_ENCLOSED_BLOCK**（§23で正式名称化）。
parcel/lot/siteという意味は持たない。「道路で囲まれた領域」以上の法的・敷地的な意味を持たせるコードは
リポジトリ全体を静的検索した結果0件（`parcelConflationAudit.conflationFound: false`）。

### 4. 実際に通常画面へ出ているmap layers一覧
既定表示: `FIX13_ROAD_SURFACE`・`GSI_ROAD_EDGE`・`GROUND`。
既定非表示: `PLATEAU_TRAN`（Canonical Roadへ統合済み、独立layerとしては非表示）、
`OSM_ROAD`（`legacyRoot.visible=false`で構造的に隠蔽。RoadLayer.hide()も呼ばれる。二重描画なしを確認）、
`BLOCK_POLYGON`（dev専用、既定OFF）。UNKNOWN provenance = 0（目標達成）。

### 5. GSI Road Edgeの意味
「道路縁」＝道路と道路以外の境界線。真幅道路タイプ（70.9%）は実測道幅を表す。

### 6. FIX13の意味
Canonical Road（≒PLATEAU tran道路区域）をrenderClassで塗り分けた**表示専用のstyle層**。
ソースgeometryは一切変更しない。

### 7. PLATEAU tranのruntime参加状況
**独立layerとしては現行runtimeに一切参加していない。** そのpolygon geometryが Canonical Roads の
polygonCoverageRatio 0.993（99.3%）の一次sourceとして使われており、その結果がFIX13スタイルで
描画されているだけ。本監査で梅田/住吉フィクスチャ限定の`[MAP AUDIT]`トグルから直接（橙色）閲覧できる
ようにした（比較目的のみ・既定OFF）。

### 8. OSM roadのruntime参加状況
**既定で完全に非表示。** Canonical Runtimeがbase layerを所有する既定状態
（`window.__CANONICAL_RUNTIME__=true`）では`toggleOldLayers(true)`が`legacyRoot.visible=false`を
設定し`RoadLayer.hide()`も呼ぶ（静的コード確認）。FIX13/Canonical Roadsとの二重描画は無い。

### 9. map-side datasets間の位置差
**PLATEAU tran ⇄ Canonical Road（tranId厳密対応・全市198,266件突合）: 頂点位置差 median/p90/max
すべて0.00m。** ring長不一致0件。tran→canonicalパイプラインに位置・scale誤差は一切無い（最重要の
消去法的事実）。
GSI Road Edge ⇄ FIX13/tran（フィクスチャ限定サンプル）: 梅田 median 1.2-1.55m・p90 40.5-40.9m・
max 61-66m。住吉 median 0m・p90 0.01m・max 3.95-8.4m。**地域差が大きい**（下記§16参照）。
GSI Road Edge ⇄ OSM road（centerline）: 梅田 median 10.34m・住吉 median 2.59m。
これは**centerlineと道路縁の構造的な差**（概ね道幅の半分程度）であり、位置ズレのバグではない。

### 10. map-side datasets間のscale差
tranId厳密対応の頂点index直接比較で **scale差=0**（vertexCountDiff median/p90/max すべて0、
頂点位置差もすべて0）。GSI⇄FIX13/tranの差は「scale」ではなく「形状（幅）の意味の違い」に起因する
ものと判断（§14参照）。

### 11. map-side runtime transform
`gsiEdgeGroup`/`canonicalRoot`/`legacyRoot`/`blockQaGroup`/`umedaPocGroup`/`mapAuditGroup`への
非1 scale代入を静的走査した結果 **0件**。全group既定`(1,1,1)`のまま。

### 12. projection比較
GSI_ROAD_EDGE・FIX13_ROAD_SURFACE・PLATEAU_TRAN・OSM_ROAD の4データセットすべてで
`coordinateConvention: znorth-neg-v1`・同一原点（lon=135.52502, lat=34.604208）・同一式
（`config/areas/osaka-city.json`共有）を確認。**投影の不整合なし。**

### 13. block polygonization問題
GSI Road Edgeのtopological gap（Mission 32Bで確認済み）を踏まえ、32C同様「範囲全体を1枚のraster」
方式（CELL_M=1.0）で梅田・住吉フィクスチャ範囲を生成。梅田: 430 block（VALID 117/OPEN 37/AMBIGUOUS 30/
NON_BLOCK 246）。住吉: 504 block（VALID 100/OPEN 28/AMBIGUOUS 22/NON_BLOCK 354）。
既存の`gsi-road-hybrid-v1.json`（Mission 31G-FIX19系）でも`finalDecision: "HYBRID_V1_NOT_READY"`
（`seamsMostlyBroken: true`）としてGSI由来road surfaceの市全域再構築が未採用と記録されており、
本監査の結果と整合する。

### 14. semantic mismatch有無 — **本監査の最重要発見**
**あり（`ROAD_SEMANTICS_MISMATCH`）。** `roads-tran/polygons.json`の`geometrySemantics`欄には
tran:Road/lod1MultiSurfaceの定義がそのまま記録されている:
> 「道路区域（車道＋歩道を含む道路敷地）」

`tools/build-refined-road-surface.js`の分類ロジックを実データで確認した結果、highway属性・PLATEAU
detail・lodClassのいずれかを持つ道路polygonは**歩道分を切り出さずそのまま**「primary」（CARRIAGEWAY/
INTERSECTION/RAMP、濃い不透明色）へ分類される。sidewalk/median抽出は「道路属性を一切持たない断片
polygon」にのみ適用される限定的な処理。
実測: **primary分類された道路面積のうち99.0%がPLATEAU tran road-area polygon由来。**
つまり、画面上で「濃い車道色」として塗られている領域の大部分は、公式定義上すでに歩道を含む敷地全体
であり、車道の実幅より広い。**建物が道路に近接して見える主因は、この「歩道込みの道路区域が車道色で
塗られている」ことだと判断する。**

### 15. multi-layer conflict有無
**あり（`MULTI_LAYER_VISUAL_CONFLICT`）。** 梅田フィクスチャでGSI Road Edge（緑・道路縁の実測値に
近い）とFIX13/Canonical Road（歩道込みの道路区域）の間に p90で40m超・最大61-66mの乖離が測定された
（住吉ではp90 0.01m・max 3.95-8.4mとほぼ一致）。2つの「道路境界」表現が同時に描画され、地域によって
大きく食い違うため、ユーザーが「どちらが本当の道路端か」を判別しづらい状態になっている。

### 16. 梅田結果
5地点中、**地点E(西)が突出**（median 14.42m・p90 51.27m・max 61.24m）。地点A(中心)/B(北)は比較的
小さい（p90 5.05m/0.80m）。地点C(南)/D(東)は中間（p90 8.82m/29.63m）。地点間でここまで差が出る
ことは、梅田が単純な格子状街区ではなく、高架・複合施設・駅周辺構造など地点ごとに道路形状が大きく
異なるためと推測される（§32-33で示唆されていた「複合構造・地下/高架施設」の複雑さと整合するが、
本監査ではセグメント単位の構造種別までは特定していない。要目視確認）。

### 17. 住吉結果
3地点すべてでGSI⇄FIX13/tranの乖離がごく小さい（median 0m、p90 0.01m、max 3.95-8.4m）。
**都心部（梅田）特有の問題であり、住吉のような郊外住宅地では顕著ではない**という地域差が明確に
測定された。

### 18. 最終classification
`ROAD_SEMANTICS_MISMATCH`（§14）・`BLOCK_SEMANTICS_MISMATCH`（§3・ROAD_ENCLOSED_BLOCK≠parcel）・
`MULTI_LAYER_VISUAL_CONFLICT`（§15）。
`MAP_DATA_POSITION_ERROR`・`MAP_DATA_SCALE_ERROR`・`MAP_RUNTIME_TRANSFORM_ERROR`は**すべて否定**
（§9-11の厳密測定でゼロと確認）。`BUILDING_MAP_SOURCE_CONFLICT`は本監査の対象外（Building側は
READ ONLYのため測定していない）。

### 19. 根本原因候補
**最有力**: FIX13の「primary(carriageway)」分類が、PLATEAU tran road-area polygon（公式定義上
歩道を含む）をそのまま車道色で塗ってしまっている（§14）。建物がこの「歩道込みの道路区域」の縁に
近接していると、実際には歩道分の余白があっても「道路に乗っている」ように見える。
**副次的要因**: 梅田のような複雑地域ではGSI Road Edge（実測に近い道路縁）とFIX13表示の乖離自体が
大きく（§16）、2つの道路境界表現が同時に見えることも視覚的な混乱を助長している（§15）。

### 20. 次に直すべき「地図側」の1点
**FIX13のprimary(carriageway)分類ロジックに、歩道分を除外する処理を追加すること。**
具体的には `tools/build-refined-road-surface.js` の `baseClass()` が「highway属性あり→無条件で
CARRIAGEWAY」としている部分に、GSI Road Edge（真幅道路）との幅比較、またはPLATEAU tranの
車道部（TrafficArea、現状は市域858件・0.4%のみ・lod1二重計上回避でcanonical非採用と記録あり）を
使った歩道分の除外処理を追加することが最も効果が高いと考えられる。ただし**今回は補正を実施しない**
（§30）。次のミッションで着手する場合、道路データの改変を伴うため慎重な影響範囲確認が必要。

---

## visualQaStatus

**VISUAL_QA_PENDING_USER**。`[MAP AUDIT]`トグル（既定OFF）で梅田5地点・住吉3地点を実機確認してください。
`[GSI EDGE][FIX13][TRAN][OSM][BLOCK][GROUND]`の複数表示、および`[ALL][GSI only][FIX13 only]
[TRAN only][BLOCK only]`のSingle Layer Modeで切替可能。Orthographic Top Down camera
（既存のReference Alignment用orthoCameraを再利用）でparallaxを排除して確認できます。

---

## 途中で発見・修正した測定バグ（正直な開示）

- **tile境界重複の未dedup**: 初回実装でcanonical roadsのtile跨ぎ重複featureをdedupせず、
  featureCountが204,298（実際は199,658）まで水増しされていた。`seen` Setによるdedupを追加して修正。
- **頂点平均centroidのartifact**: PLATEAU tran⇄Canonical Roadの位置差測定で、単純な頂点平均による
  centroid比較を使ったところ、道路のような細長い不均等vertex密度の形状でmax 266.5mという偽の
  「位置ズレ」を検出してしまった。頂点index対応での直接距離比較へ変更し、真の値（0.00m）を得た。
- **OSM roadデータのschema不一致**: `data/processed/osaka-city/roads/tiles/`のfeatureは
  `bbox`フィールドを持たず`p`/`kind`という別schemaだったため、当初`osmRoads featureCount=0`という
  誤った結果になっていた。座標から自前でbboxを算出する形に修正。
- **自己参照的parcel conflation false-positive**: 本監査script自身のコメント・レポートnote欄
  （「parcel/lot/siteという意味は持たせない」という説明文）が、GSI Road Edgeのparcel転用チェックに
  誤ってヒットしていた（32Bのillegal Warp検出と同種のバグ）。自ファイル除外・コメント行除外で修正。

## 未使用に留めた発見（今回のミッション範囲外）

- **harnessのTHREE.ShapeUtilsスタブ欠如**: `[MAP AUDIT]`のFIX13/PLATEAU_TRAN塗りつぶしmesh生成を
  実装する過程で、テストharnessに`ShapeUtils.triangulateShape`が無いため、road/water/park/building
  roofなど`pushPolygon()`を使う**全てのpolygon-fill層が、これまでの全ミッションのdynamic testで
  一度も実際に生成されたことがなかった**（＝`residual===0`チェックがこのクラスのmeshに対しては
  常にvacuousだった）ことを発見した。実際にスタブを追加して検証したところ、既存runtime内に
  **未タグ付け（runtimeOwner=null）のmesh 2個**が独立して存在することも判明したが、これはMap Audit
  由来ではなくデフォルト初期化フローに元々存在する別の問題で、原因特定・修正には別途調査が必要。
  スタブ追加は他ミッションのtest 6件を新たに（正しく）failさせたため、本ミッションでは**revert**し、
  発見内容のみメモリ（`shapeutils-stub-missing-unmasks-untagged-residual`）へ記録した。
  §30の「監査のみ・補正はしない」の精神を、道路semantics以外の偶発的発見にも適用した判断。

---

## Canonical/Building保護の確認

- Canonical Buildings: 615,617件（不変）／Canonical Roads: 199,658件（不変）／
  refined-road-surface.json indexedCount: 30,190（不変）
- Building（PLATEAU/GSI/Canonical/Visual）のx/z/scale/height/matching/warp/clip/correctionは
  本ミッションで一切変更していない（validator `buildingMutation=0`/`buildingScaleMutation=0`/
  `buildingPositionMutation=0`）
- production (`osaka_3d_buildings.html`) / protected (`osaka_3d_buildings.fullward-v3.html`): 無変更

## npm test

**1572 tests / 1557 pass / 0 fail / 15 skip**（新規`tests/map-side-root-cause-audit.test.js`
11件含む、全体）。

## 新規ファイル一覧

- `tools/audit/map-side-root-cause-audit.js`（新規）— 本監査の測定本体。
- `tools/validate/map-side-root-cause-audit.js`（新規）— validator。RESULT=PASS。
- `tests/map-side-root-cause-audit.test.js`（新規、11テスト）— `package.json`へ登録済み。
- `data/processed/osaka-city/map-audit/`（新規）— 梅田/住吉フィクスチャ用の軽量layer export
  （`{region}-map-audit-layers.json`・`{region}-block-raster.json`）。
- `public/map-data/osaka-city/map-audit/`（新規、上記の配信用コピー）。
- `data/reports/map-side-root-cause-audit.json`（新規）— §28必須フィールド全て含む。
- `data/reports/map-side-root-cause-audit-validation.json`（新規）— validator出力。
- `public/osaka_3d_buildings.ward-ux-v1.html`（変更）— `[MAP AUDIT]`dev overlay
  （既定OFF、6layer個別ON/OFF・Single Layer Mode・Orthographic Top Down camera再利用）を追加。

---

**MAP_SIDE_ROOT_CAUSE_IDENTIFIED でSTOP**（新しい修正Missionへは進みません。ユーザー確認待ち）。
