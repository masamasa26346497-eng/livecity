# Mission 31F 報告 — Canonical Urban Geometry 統合 ＋ Derived LOD / Tile 生成

結論: `Source → Canonical → Corrections → Resolved Canonical → Derived → LOD → Tile` の正式パイプラインを構築した。
Canonical Parks / Canonical Rail を正式 build し、5 レイヤーの Resolved Canonical（821,585 feature）と
Derived Geometry（4 LOD × 5 layer / 5,267 tile / 1,179.5 MB）を生成。全 validator PASS、npm test 1,201 pass / 0 fail、
描画は不変。31G で ward-ux-v1 を Canonical へ切り替えられる状態になった。

---

## 1. Resolved Canonical 構造

`data/processed/osaka-city/canonical/resolved/` — レイヤーごとの lineage manifest（`index.json` + `<layer>.json`）。

| layer | featureCount | corrections 適用 | geometry source |
|---|---|---|---|
| water | 528 | 1（安治川 harbor split） | canonical/water.json |
| roads | 199,658 | 0 | canonical/roads/ |
| buildings | 615,617 | 0 | canonical/buildings/ |
| parks | 2,954 | 1（31E RECLASSIFY 20） | canonical/parks/ |
| rail | 2,828（+ 駅 233） | 0 | canonical/rail/ |
| **合計** | **821,585** | **2** | — |

- corrections はこのパイプラインでは canonical build 時に適用済み（water は `build-canonical-water.js` が `corrections/water/` を、
  parks は `build-canonical-parks.js` が 31E advisory を適用）。Resolved は canonical tile を正とする「view」で、geometry の
  物理コピーはしない（§0: canonical source を壊さない / correction 履歴を消さない）。
- 各 lineage に `baseCanonical.hash` / `appliedCorrections` / `reversible: true` を記録。
  補正ファイル削除 → 該当 build 再実行で元 canonical に戻る（raw source 不変）。

## 2. Water 件数

**528 feature**（polygon 393 / ribbon fallback 133 / harbor 2）。confidence 平均 0.837。

- 大川: `cg_water_river_x_water_8f1a2570d2d177` / 379,549 m² / polygon-first（31B）維持
- 安治川: 31E で harbor 誤統合 2 part を分離済み → 1,670,920 m²（8→6 part）＋ split-off harbor 2 feature（326,227 m²）
- waterClass: river 115 / canal 21 / stream 58 / water 102 / pond 81 / reservoir 116 / lake 2 / harbor 4 / drainage 29

## 3. Road 件数

**199,658 feature**。polygon coverage: feature 99.3% / length 99.4% / area 98.9%（31C2 のまま）。

- PLATEAU tran 道路区域 polygon 198,266 / OSM centerline ribbon fallback 1,392
- OSM centerlineRef / attributes（名称・車線数・highway class）を全 polygon feature が保持

## 4. Building 件数

**615,617 feature**（PLATEAU 574,112 / OSM fallback 41,505）。31E で building geometry correction は行っていないため 31D baseline から不変。

## 5. Park 件数（Canonical Parks 正式 build §6/§7）

**2,954 feature**。`tools/build-canonical-parks.js` + `tools/validate/canonical-parks.js`（validator PASS）。

| parkClass | 件数 | 扱い |
|---|---|---|
| park | 1,836 | 公園 |
| grass | 998 | **park 扱いしない（§7）**。`landuse-grass-not-park` flag / rankable=false / conf 0.70 |
| recreation_ground | 96 | 運動場等 |
| misclassified-block | 20 | **31E RECLASSIFY 反映**（建物 share > 80% ＝ 実質街区）。conf 0.45 |
| sports_ground / green_space / other | 5 | — |

- source priority: 1 公的公園 polygon（未取得）/ 2 osm-park-polygon（採用）
- §7 分類: `leisure=park`→park / `landuse=recreation_ground`→recreation_ground / `landuse=grass`→**grass** /
  `leisure=golf_course`→sports_ground / `landuse=forest`→green_space
- 31E の 82 possibly-too-broad は **clip せず** `possibly-too-broad-31E:manual-review` flag のみ（§7: source 証拠が無いものを clip しない）
- rejected: too-small 439（40m² 未満）

## 6. Rail 件数（Canonical Rail 正式 build §8）

**2,828 line feature + 233 station**（`stations.json` に別 payload §17）。validator PASS。

