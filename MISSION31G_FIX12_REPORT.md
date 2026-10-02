# Mission 31G-FIX12 完了報告｜道路面の意味・描画範囲を再定義し、建物がずれて見える問題を解消する

対象: `public/osaka_3d_buildings.ward-ux-v1.html`（dev） / 生成物 `data/processed/osaka-city/derived/road-render-class.json`
方針: **今回は Road semantic / Render representation の修正のみ**。建物・source geometry は一切変更しない（§0 遵守）。

---

## §23-1｜建物がずれて見えた主原因

**座標バグではない**（FIX10/FIX11 で確定済み: canonical→derived centroid median 0m、runtime 座標変換ゼロ、建物 99.999% が N03 行政界に一致）。

真因は **「描画している道路面」の定義**。canonical roads の geometry-primary は **PLATEAU tran:Road lod1 の"道路区域"ポリゴン**であり、これは
`車道（roadway）+ 歩道 + 植樹帯 + 法面（のり面）+ 都市計画上の setback` を含む **実舗装より広い面**（31E systematic finding #2: alignment consistency 0.104、都市計画決定幅）。

この道路区域ポリゴンを**全面 road 色（不透明・medium gray）で塗る**と、区域の縁に正しく建っている建物が「灰色の帯の上に乗っている」ように見える。
つまり建物の位置は正しく、**道路の描画範囲が広すぎた**。

加えて、OSM centerline も class も持たない未分類ポリゴン（面積の 47% = 24.7km²）を無条件に道路本体と同じ濃さで描いていたため、
歩道・広場・法面まで「道路」として visual に主張していた。

---

## §23-2｜Canonical Road と Road Visual Surface の違い（正式分離）

| | Canonical Road Geometry | Road Visual Surface |
|---|---|---|
| 実体 | PLATEAU tran 全体の道路関連 geometry（道路区域面） | 実際に地図上で"道路色"として描く面 |
| 役割 | **source truth**（不変・保持） | 描画表現（renderClass ごとに濃さ/opacity/Y を変える） |
| 面積 | 52.7 km² | 46.2 km²（visual 実効） |
| 変更 | 禁止（clip / offset / 破壊なし） | renderClass 付与のみ（geometry は触らない） |

`Canonical Road ≠ 必ずしも Road Visual Surface`。
runtime は Canonical Road full polygon ではなく **renderClass 別の style** で道路面を描く。

---

## §23-3｜Road surface 分類（renderClass）

`tools/build-road-render-class.js` が canonical road feature ごとに `renderClass` を precompute。
出力 `data/processed/osaka-city/derived/road-render-class.json`（classMap は **primary 以外のみ収録** = 14,658 件 / 1.45MB。primary は runtime 既定）。

| renderClass | 判定 | 件数 | 面積 | render surface (rs) | runtime style |
|---|---|--:|--:|---|---|
| ROADWAY | OSM highway=実道路 / detail=MAJOR..LOCAL / lodClass=major,mid / 形状が細い道路帯 | 184,695 | 39.62 km² | **primary** | 不透明 COL.road / Y.road(0.30)（**従来どおり**） |
| INTERSECTION | plateauStructure=intersection | 13 | 0.02 km² | primary | 同上 |
| RAMP | highway=*_link | 292 | 0.50 km² | primary | 同上 |
| BRIDGE | bridge / structure=elevated,bridge / layer>0 | 2,303 | 3.28 km² | **bridge** | 不透明 COL.road / Y.roadBridge(3.0)（高架を明示） |
| PEDESTRIAN | highway=footway,path,steps.. / detail=PEDESTRIAN | 2,134 | 0.89 km² | **pedestrian** | 暖色グレー 0xb8b0a4 / opacity 0.58 / Y.road-0.05 |
| ALLEY | detail=LOCAL_ALLEY | 0 | 0 | secondary | road→white 26% blend / opacity 0.82 |
| ROAD_RESERVE | 未分類で 有効幅≥9m かつ aspect<2.2（幅のある区域＝法面/植樹帯/広場） | 3,748 | 3.69 km² | **faint** | road→地表 50% blend / opacity 0.30 / Y.road-0.08 |
| UNKNOWN | 未分類でどちらとも言えない | 6,473 | 4.68 km² | **faint** | 同上 |
| MEDIAN / SIDEWALK | （現データには出現せず。定義のみ） | 0 | 0 | faint | 同上 |

