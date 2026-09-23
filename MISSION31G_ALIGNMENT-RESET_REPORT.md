# Mission 31G-ALIGNMENT-RESET 完了報告｜都市配置基盤を一から再構築

**最終ステータス: `VISUAL_QA_PENDING_USER`**（§28/§33 の要求どおり、validator PASS のみでは完了とみなさない。
実機スクリーンショットによるユーザー確認が別途必要）

---

## 0. 要約

FIX24（NEAR建物をCanonical原形へ）を実施してもなお「建物がずれて見える」というユーザー報告を受け、
今回は「建物を道路へ合わせる」対症療法をやめ、**(1) 建物と道路以外の全レイヤーをscene構造そのもので
分離する仕組み、(2) 道路境界の正本をPLATEAU道路区域面からGSI道路縁へ切り替える仕組み、(3) 位置精度を
第三者の目で検証できるReference Alignment Mode（真のOrthographic・cyan/magenta/green）**の3本柱で
表示基盤を再構築した。建物のx/y/z座標は本ミッションでも一切変更していない。

---

## 1. 旧表示でずれて見えた主原因候補

FIX24までに「建物ジオメトリそのもののずれ」は明確に否定済み（24区GSI比較でNO_SYSTEMATIC_BUILDING_SHIFT・
median dx/dz≈0）。今回の作業を通じて新たに浮かび上がった、より説得力のある候補は次の2つ:

1. **道路の視覚境界がPLATEAU tran道路区域面（実舗装より広い都市計画決定幅・31E finding #2で既知）に
   依存していたため、建物の隣に「実際より広い」道路面が描かれ、結果として建物が道路へ食い込んで
   見えていた可能性。** 今回GSI Road Edge（基盤地図情報・実測の道路縁）を authoritative outline として
   追加したことで、この「道路面が広すぎる」問題を目視で判別できるようになった（§7-13参照）。
2. **Legacy描画系の残存が、ownershipタグ漏れや個別layer.hide()のバグ（FIX19C/FIX23で複数回発生）により
   偶発的に画面へ混入していた可能性。** 今回のscene root構造分離により、この種のバグが今後発生しても
   画面には一切影響しなくなった（§3-6参照。診断上のresidualと実際の視覚汚染を構造的に分離）。

いずれも「建物を動かす」話ではなく「建物の周りに何を、どこまで正確に描くか」という表示側の問題であり、
mission方針（§0: 建物は動かさない）と整合する。

## 2. canonicalRoot 構成

```js
const canonicalRoot = new THREE.Group(); canonicalRoot.name = 'canonicalRoot';
```
scene直下に1つだけ存在。配下:
- `rtRoot`（CanonicalRuntimeRoot。既存のwater/roads/buildings/parks/railタイルgroup全て）
- `gsiEdgeGroup`（GsiRoadEdgeAuthoritative。新規のGSI道路縁レイヤー）
- `HybridV1Normal`（既存のGSI Hybridロード面・任意トグル）

全てownership markerもCANONICALで二重に保護（構造＋タグの両方）。

## 3. legacyRoot 構成

```js
const legacyRoot = new THREE.Group(); legacyRoot.name = 'legacyRoot';
```
scene直下に1つだけ存在。配下（`toggleOldLayers()`が管理する「Canonicalで置換される旧描画系」）:
- RoadLayer（旧OSM道路）のgroup
- 旧tran道路デモ（`SHOW_TRAN_ROADS`。既定OFFで死コードだが将来のトグル復活に備えて同様に分離）
- 旧`gnd`巨大平面地表（`SHOW_LEGACY_GROUND`制御）
- StreetscapeLayer（道路際ディテール）のgroup
- RiverLayerV2（旧河川）のgroup
- ParkLayer（旧公園）のgroup
- BuildingTileLayer の共有mesh builder（embedded/remote tile 双方が通る建物壁/天井/エッジ生成箇所）
- CityTileLayer（遠景roads/waterways/parks/railways）のgroup
- CityBuildingLOD（遠景建物mesh）のgroup