| lodClass | 件数 |
|---|---|
| major | 1,456 |
| urban（地下鉄） | 414 |
| local（側線・light_rail） | 958 |

- geometry = LineString（rail は線が正）。**geometry と LOD 分類（lodClass）を分離**（§8）
- 保持属性: railway class / name / railClass（Mission24）/ operator / bridge / tunnel / layer / lengthM
- named route 47 / continuity regression 0（Mission24 の同名路線断片保持を検証）
- 骨格路線（大阪環状線・御堂筋線・阪和線）存在確認

## 7. Correction 適用件数

**2 件**（いずれも 31E の追跡可能・可逆な補正。31F では新規補正なし）:

| correction | layer | operation | 状態 |
|---|---|---|---|
| `corr_water_anjigawa_harbor_split` | water | split-multipolygon-parts | AUTO_APPLIED（build-canonical-water で適用） |
| `park-polygon-reclassify-advisory` | parks | reclassify（20 park → misclassified-block） | build-canonical-parks で適用 |

derived feature まで `correctionIds` を伝搬（validator で 0 欠落を確認）。

## 8. systematic finding #1 — possible-osm-water-boundary-error 42 件（§9）

`data/reports/water-boundary-systematic-review.json`

- 公的水涯線 source の再確認: **repo・PLATEAU 配布のいずれにも十分な source が無い**
  - repo: `waterways-osm.json`（OSM のみ）
  - PLATEAU 配布 ZIP: `luse`（土地利用）は在るが河川 polygon が ~7 件のみで水域界 source として不十分
  - GSI 基盤地図情報 水涯線 / 大阪府 河川区域 GIS: 未取得
- **decision: MANUAL_REVIEW-MAINTAINED**。推測補正は禁止（§9）。GSI 基盤地図情報 水涯線取得後に一括是正する。
- 42 件は此花区(5)・港区(4)・城東区(3) 等に分布

## 9. systematic finding #2 — central arterial road/building overlap 125 件（§10）

`data/reports/road-building-systematic-review.json`

原因分析（geometry correction はしない §10）:
- 対象道路 125 件すべて `plateau-tran-road`。**92 件が `plateauStructure=ground`（土工/通常区間 ＝ 高架でない）**、33 件が unknown
- **alignment consistency 0.104** — 道路 polygon 重心 → 建物群重心のベクトルに一貫した方向が無い
  → PLATEAU tran と PLATEAU bldg の**位置系ずれではない**
- **結論: PLATEAU tran 道路区域 polygon が実舗装より広く描かれている（都市計画決定幅の可能性）が支配的**
- sectionType が大半 ground/unknown のため高架化しない（§8）。geometry correction の根拠は無い
- 31G の描画では PLATEAU tran 道路区域を「舗装縁」ではなく「道路敷地界」として扱い、建物と重なっても矛盾表示しない設計とする

## 10. systematic finding #3 — park polygon broad 82 件（§11）

`data/reports/park-broad-systematic-review.json`

Canonical Parks build 後の再評価:
- share > 0.8 の 20 件 → `parkClass=misclassified-block`（conflict 検出から除外）
- share 0.35-0.8 の 83 件 → `possibly-too-broad-31E` flag のみ（clip せず）。真の building-in-park との分離は公的公園区域 polygon 取得後
- 分離基準: buildingShareOfPark > 0.8 → not-a-park / 0.35-0.8 → possibly-too-broad / < 0.35 → park-facility

## 11. Derived layer 構成（§12–§22）

`data/processed/osaka-city/derived/{far,mid,near,ultra-near}/<layer>/`

- 共通 tile schema（§18）: `{ tileId, layer, lod, tileSize, bbox, featureCount, canonicalIds, sourceVersion, features }`
- derived feature（§22）: `{ canonicalId, derivedFrom, layer, lod, geometryType, coordinates, bbox, centroid, simplificationToleranceM, correctionIds, sourceConfidence, attributes }`
- tile size（§19）: buildings 500m / roads・water・parks・rail 2000m（既存整合を優先。統一しない）
- simplification（§20）: **FAR 12m / MID 6m / NEAR 2m / ULTRA_NEAR 0m（none）**。canonical 本体は不変（§0）
- topology-safe simplify（§21）: `tools/lib/geometry-simplify.js`。Visvalingam（polygon）/ Douglas-Peucker（line）。
  自己交差する手前で停止、退化 hole を除去、simplify で消滅したら 1 段軽い tolerance で救済

## 12. LOD 別 feature 数