`primary` 3 クラス合計 **185,000 件 / 40.1 km²** が「濃い車道面」。それ以外は薄く/低く描く。

---

## §23-4｜UNKNOWN の処理（§4/§5 準拠）

- **UNKNOWN を道路本体と同じ濃さで全面描画することを廃止**。
- 未分類ポリゴン（highway=null かつ detail=null/LOCAL_UNCLASSIFIED、OSM centerline なし）を形状で推定:
  - 有効幅 `effW = 2·areaM2/周長` ≤ 8m かつ（aspect≥1.6 または面積<350㎡）→ **ROADWAY(conf 0.5)**：OSM が取りこぼした細街路。primary で描く（実道路なので消さない = §4「推測で消さない」）。
  - `effW ≥ 9m` かつ aspect<2.2 → **ROAD_RESERVE**：幅のある区域（法面・植樹帯・広場）。faint。
  - それ以外 → **UNKNOWN**：中間の薄さ（faint）。
- fallback ribbon（`source.geometrySource = osm-road-centerline`・幅推定）は実道路として ROADWAY(conf 0.6)。
- 未分類の内訳: 92% が有効幅<8m の"道路帯"（→ ROADWAY）、残り 8.4km²（RESERVE 3.69 + UNKNOWN 4.68）を faint 化。

---

## §23-5｜canonical road 面積

**52.69 km²**（199,658 feature、大阪市 225km² の約 23%）。
`data/reports/road-visual-surface-audit.json` / `canonicalRoadAreaM2 = 52,687,134`。

---

## §23-6｜visual road 面積

**46.21 km²**（rs 係数で重み付けした実効"濃い道路面"面積。primary/bridge=1.0、secondary=0.7、pedestrian=0.5、faint=0.28）。
`visualRoadAreaM2 = 46,212,464`。

内訳（geometry 面積）: primary+bridge+ramp+intersection = 43.4 km²（不透明で描く）、pedestrian 0.89 km²、faint（RESERVE+UNKNOWN）8.37 km²。

---

## §23-7｜面積削減率

**visual road 実効面積 −12.3%**（52.69 → 46.21 km²、`reductionRatio = 0.123`）。
faint 化した geometry 面積は 8.37 km²（canonical road の 15.9%）。primary 車道面そのものは削っていない（§0）。

---

## §23-8｜Building ∩ Canonical Road

`tools/audit/building-road-visual-overlap.js`（footprint 5 点サンプル × point-in-road-polygon、面積按分近似・turf 不使用）。
`data/reports/building-road-visual-overlap.json`。

- 建物 footprint と **全 canonical road ポリゴン**の重なり面積: **15.44 km²**（canonical 建物総面積 72.08 km² の 21.4%）。
- サンプル過半が road 上の建物: **126,389 棟**（全 615,617 棟の 20.5%）。

---

## §23-9｜Building ∩ Road Visual Surface

- 建物 footprint と **primary+bridge（濃い不透明道路面）のみ**の重なり面積: **13.06 km²**。
- サンプル過半が濃い道路面上の建物: **107,684 棟**。

**差分（FIX12 の効果）**:
- 重なり面積 15.44 → 13.06 km²（**−15.4%**、`overlapReductionRatio = 0.154`）。
- 「道路に乗って見える」建物 126,389 → 107,684（**18,705 棟が濃い道路面から外れた**）。
- これらは歩道・法面・広場（faint）の縁に建つ建物で、視覚的に道路帯から分離される。