計21箇所の`scene.add`直書きを`legacyRoot.add`へ移行（対応する`scene.remove`/`scene.children.includes`も
同じ範囲でlegacyRootへ揃えた）。ライト（Hemisphere/Directional/Ambient/Point）は明示的に対象外
（Object3D.visible=falseは照明への寄与も止めてしまうため、legacyRoot配下に入れると照明ごと消える）。

## 4. visible Legacy before/after

**Before（FIX23までの設計）**: 「診断上のresidual検出（`classifyLegacyResidual`の再帰traverse+ownershipタグ
判定）」だけが画面混入の防波堤だった。このため、タグ付け漏れ（例: `StreetscapeLayer`がFIX23まで未接続）や
個別layer.hide()自体のバグ（例: FIX19Cの`disposeDataset`ID不一致）が起きると、residualが0と表示されて
いても実際には画面に描画され続ける、または逆にresidualは非0でも実害が無い、という**診断と実態の食い違い**
が複数回発生していた（FIX23/23B/23Cの一連の作業で繰り返し発覚・修正）。

**After（今回の実装）**: `toggleOldLayers(hidden)`の冒頭で`legacyRoot.visible = !hidden`を必ず実行する。
これは個々のlayerのhide()/show()が正しく動いているかに一切依存しない**構造的な最終防御**であり、
たとえ将来また同種のタグ付け漏れ・disposeバグが発生しても、Canonical所有中は`legacyRoot`配下の
オブジェクトが物理的にレンダリングされない（`Object3D.visible=false`は子孫も含めてrenderツリーから
除外されるThree.jsの標準動作）。動的検証（harness実測）で、Reference Alignment ON/OFF・6地点切り替え・
起動直後のいずれでも`Legacy residual: 0`を確認済み（§17参照）。

## 5. RoadLayer が Canonical 画面から完全に消えたか

**構造的にYES。** `RoadLayer.build()`が生成する`group`は`legacyRoot.add(group)`でのみscene tree入りし、
`legacyRoot.visible=false`（Canonical所有中）であれば、RoadLayer自身の`show()`/`hide()`のロジックが
正しく動いているかに関わらず画面に描画されない。これはFIX23Cで最後まで原因を特定しきれなかった
「実機で18件のroadKey residualが残る」問題（診断上の話）とは独立に、**視覚的な混入だけは今回の変更で
確実にゼロになる**という意味。ただしFIX23Cの診断residual自体（`classifyLegacyResidual`が拾う件数）の
解明は本ミッションのスコープ外のまま（§23参照・「diagnostic residualとvisual contaminationを分離する」
というミッション方針どおり）。

## 6. Building source

`plateau-building`（Canonical Buildings・615,617 feature・本ミッションで無変更）。FIX24のNEAR tier
exact footprint（tolM=0）もそのまま維持（validatorで再確認済み）。

## 7. Road edge source

GSI基盤地図情報「道路縁」（RdEdg）。FIX16で正規化済みの`road-edge-lines.json`（112,199 feature・
znorth-neg-v1・座標/属性とも無加工）を、新規`tools/build-gsi-road-edge-tiles.js`で500mタイルへ
再配置しただけ（simplify/buffer/snap/pair/polygonizeは一切行っていない）。

## 8. GSI Road Edge 表示件数

- distinctFeatureCount: **112,199**（タイル境界重複を含む延べ配置件数: 131,350・重複率約17%は
  タイル境界を跨ぐラインの二重収録によるもので、実データの重複ではない）
- タイル数: **1,043**（500mグリッド）
- 公開データサイズ: **1,044ファイル / 約44.0MB**（`public/map-data/osaka-city/derived/gsi-road-edge/`）
- Runtime描画: tile単位で1つの`THREE.LineSegments`へmerge（§31「1 road = 1 mesh禁止」を遵守）。
  camera近傍(既定reach 1600m)のみ段階的にfetchし、全大阪一括ロードは行わない。