| layer | FAR | MID | NEAR | ULTRA_NEAR |
|---|---|---|---|---|
| water | 22 | 164 | 259 | 528 |
| roads | 5,030 | 17,239 | 199,658 | 199,658 |
| buildings | 17,776 | 73,234 | 615,617 | 615,617 |
| parks | 33 | 230 | 1,934 | 2,954 |
| rail | 1,456 | 1,870 | 2,828 | 2,828 |

- FAR: 幹線・大型建物・大河川・大型公園・主要鉄道のみ（Mission13/24/26/27 の major band を維持）
- ULTRA_NEAR: resolved canonical の完全表現（tolM=0・全 feature）。§25 completeness で欠落 0 を確認
- LOD feature 数の単調性（far ≤ mid ≤ near ≤ ultra-near）を validator で検証

## 13. tile 数

**5,267 tile**（FAR 1,143 / MID 1,337 / NEAR 1,393 / ULTRA_NEAR 1,394）。

## 14. disk size

**1,179.5 MB**（gitignore）:

| layer | FAR | MID | NEAR | ULTRA_NEAR |
|---|---|---|---|---|
| water | 1 MB | 1 MB | 2 MB | 2 MB |
| roads | 3 MB | 11 MB | 126 MB | 145 MB |
| buildings | 13 MB | 50 MB | 400 MB | 417 MB |
| parks | 0 MB | 0 MB | 1 MB | 2 MB |
| rail | 1 MB | 1 MB | 2 MB | 2 MB |

## 15. topology QA（§21）

`derived-geometry-validation.json` — **PASS**。全 LOD × 全 layer:
- topology break（simplify 後の outer 自己交差）: **0**
- invalid derived geometry（面積消失・頂点不足）: **0**
- river disappearance / hole collapse: 0（simplifyPolygon が tolerance² 未満の outer/hole を除外し、
  消滅時は 1 段軽い tolerance で救済）
- road disconnect: line simplify は端点保持（Douglas-Peucker）

## 16. conflict 再監査（§23）

Resolved Canonical（特に新規 Canonical Parks）に対して 5 ペア再監査。`canonical-conflicts.js` は
canonical parks を優先読み込み（grass / misclassified-block / green_space を「公園」から除外）。

| pair | 31E | 31F（canonical parks 反映後） |
|---|---|---|
| BUILDING_WATER | 144 / HIGH 48 | 144 / HIGH 48 |
| BUILDING_ROAD | 10,211 / HIGH 237 | 10,211 / HIGH 237 |
| BUILDING_RAIL | 10,565 / HIGH 0 | 10,565 / HIGH 0 |
| PARK_BUILDING | 1,082 / HIGH 110 | **884 / HIGH 94**（grass 除外で減） |
| ROAD_WATER | 106 / INFO | 108 / INFO |

- **CRITICAL 0 / 未分類 HIGH 0**（`canonical-conflict-validation.json` PASS）
- 全 HIGH 379 に action（EXPLAIN 123 / RECLASSIFY 6 / MANUAL_REVIEW 250）。MANUAL_REVIEW 250 は §17 リストに明示
- `park-polygon-may-be-misclassified` cause（31E で 187 件）は canonical parks の grass 分離で **0 に解消**

## 17. performance 予測（§26）

`derived-geometry-build.json` の `performanceBudget`（31G 切替前の計測）:

| LOD | featureCount | vertexCount | tileCount（≒ drawCall） |
|---|---|---|---|
| FAR | 24,317 | ~105k | 1,143 |
| MID | 92,737 | ~640k | 1,337 |
| NEAR | 820,296 | ~7.9M | 1,393 |
| ULTRA_NEAR | 821,585 | ~10.0M | 1,394 |

- FAR は 10 万頂点台まで削減（都市俯瞰で軽量）
- 旧 runtime との coverage 比較（§24 `resolved-vs-runtime-coverage.json`）:
  buildings 625,997→615,617（unclassified 除外分のみ減）/ roads 42,565→199,658（PLATEAU tran で大幅増）/
  parks 2,685→2,954 / rail 3,061→3,061（一致）

## 18. validator