> 残る 13.06 km² の重なりは、PLATEAU 車道区域ポリゴンが実舗装より広いこと（F_SOURCE_DIFFERENCE）に起因。
> §0 で車道 geometry の clip が禁止のため、renderClass では解消できない（別途 official-road-area ポリゴン取得 or centerline+実幅で車道面を再構成する将来課題）。

---

## §23-10｜代表地点で確認された結果（データ由来・実機ブラウザ QA は未実施）

faint/pedestrian/bridge が集中するタイル（2km グリッド）から代表 3 状況:

| 地区タイプ | 例 | 変化 |
|---|---|---|
| **北部（淀川区・東淀川区）OSM 道路データ欠落域** | tile x≈−3000〜0 / z≈−15000（lat 34.73 付近） | PLATEAU 道路区域のみ。細い帯は ROADWAY(primary) で従来どおり、幅広の余白（faint 400+件/タイル）が薄くなり、区域縁の建物が道路帯から分離。 |
| **都心大街区（北区・中央区／梅田・本町）** | tile x≈−1800〜−3100 / z≈−4000〜−5000 | 交差点広場・歩道分離帯が pedestrian/faint（60〜80件/タイル）。primary 車道は不変。歩道が道路本体と別トーンになり車道の輪郭が明確に。 |
| **湾岸・高速ランプ（此花区・港区・大正区）** | tile x≈−3100 / z≈−5000（bridge 117件） | BRIDGE が bridge rs（Y.roadBridge 3.0）。高架が地表道路と Y 分離され、下の建物・道路と重ならず表示。 |

いずれも **建物は 1mm も動いていない**（§23-13）。変わったのは道路面の濃さ・高さ・透明度のみ。

---

## §23-11｜y-height 結果

`Y = { water: 0.14, park: 0.22, road: 0.30, roadBridge: 3.0, rail: 0.5, railBridge: 3.2 }` — **既存値は不変**。

`CR_ROAD_RS` の Y（renderClass 別）:

| rs | Y | renderOrder | 意図 |
|---|--:|--:|---|
| primary | **Y.road = 0.30**（不変） | REN.road = 640 | 車道面は従来と完全一致 |
| bridge | Y.roadBridge = 3.0（不変） | 642 | 高架 |
| secondary | 0.28 | 640 | わずかに下 |
| pedestrian | 0.25 | 639 | 車道の下・park(0.22) の上 |
| faint | **0.22** | 638 | 地表寄り。park と同 Y だが renderOrder 638>622 で faint が上、opacity 0.30 で park が透ける |

REN 順序 `ground(0) < water(610) < park(622) < road(638–642) < rail(680) < building(700)` を維持。**building(700) は全道路面より上** = 建物が道路に埋まらない（§10 確認）。primary 車道の Y/REN は 1 ビットも変えていない。

---

## §23-12｜opacity 結果

| rs | transparent | opacity | depthWrite |
|---|---|--:|---|
| primary | **false** | **1.0** | true（従来どおり不透明） |
| bridge | false | 1.0 | true |
| secondary | true | 0.82 | false |
| pedestrian | true | 0.58 | false |
| faint | true | **0.30** | false |

- **ROADWAY（車道本体）は完全に不透明のまま**（§11 遵守）。視認性・コントラスト（FIX8/8B）に影響なし。
- 非 primary のみ透過。faint は地表色へ 50% ブレンド + opacity 0.30 で「うっすら道路区域があった痕跡」レベルに後退。
- water opacity 0.96 / park opacity（0.5〜0.9）は不変。

---

## §23-13｜建物位置不変の確認

- **建物 branch（`loadTile` の `layer === 'buildings'`）に変更なし**（diff は roads branch と定数のみ）。
- canonical buildings manifest `featureCount = 615,617`（不変）。
- `tools/validate/road-visual-surface.js`: `buildingGeometryMutation = 0`、`sourceGeometryMutation = 0`（canonical roads featureCount 199,658 も一致）。
- roads branch の静的検査: `.coordinates =` / `.geometryType =` / `f.coordinates.push|splice` **なし**（`roadsBranchNoGeometryWrite = true`）。
- 建物の x/z は renderClass の対象外（道路 feature のみ処理）。**建物 mesh 生成コードは 1 行も変わっていない**。