## 9. Road Surface hierarchy

- **面（fill）**: FIX13 `refined-road-surface.json` をそのまま維持（本ミッションでは無変更。
  CARRIAGEWAY/SIDEWALK/MEDIAN等のtaxonomyは既存のまま）。
- **境界線（boundary/outline）**: 新規のGSI Road Edge authoritative layer（明緑・tile-merge）。
  既定ON（通常表示でも表示。§22「薄いroad fill + GSI edge」に対応）。
- FIX17-19のGSI Hybrid Surface再構成（v2/v3・corridor DP）は`HYBRID_V1_NOT_READY`判定のまま
  （開発者向けroad-mode切替トグルとしては引き続き利用可能・通常表示のデフォルトには採用していない）。
  今回は複雑なsurface再構成に手を広げず、「まず道路縁を正確に描く」という§9の優先順位どおり
  authoritative outlineの追加に絞った。

## 10-13. 6地点の実測結果

全地点、半径600m以内のcanonical building footprintとGSI Road Edgeの関係を実測（§19/§20、
道路側/街区側の推定はしていない＝「頂点→最寄りedge距離」と「footprint辺とedge辺の幾何学的交差」
のみを計測）。

| 地点 | 中心座標(x,z) | GSI edge本数 | 建物数 | 最寄edge距離 中央値/p95/max (m) | 交差棟数 |
|---|---|---|---|---|---|
| 梅田 | (-2668.18, -10941.87) | 2,225 | 1,016 | 2.26 / 45.82 / 81.31 | 415 (40.8%) |
| 中之島 | (-2695.66, -9962.25) | 1,926 | 1,443 | 2.06 / 28.35 / 62.37 | 677 (46.9%) |
| 本町 | (-2072.6, -8693.2) | 1,548 | 2,100 | 2.90 / 21.31 / 52.52 | 940 (44.8%) |
| 難波 | (-2173.39, -6511.33) | 1,416 | 2,870 | 2.05 / 20.56 / 84.12 | 1,347 (46.9%) |
| 天王寺 | (-1055.54, -4618.89) | 2,646 | 2,405 | 2.29 / 22.10 / 53.99 | 1,030 (42.8%) |
| 住吉 | (-2952.22, -811.75) | 2,015 | 5,847 | 1.79 / 14.26 / 43.97 | 2,546 (43.6%) |

**正直な所見**: 交差棟の割合が40〜47%と、想定より高い。中央値距離が1.8〜2.9mと「建物は道路のすぐ
近くにある」という自然な結果と整合する一方、交差率の高さは以下のいずれか、または複合と考えられる
（本セッションでは断定できないため列挙のみ）:
- 大阪の密集市街地では建物が路地・私道境界へセットバック無しで接しているケースが多く、GSI道路縁
  ネットワーク自体が非常に密（狭い路地・庭園路タイプの境界まで収録・FIX16で判明済み）であるため、
  建物際でfootprint辺とedge辺が幾何学的に交差すること自体は珍しくない可能性。
- GSI edgeの交差点付近のフラグメント化・ノイズ（FIX16-18で既知の弱点）が、building footprintの
  角付近で偶発的な交差を生んでいる可能性。
- 上記いずれでもない、未発見の要因。

**この指標は「建物が道路に食い込んでいる」ことの確定的な証拠ではない**（§20遵守：道路側の推定をして
いないため）。実機でのReference Alignment Mode目視確認が必須という結論を補強する数値として記録する。

## 14. Building vs GSI Road Edge 結果（city-wide sample）

40,000棟のcity-wideサンプル（996タイル中GSI coverageのあるタイルから均等抽出）:
中央値2.07m / p90 17.99m / p95 29.36m / 最大316.26m（`data/reports/alignment-reset.json`
`cityWideSample`参照）。6地点個別の中央値（1.8〜2.9m）とほぼ整合しており、site選定に極端な偏りは
無いと判断できる。