| validator | 結果 |
|---|---|
| canonical-parks（新規 §29） | PASS（grassViolation 0 / classNull 0 / provMissing 0） |
| canonical-rail（新規 §30） | PASS（majorRouteMissing 0 / continuityRegressions 0） |
| derived-geometry（新規 §28） | PASS（orphan 0 / topologyBreak 0 / correctionMissing 0 / missingUltraNear 0 / manifestMismatch 0） |
| canonical-conflicts（§23） | PASS（CRITICAL 0 / 未分類 HIGH 0） |
| canonical-water / canonical-geometry | PASS |
| building-density / road-density / waterway-density | PASS |
| map-detail-audit / map-completeness / performance-budget | PASS |
| ward-mode-integration / live-city-mode | PASS |

## 19. npm test

**1,216 tests / 1,201 pass / 0 fail / 15 skip**（`--test-concurrency=4`）

- 新規 `tests/canonical-derived.test.js` 13 件（simplify 純ロジック / classifyPark grass 分離 / canonical parks・rail /
  resolved lineage / derived LOD 単調性・ultra-near 完全性・provenance / 安治川 correction 伝搬 / runtime adapter / conflict 再監査）
- smoke: `tests/ward-ux-v1-smoke.test.js` 3/3 PASS
- `git diff --check` clean / production・protected・ward-ux-v1 render 不変（HTML に 31F の混入 0）

## 20. preview 確認方法

`data/reports/derived-preview/<location>.geojson`（代表 10 地点: umeda / nakanoshima / okawa / anjigawa / namba /
tennoji / juso / sumiyoshi / yumeshima / nanko）

- QGIS 等で読み込み、`properties.lod`（far/mid/near/ultra-near）でカテゴリ表示 → LOD ごとの simplify 量を目視
- `properties.layer` で water/roads/buildings/parks/rail を絞り込み
- `properties.toleranceM` が simplify tolerance、`properties.correctionIds` で補正由来 feature を確認
- サイズ抑制のため layer/lod ごと 300 feature まで（`index.json` に全数記録）

## 21. runtime adapter 設計（§31/§32/§33）

`tools/lib/canonical-runtime-adapter.js`（**ward-ux-v1 へは未接続 §0**。Node テストで interface を固定）

- `lodForDistance(m)` → far(>9000) / mid(>3500) / near(>1200) / ultra-near（既存 Mission13/24/26 band 境界に整合）
- `makeCanonicalLayerAdapter(layer)` → `{ manifest, tile, attributes, canonicalFeature }` interface
- `resolvePick(pick, adapter)` → §32 feature picking: render geometry の `canonicalId` → 属性 store 参照
- `UI_COMPAT` → §33 既存 UI（building popup / ward selection / City Mode / LOD / camera / labels）の対応表。
  geometry の出所だけ差し替え、イベント配線は再利用

---

## 31G へ進めるか

**進める条件は満たしている**:
- [x] Resolved Canonical 生成 / corrections 適用 / reversible
- [x] water / roads / buildings resolved
- [x] Canonical Parks 正式 build（grass ≠ park）/ Canonical Rail 正式 build（geometry ⊥ LOD）
- [x] systematic finding 3 件再監査（#1 MANUAL_REVIEW 維持 / #2 原因＝tran 幅過大 / #3 grass 分離で解消）
- [x] Derived LOD 生成 / tile 生成 / topology validation
- [x] canonical → derived 追跡（provenance / correctionIds）
- [x] preview 生成 / performance budget 予測
- [x] validators PASS / npm test 0 fail / smoke PASS
- [x] runtime unchanged / production・protected unchanged

**31G へ引き継ぐ宿題**:
1. systematic finding #1（水域界 42 件）→ GSI 基盤地図情報 水涯線取得
2. systematic finding #2（幹線 tran 幅 125 件）→ 描画側で「道路敷地界」扱い（矛盾表示しない）
3. 公的公園 polygon（rank1 source）取得で park-broad 83 件を確定
4. runtime adapter の THREE 側実装 + ward-ux-v1 接続

---

**31G には自動で進まない。ユーザー確認を待つ。**


---

## 補記（31G での修正）

**ULTRA_NEAR LOD は 31G で廃止した**。理由: (1) ULTRA_NEAR（tolM 0）は NEAR（tolM 2m・全 feature）とほぼ同一 geometry で disk 容量が 2 倍（+572MB）、(2) 実行環境の OneDrive 同期が 1.2GB の derived を dehydrate し readFileSync が UNKNOWN エラーになった。31G 以降 derived は **far/mid/near の 3 段**で、**near = resolved canonical の完全表現**（tolM 2m の微 simplify のみ）。§25 completeness / §28 validator / 関連テストは near 基準へ更新済み。