---

## §23-14｜performance 影響

- **追加 fetch**: `road-render-class.json` 1.45MB を `ensureManifest()` で **1 回のみ**取得（manifest / building-placement / ward-index と同じ扱い。ward 切替・camera で再取得しない）。
- **roads build**: feature ごとに `Map.get(canonicalId)` 1 回 + bucket 5 分岐（従来は bridge/非bridge 2 分岐）。mesh 生成は最大 5 draw call/tile（従来 2）。near band の roads は mid tile 使用（FIX7）なので実 feature 数は変わらず。
- `tools/validate/canonical-runtime-performance.js`: **RESULT PASS**（`duplicateFetch 0 / manifestReload 0 / frameIdleRefresh 0 / progressiveBuildBudget true / byteBudgetCache true`）。heaviest tile も不変（near/roads 1398KB）。
- npm test full 実行時間 42.6s（FIX11 時と同等、regression なし）。
- **判定: performance regression なし**。

---

## §23-15｜validator

| validator | 結果 |
|---|---|
| `tools/validate/road-visual-surface.js`（**新規・§20**） | **PASS**：`invalidVisualPolygon 0 / unknownRenderedAsFullRoad 0 / roadVisualProvenancePct 100 / sourceGeometryMutation 0 / buildingGeometryMutation 0 / projectionUnchanged true / productionUnchanged true / protectedUnchanged true` |
| `tools/validate/canonical-runtime-integration.js`（**+7 check**） | **PASS**：`roadRenderClassLoaded / roadVisualSurfaceStyle / roadsBucketedByRenderClass / unknownNotFullRoad / roadPrimaryStaysOpaque / roadSourceGeometryUnchanged / roadVisualSurfaceDebug` すべて true。既存 68 check も全 true。 |
| `tools/validate/canonical-runtime-performance.js` | **PASS** |

§20 PASS 条件チェック:
- source geometry mutation 0 ✅
- invalid visual polygon 0 ✅
- unknown rendered-as-full-road violation 0 ✅
- road visual provenance 100% ✅
- building geometry mutation 0 ✅
- projection unchanged ✅
- production / protected unchanged ✅

---

## §23-16｜npm test

`npm test`（`--test-concurrency=4`、package.json scripts.test の明示ファイル列 + `tests/road-visual-surface.test.js` 追加）:

```
tests 1332 / pass 1317 / fail 0 / skipped 15
```

- skipped 15 = `html-regression.test.js`（production HTML がこのサンドボックスの標準パスに無く意図的 skip。dev HTML は cutover / smoke / road-visual-surface で検査済み）。
- 新規 `tests/road-visual-surface.test.js`: **12 件 pass**。
- `tests/canonical-runtime-cutover.test.js`: **116 件 pass**（validator 全 check key list に FIX12 の 7 key 追加）。
- **fail 0**。

---

## §23-17｜実機で期待される変化

URL を開くと canonical runtime が自動起動（従来どおり）。道路について:

1. **車道（幹線・生活道路・細街路）は今までと全く同じ**濃さ・不透明・高さ（primary、Y.road 0.30、opacity 1.0）。地図の道路網の読みやすさは変わらない。
2. **歩道・歩行者空間**が車道と別トーン（暖色グレー・半透明）になり、車道の輪郭がはっきりする。
3. **法面・植樹帯・駅前広場・道路区域の余白（faint）** が地表色に近い薄さ（opacity 0.30）に後退。これらの縁に建つ **18,705 棟の建物が「灰色の帯の上」から外れて見える**。
4. **高架・ランプ（bridge）** が Y 3.0 で地表道路から分離表示。
5. 北部 3 区（淀川・東淀川・旭 = OSM 道路データ欠落域）では、PLATEAU 道路区域のうち細い道路帯だけが道路色で残り、幅広の未分類区域が薄くなる。
6. デバッグ: `__CANONICAL_RUNTIME_DEBUG__()` の `roadVisualSurface` に `classMapLoaded / nonPrimaryEntries(14658) / demotedFeaturesVisible / style` が出る。