## 15. Orthographic 結果

新規`orthoCamera`（`THREE.OrthographicCamera(-400,400,400,-400,1,6000)`）を導入し、Reference
Alignment Mode中は`renderer.render(scene, activeCamera())`が既存Perspective camera(`camera`)では
なくこちらを選択する。`up=(0,0,-1)`でThree.z(南北)を画面上「北=上」に固定。site選択時は
`setOrthoAlignmentView(x,z,350)`で対象地点の真上(y=3000)から見下ろす。**parallaxを構造的に排除**
（近似ではなく、実際に透視投影を使わない）。harness動的テストで6地点全ての切替が例外なく往復できる
ことを確認済み（実際のレンダリング画素は本セッションでは確認できていない＝実機QA必須）。

## 16. Perspective 結果

通常UIは`activeCamera()`が`isReferenceAlignmentActive()===false`の間は常に既存`camera`
（Perspective）を返すため、**通常表示の挙動・cs駆動のcamUpd()ロジックは一切変更していない**。
Reference Alignment ModeをOFFにすると即座にPerspectiveへ復帰する。§17の「混同しない」という
要求を、実装レベルで排他的な`activeCamera()`選択として保証した。

## 17. Performance

- GSI Road Edge tile: 1,043タイル / 約44.6MB（processed）・約44.0MB（public、圧縮差はごく僅か）。
  1タイル平均約44KB、既存near/buildingsタイル(平均358KB)より大幅に軽い。
- 公開データ総量: **721.8MB / 5,781ファイル**（FIX24完了時点677.8MB/4,737ファイルから、GSI Road
  Edge分＋44MB/1,044ファイルの増分。§26「FIX7の性能改善を壊さない」に対し、増分は既存最大レイヤー
  (near/buildings 444MB)の1/10程度に収まっている）。
- 実フレームp95・draw calls・メモリは**未測定**（本セッションはブラウザ不可）。GSI edge layerは
  tile-merge済みLineSegmentsのため追加draw callはタイル数に比例するオーダーで、既存roadsタイルの
  draw call数に対し無視できない増分ではないと推定するが、実測ではない点を正直に記す。

## 18. Validator

`node tools/validate/alignment-reset.js` → **RESULT: PASS**（全チェックtrue/0。
`directLegacySceneAdd=0`・`buildingGeometryMutation=0`・`roadGeometryMutation=0`・
`geometryMutation=0`・`productionModified=false`・`protectedModified=false`）。

既存の関連validator（`legacy-residual-guard`・`derived-geometry`・`building-exact-near-alignment`・
`gsi-building-alignment`）も全てPASSを再確認（collateral damageの裏取り）。

## 19. npm test

```
ℹ tests 1519
ℹ pass 1504
ℹ fail 0
ℹ skipped 15
EXIT=0
```
FIX24完了時点のベースライン（1506 tests/1491 pass）から、新規`tests/alignment-reset.test.js`
（13件、全PASS）分だけ純増。既存テストの退行は最終的に0件（作業中に一時的に3件（Mission19/20/25の
render loop literal検査）が`renderer.render(scene, activeCamera())`への変更で失敗したが、これは
意図した変更に対するテスト側の追随漏れであり、該当テストの正規表現を更新して解消した。詳細は
「作業中に発見・修正した副産物」参照）。`tests/_ward-ux-v1-smoke-harness.cjs`の実scene graph実装も
維持（スタブ化していない）。

## 20. Visual QA status

**`VISUAL_QA_PENDING_USER`。** 実機ブラウザでの確認が必須の項目:
1. 通常表示（Perspective）でGSI Road Edge（緑の細線）が道路境界に沿って見えるか、旧PLATEAU道路区域面
   より妥当な位置に見えるか。
2. Reference Alignment Mode（画面右下ステータスパネル内の `[Reference Alignment]` ボタン + サイト
   選択）で梅田・中之島・本町・難波・天王寺・住吉の6地点を開き、cyan(PLATEAU footprint)・
   magenta(GSI Building Outline)・bright green(GSI Road Edge)の重なり方を目視確認。
3. Legacy residual表示が引き続き0のままか（構造変更後の実機確認）。
4. §17の交差棟が高い割合で検出された地点（特に住吉43.6%・難波46.9%）を重点的に確認し、実際に
   「建物が道路に食い込んで見える」のか、単に密集市街地の自然な近接なのかを判断。

---

## 作業中に発見・修正した副産物（透明性のため報告）

1. **test harnessの`Object3D.add()`がmulti-arg(`add(a,b,c)`)非対応だった実バグを発見・修正。**
   実three.jsは`add(a,b,c,...)`をサポートするが、`tests/_ward-ux-v1-smoke-harness.cjs`のstubは
   単一引数のみ対応で、`scene.add(canonicalRoot, legacyRoot, debugRoot, uiRoot)`と書いた際に
   2つ目以降が静かに無視される（＝実ブラウザでは動くのにテストだけ食い違う）ことが発覚。
   `add(...objs)`へ拡張し、実装の本質（実際にchildrenへpushする）は変えずシグネチャだけ実three.js
   準拠にした。関連する既存の静的検査（`tools/validate/legacy-residual-guard.js`の
   `sceneGraphHarnessActive`チェック）も、旧シグネチャの完全一致文字列に依存していたため
   副作用実体（`this.children.push(obj); obj.parent = this;`）による判定へ更新した。
2. **`window.__GSI_ROAD_EDGE_DEBUG__`の命名衝突を回避。** FIX15/16で既に同名のsample限定デバッグ
   関数が定義されており、同名で再定義すると後方の代入で本機能が静かに消える実バグになるところ
   だった。`__GSI_ROAD_EDGE_AUTHORITATIVE_DEBUG__`という別名にして解消（実際に動的テストで
   一度発覚・確認した上で修正）。
3. **`renderer.render(scene, camera)` → `renderer.render(scene, activeCamera())`への変更に伴う
   3件のテスト退行を検出・修正。** Mission19/20/25の一部testが完全一致の正規表現でrender loop
   本体を検証していたため、意図した変更が退行として検出された。正規表現を`camera|activeCamera\(\)`
   の両方を許容する形へ更新（`tools/lib/performance-budget.js`の`extractRenderLoopBody`も同様）。

---

## 完了チェックリスト（§37対応）

- [x] canonicalRoot / legacyRoot / debugRoot / uiRoot 分離
- [x] Canonical mode visible legacy = 0（構造的保証。動的テストで確認）
- [x] Legacy RoadLayer視覚混入0（legacyRoot経由に統一）
- [x] PLATEAU exact buildings維持（FIX24のtolM=0を再確認）
- [x] GSI Road Edgeを道路境界の authoritative outline として追加（tile化・city-wide配信）
- [x] Reference Alignment mode（cyan/magenta/green・6地点選択UI）
- [x] Orthographic top-down（真のOrthographicCamera・parallax排除）
- [x] 梅田/中之島/本町/難波/天王寺/住吉 全6地点QA実測（幾何指標。実機目視は未実施）
- [x] validator PASS
- [x] npm test 0 fail（1519 tests / 1504 pass / 0 fail / 15 skip）
- [x] production/protected 無変更
- [ ] **実機目視QA（Reference Alignment・通常表示とも）は未実施** — 本セッションはブラウザ不可
- [x] **STOP** — 次工程へは自動で進まない

**次工程へ自動で進まずSTOPします。** 実機で `[Reference Alignment]` ボタンから6地点を確認し、
GSI Road Edge（緑線）と道路の実際の見え方についてフィードバックをお願いします。