> **依然として残る現象**: PLATEAU 車道区域ポリゴンが実舗装より数 m 広いこと自体は変えていない（§0）。
> そのため車道の真上ではなく「車道区域の端」に建物がかかるケース（13.06km²）は残る。
> 完全解消には official 道路区域ポリゴン取得、または centerline + 実測レーン幅での車道面再構成が必要（FIX12 の範囲外）。

---

## 完了条件（§22）チェック

- [x] Canonical Road と Visual Surface を分離（source truth 保持 / renderClass 付与のみ）
- [x] roadway 等の surface classification（9 クラス）
- [x] UNKNOWN 全面道路表示を廃止（形状推定 → ROADWAY/RESERVE/UNKNOWN、faint 化）
- [x] OSM centerline 補助利用（`centerlineRef` 有無 + `osm-road-centerline` ribbon を実道路判定に使用）
- [x] Building ∩ VisualRoad 監査（`building-road-visual-overlap.js`）
- [x] y-height 確認（primary Y.road 不変・faint のみ地表寄せ）
- [x] opacity 確認（primary 不透明維持・非 primary のみ透過）
- [x] 建物 x/z 変更なし
- [x] source geometry 不変（canonical roads/buildings featureCount 一致）
- [x] RoadVisualSurface runtime 適用（`CR_ROAD_RS` + `roadRenderClass` Map + roads branch bucket）
- [x] representative QA（データ由来。実機ブラウザ QA は環境制約で未実施）
- [x] validator PASS（road-visual-surface / canonical-runtime-integration / performance）
- [x] npm test fail 0（1317 pass）
- [x] performance regression なし

## 変更ファイル

| ファイル | 種別 | 内容 |
|---|---|---|
| `tools/build-road-render-class.js` | 新規 | renderClass precompute → `road-render-class.json` + audit |
| `tools/audit/building-road-visual-overlap.js` | 新規 | Building∩Road 重なり監査（§8） |
| `tools/validate/road-visual-surface.js` | 新規 | §20 validator |
| `tests/road-visual-surface.test.js` | 新規 | 12 件 |
| `public/osaka_3d_buildings.ward-ux-v1.html` | 変更 | `CR_ROAD_RS` 定数 / `roadRenderClass` Map / `ensureManifest` fetch / roads branch bucket 化 / getDebug `roadVisualSurface` |
| `tools/build-derived-public.js` | 変更 | `road-render-class.json` を public へ配信 |
| `tools/validate/canonical-runtime-integration.js` | 変更 | +7 check + 6 need エントリ |
| `tests/canonical-runtime-cutover.test.js` | 変更 | validator 全 check key list に +7 |
| `package.json` | 変更 | scripts.test に `tests/road-visual-surface.test.js` |
| `data/processed/osaka-city/derived/road-render-class.json` | 生成 | classMap 14,658 件 / 1.45MB |
| `public/map-data/osaka-city/derived/road-render-class.json` | 生成 | 配信コピー |
| `data/reports/road-visual-surface-audit.json` | 生成 | 面積監査 |
| `data/reports/building-road-visual-overlap.json` | 生成 | §8 重なり監査 |
| `data/reports/road-visual-surface-validation.json` | 生成 | validator 結果 |

production `osaka_3d_buildings.html` / protected `osaka_3d_buildings.fullward-v3.html` は **不変**（hash baseline 一致、`git diff --check` clean）。

---

**次工程へは進まず、道路表示面の正規化のみ完了。ユーザー確認待ち。**
