# Live City Canonical Urban Geometry — 設計 (Mission 31A)

> ステータス: **設計 + schema + prototype**。既存描画（RiverLayerV2 / BuildingTileLayer / CityBuildingLOD /
> RoadLayer / CityTileLayer / N03 境界）は**一切置換しない**。production / protected HTML 変更なし。
> projection / znorth-neg-v1 変更なし。Mission 1〜30 の描画結果を破壊しない。

正本コード: [`tools/lib/canonical-geometry-schema.js`](tools/lib/canonical-geometry-schema.js)

---

## 1. なぜ canonical が必要か

現在の Live City は
**PLATEAU 建物 / OSM 道路 / OSM 河川 / OSM 公園 / OSM 鉄道 / N03 行政界** を
個別に取得し、最後に同一座標系（znorth-neg-v1）へ重ねて表示している。

各ソースの **取得時点・精度・境界定義** が異なるため、次の齟齬が構造的に発生する:

| 症状 | 実測（このミッションの監査） |
|---|---|
| 建物が河川へ食い込む | 大川の水面の **29%** が PLATEAU 建物 footprint と重なる（[`okawa-canonical-water-audit.json`](data/reports/okawa-canonical-water-audit.json)）。canonical water 全体では説明不能な **HIGH conflict 105 件**（[`canonical-conflicts.json`](data/reports/canonical-conflicts.json)） |
| 河川幅が実際より細い/太い | 大川: ribbon 実測幅 87.9m に対し riverbank polygon source は **面積比 1.24 倍**（実河道はさらに広い） |
| 道路が建物と重なる | 道路が centerline のみで「区域」を持たないため、幅推定のたびにズレる（[`canonical-road-source-comparison.json`](data/reports/canonical-road-source-comparison.json)） |
| 区境界・水域境界で数 m 級のズレ | N03（±1m）と OSM（±3〜5m）の混在。突合基準が無い |

**根本原因**: 「どの形が正か」という**内部の正本形状が存在しない**。
各レイヤーが自分のソースを描いているだけで、レイヤー間の整合を取る層が無い。

## 2. アーキテクチャ: source → canonical → attributes → LOD → style

```
Source Data
  PLATEAU building / OSM road|water|park|rail centerline&polygon / 公的水域・道路区域 / N03
        │  各 source に geometryRole（位置を決める）と attributeRole（属性を付ける）を明示（§ SOURCE_REGISTRY）
        ▼
Canonical Urban Geometry              ← data/processed/osaka-city/canonical/
  layer: land / buildings / roads / water / parks / rail / administrative
  純粋な地理形状のみ（Polygon/MultiPolygon/LineString）。色・材質・LOD を持たない。
  feature ごとに provenance（出所）と confidence（信頼度）を必須で持つ。
        │  attribute は「what」だけ join（用途・名前・水種）。population/landPrice/facility 等は外部 join。
        ▼
Attributes                            ← buildingAttributes / waterAttributes / …（別レイヤー。31 では未着手）
        │
        ▼
LOD / Tile (derived)                  ← data/processed/osaka-city/derived/{far,mid,near,ultra-near}
  canonical を simplify → tile clip → merged geometry。canonical 自体は削らない。
  Mission 1〜30 の LOD 成果はこの derived 側へ統合する。
        │
        ▼
Style / 3D Display                     ← ward-ux-v1.html（既存レイヤー）
  water #9ed6e6 / road #c4c8cc / building usage palette。canonical は色を知らない。
```

### 移行しても壊さないもの
- projection（`local-equirectangular` centerLat 34.604208 / centerLon 135.52502 / 111320）
- znorth-neg-v1（`x=(lon-135.52502)*cos(34.604208°)*111320`, `z=-((lat-34.604208)*111320)`）
- OSAKA_CITY_GROUND_EXTENT / N03 24 区 bbox
- Mission 1〜30 の描画・validator・test

## 3. layer 別 source priority

[`SOURCE_PRIORITY`](tools/lib/canonical-geometry-schema.js) にコード config として定義。
**各 layer の末尾は必ず「source missing は生成しない」**（推測ポリゴンを作らない）。

| layer | rank1 | rank2 | rank3 | rank4 | 末尾 |
|---|---|---|---|---|---|
| **buildings** | PLATEAU footprint (0.95) | OSM fallback footprint (0.82) | — | — | 生成しない |
| **roads** | 公的道路区域 polygon *(未取得)* | PLATEAU tran:Road 面 *(未取得)* | OSM centerline + width (0.65–0.80) | OSM area:highway *(補助)* | 生成しない |
| **water** | 公的水域 polygon / 水涯線 *(未取得)* | OSM riverbank / water=river polygon (0.90) | OSM natural=water polygon (0.88) | OSM waterway centerline + 幅 (0.65–0.78) | 生成しない |
| **parks** | OSM / 公的 公園 polygon (0.88) | — | — | — | 生成しない |
| **rail** | OSM rail geometry (0.75) | PLATEAU 等の補助 *(未評価)* | — | — | 生成しない |
| **administrative** | N03 行政区域 2026 (1.00) | — | — | — | 生成しない |
| **land** | 公的水涯線 *(未取得)* | land-surface (N03 陸域由来, 0.55) | — | — | 生成しない |

### 「位置を決めるデータ」と「属性を付けるデータ」の分離（§2）
[`SOURCE_REGISTRY`](tools/lib/canonical-geometry-schema.js) で各 source に `geometryRole` / `attributeRole` を付与。

| source | geometryRole | attributeRole |
|---|---|---|
| PLATEAU building | geometry-primary | attribute-primary（高さ・用途） |
| OSM building | geometry-fallback | attribute-supplement |
| OSM road centerline | geometry-fallback | attribute-primary（name / highway class） |
| OSM riverbank polygon | geometry-primary | attribute-supplement |
| OSM waterway centerline | geometry-fallback | attribute-primary（name / waterway type） |
| 公的水域 polygon | geometry-primary | attribute-none |
| 公的道路区域 | geometry-primary | attribute-none |
| N03 | geometry-primary | attribute-primary（区名・区コード） |

## 4. provenance schema（必須）

canonical feature は **必ず** `source` を持つ（[`makeProvenance`](tools/lib/canonical-geometry-schema.js) / validator が強制）。

```jsonc
{
  "canonicalId": "cg_water_water_8f1a2570d2d177",
  "layer": "water",
  "geometryType": "Polygon",
  "coordinates": [ [ [x,z], ... ] ],
  "bbox": { "minX":…, "maxX":…, "minZ":…, "maxZ":… },
  "areaM2": 339910.12,
  "centroid": [x, z],
  "coordinateConvention": "znorth-neg-v1",
  "source": {
    "geometrySource": "osm-waterway-centerline",   // SOURCE_REGISTRY のキー
    "attributeSources": ["osm-waterway", "osm-name", "osm-riverbank"],
    "confidence": 0.78,
    "sourceIds": ["way/82729504"],
    "generatedAt": "2026-09-09T…Z",
    "notes": "RiverLayerV2 ribbon 由来。widthMethod=measured-strong matchedRiverbanks=10"
  },
  "attributes": { "name": "大川", "waterType": "river", "surface": true },
  "qaFlags": ["polygon-source-available"],
  "centerlineRef": { "coordinates": [...], "lengthM": 3866 },   // water / roads のみ
  "widthProfile": { "method": "measured-strong", "median": 87.9, "matchedRiverbanks": 10, ... }
}
```

## 5. confidence 設計

[`CONFIDENCE`](tools/lib/canonical-geometry-schema.js)（数値は設計案・build ツールが参照）:

| confidence | 意味 |
|---|---|
| 1.00 | 公的高精度 polygon（道路区域 / 水涯線 / N03） |
| 0.95 | PLATEAU building footprint |
| 0.90 | OSM water / riverbank polygon |
| 0.88 | OSM park polygon |
| 0.82 | OSM fallback building footprint |
| 0.80 | OSM centerline + width タグ |
| 0.78 | OSM centerline + riverbank 実測幅 |
| 0.75 | OSM rail centerline |
| 0.65 | OSM centerline + クラス既定幅 |
| 0.55 | N03 ラスタ由来の粗い陸域面 |

`isValidConfidence`（0.0–1.0）を validator が強制。water prototype の実測平均 **0.819**。

## 6. conflict QA 設計

[`CONFLICT_PAIRS`](tools/lib/canonical-geometry-schema.js) / [`tools/audit/canonical-conflicts.js`](tools/audit/canonical-conflicts.js)。

対象ペア: Building∩Water / Building∩Road / Building∩Rail / Road∩Water / Park∩Building / Land∩Sea。

**重なり = 即 ERROR ではない**。[`CONFLICT_EXPLANATIONS`](tools/lib/canonical-geometry-schema.js) で意味付け:

| ペア | EXPLAINED 可能な理由 |
|---|---|
| Building∩Water | boat-house / pier / over-water-structure / **osm-building-drawn-on-water** / **centerline-offset** |
| Building∩Road | elevated-road / building-passage / gallery / footprint-eave-overhang |
| Building∩Rail | station-building / elevated-rail / rail-over-building / track-through-depot-building |
| Road∩Water | **bridge** / culvert / road-over-water / ford |
| Park∩Building | park-facility / clubhouse / museum-in-park / restroom |
| Land∩Sea | reclaimed-boundary-rounding / tidal-flat / pier |

`classifyConflictSeverity({ overlapAreaM2, aAreaM2, bAreaM2, explanation })`:
- `explanation` あり → **INFO**
- `overlapAreaM2 < 25` または重なり率 `< 5%` → **LOW**（座標丸め・軒の出）
- 説明不能かつ `率 ≥ 50% かつ 面積 > 1500m²`、または `面積 > 6000m²` → **HIGH**
- それ以外 → **MEDIUM**

### 31A prototype の監査結果（Building∩Water のみ実計算。他ペアは canonical layer 未構築で pending）
- conflict 250 件 / bySeverity `{ HIGH:105, MEDIUM:77, INFO(EXPLAINED):68 }`
- byCause `{ plateau-building-encroaches-water:176, centerline-offset:52, over-water-structure:13, osm-building-drawn-on-water:3, osm-building-encroaches-water:6 }`
- **HIGH 105 件の主因**: canonical water の geometry が現状 **ribbon（centerline の左右オフセット）** であること。
  川の湾曲部で ribbon が岸の建物を薄く貫く。**31B で riverbank polygon 由来の geometry へ差し替えれば大幅に減る見込み**
  （大川は polygon source あり = `polygon-source-available` 44 features）。
- **31A ではこれらを解消しない**（geometry 書き換えは 31E 以降）。監査で「意味を付ける」までが今回の範囲。

## 7. canonical layer precedence（同一面を複数 layer が占有）

[`LAYER_PRECEDENCE_POLICY`](tools/lib/canonical-geometry-schema.js):
- 「water 優先」のような**固定順位は使わない**。`confidence` + 実形状 QA で判断。
- **roads–buildings / rail–buildings は排他 clip 禁止**（高架道路・建物内通路・駅ビルがあり得る）。
- 負けた側は `qaFlags` を立てるだけ（geometry は保持）。書き換えは 31E で個別判断。
- tie-break: confidence が高い側が unflagged で残る。

## 8. update strategy

| source | 更新契機 | canonical 再生成 |
|---|---|---|
| PLATEAU | 数年周期 | 建物 dataset 再取得時に buildings canonical 再ビルド |
| OSM (road/water/park/rail) | 継続的 | Overpass / PBF 再取得時に該当 layer 再ビルド |
| N03 | 年次 | administrative 再ビルド（区界変更は稀） |
| 公的道路区域 / 水涯線 | 年次〜数年 | 取得できれば rank1 昇格で該当 layer 再ビルド |

各 canonical feature は `source.generatedAt` と `source.sourceIds` を持つため、
「どの feature がどのソースのどのバージョン由来か」を後追いできる（§4）。

## 9. canonical output directory

[`CANONICAL_OUTPUT`](tools/lib/canonical-geometry-schema.js):

```
data/processed/osaka-city/canonical/
├─ land.json            (single)
├─ administrative.json  (single)
├─ water.json           (31A: single prototype → 31B: manifest+tile)
├─ parks.json           (single → tile)
├─ rail.json            (single → tile)
├─ roads/               (manifest + tile。tileSize 2000＝既存 roads と揃える)
└─ buildings/           (manifest + tile)
```
**最初から全量巨大 JSON にしない。** 大きい layer は manifest + tile。
derived（LOD）と style は canonical の**外**（§15 / §16）。

## 10 / 11. water prototype と 大川

[`tools/build-canonical-water.js`](tools/build-canonical-water.js) → [`data/processed/osaka-city/canonical/water.json`](data/processed/osaka-city/canonical/water.json)

- **587 feature**（ribbon 225 = `osm-waterway-centerline` / area polygon 362 = `osm-riverbank` 110 + `osm-water-polygon` 252）
- confidence 平均 0.819。schema error 0。`polygon-source-available` 44（31B で geometry を polygon へ差し替える river）
- RiverLayerV2 / rivers.json は**読み取りのみ**。置換しない。

### 大川（[`okawa-canonical-water-audit.json`](data/reports/okawa-canonical-water-audit.json)）
| 項目 | 値 |
|---|---|
| source | OSM `way/82729504`（大川）。centerline 3,866m |
| current ribbon area | 339,910 m²（幅 measured-strong 87.9m。大川幅補正タスク後） |
| polygon source | OSM riverbank/water polygon **3 枚 / 421,669 m²**（ribbon 比 **1.24**） |
| width profile | measured-strong / matchedRiverbanks 10 / sample 9（min 80.5 / median 87.9 / max 107.9） |
| building overlap | 水面の **29.0%**（PLATEAU 6,142 cells / OSM fallback 17 cells @ 4m grid） |
| road overlap | 3.0%（centerline 6m 以内） |
| confidence | 現 ribbon 0.78 → polygon source 採用で **0.90** |
| **migration** | **31B: geometry を osm-riverbank polygon へ差し替え、confidence 0.90 へ** |

→ 大川は「幅」は補正済みだが、**実河道はさらに 24% 広く**、かつ **PLATEAU 建物が水面の 3 割に食い込んでいる**。
これは canonical water polygon + conflict QA で 31B/31E に扱う。

## 12. road canonical prototype 設計

[`canonical-road-source-comparison.json`](data/reports/canonical-road-source-comparison.json)。

**31C 実施結果**: polygon source（公的道路区域 / PLATEAU tran:Road / OSM area:highway）は **1 件も取得できず**
（raw OSM に `area:highway` 0 件・PLATEAU tran は fetcher が bldg のみ）。よって
[`canonical/roads/`](data/processed/osaka-city/canonical/roads/) は **42,547 feature すべてが OSM centerline +
幅推定の ribbon fallback**（polygonCoverageRatio 0）。confidence 平均 0.665（width タグ 78 / lanes 6,436 /
class-default 36,051）。**Building∩Road 4,476 conflict（主因 = ribbon 幅推定ずれ）** が「polygon source が必要」を
定量的に裏付けた。→ **31D で ① `plateau-sources.json` に tranPattern 追加 + `fetch-plateau.js` を tran GML 対応、
② GSI 基盤地図情報「道路縁」ローカル取得、のいずれかで polygon source を確保する**。

| source | geometry | 大阪カバレッジ | 精度 | license | 推奨 rank |
|---|---|---|---|---|---|
| 公的道路区域 polygon | 道路区域 polygon | 要調査（基盤地図情報「道路縁」/ 大阪市 GIS） | ±0.5m | 要精査 | **1** |
| PLATEAU tran:Road 面 | 道路縁 polygon | 高い見込み（建物 PLATEAU と同事業） | ±1–1.5m | PLATEAU（建物と同条件） | **2** |
| OSM centerline + width | centerline（面でない） | **高い（42,565 本 / 5,287 km）** | ±3–5m | ODbL 1.0 | **3** |
| OSM area:highway | 面（車道網カバレッジ低） | 低い（歩行者空間中心） | ±3m | ODbL 1.0 | 4（補助） |

**推奨**: 31C でまず公的道路区域 / PLATEAU tran の取得可否・ライセンスを調査。取れなければ OSM centerline + width 推定で区域化（confidence 0.65–0.80）。area:highway は歩行者空間の補助限定。

## 13. building canonical 方針

- **PLATEAU building を原則 canonical**（confidence 0.95）。**574,112 棟を破壊・置換しない**。
- fallback: OSM building（confidence 0.82）。Mission 29 の成果をそのまま再利用:
  - duplicate suppression（centroid-in-polygon / bbox IoU）
  - invalid geometry filtering（頂点数 / 面積 / 非有限 / 自己交差）
  - ward assignment（footprint centroid が入る区。Mission 追加修正で `wardId` / `usageCategory` 付与済み）
- 31D で `canonical/buildings/`（manifest + tile）を生成。attribute（高さ・用途）は `buildingAttributes` へ分離。

**31D 実施結果**: [`canonical/buildings/`](data/processed/osaka-city/canonical/buildings/)（gitignore・約 570MB・
manifest + tile ×996 + `attributes/` tile ×996）を生成。**615,617 feature**（PLATEAU 574,112〔baseline 一致・
render 簡略化せず原 footprint〕+ OSM fallback 41,505）。§4 で PLATEAU duplicate 2 棟除外 → **canonical duplicate 0**。
§5 で geometry feature は `attributes:{}` 空、属性は `attributes/tile_*.json` に `canonicalId` で分離
（usage / usageCategory / heightM / heightSource / wardId / confidence / …）。`normalizedUsage` 非 null 100%、
`wardInvalid 0`、PLATEAU は全て confidence 0.95。PLATEAU unclassified 10,378 棟（区外/ambiguous）は保守的に除外
（`--include-unclassified` で追加可）。canonical-buildings validator **PASS**。

## 14. attribute layer 分離

canonical geometry に用途・名前・人口・地価・施設を**全部埋め込まない**。

```
canonical/buildings ──join(canonicalId)──▶ buildingAttributes { usage, heightSource, confidence, ... }
canonical/water     ──join(canonicalId)──▶ waterAttributes   { name, waterType, navigable, ... }
将来: population / landPrice / realEstate / disaster / facility も canonicalId で join
```
31A では canonical feature の `attributes` に **name / waterType / surface** など「what」の最小限のみ保持。

## 15. style 完全分離

canonical geometry は**表示色・材質を持たない**（[`STYLE_SEPARATION`](tools/lib/canonical-geometry-schema.js)）。
color は style layer（ward-ux-v1.html の既存 palette）で決める: water `#9ed6e6` / road `#c4c8cc` / building usage palette。

## 16. LOD は derived layer

[`DERIVED_OUTPUT`](tools/lib/canonical-geometry-schema.js)。canonical geometry 自体は LOD で削らない。

```
data/processed/osaka-city/derived/{far, mid, near, ultra-near}/
```
canonical → simplify → tile clip → merged geometry → derived tile。
Mission 1〜30 の LOD 実装（RiverLayerV2 の 4 tier / CityBuildingLOD の band / road LOD 等）は
この derived 側へ**段階的に**統合する（31F/31G）。

## 17. tile 生成 pipeline

```
canonical water polygon
  → topology-preserving simplify（tolerance は derived band ごと）
  → tile clip（tileSize 2000。roads/parks/rail と揃える）
  → merged BufferGeometry（既存 tile 形式）
  → 既存 display layer が読む
```

## 18. canonical validation

[`tools/validate/canonical-geometry.js`](tools/validate/canonical-geometry.js) → [`canonical-geometry-validation.json`](data/reports/canonical-geometry-validation.json)

チェック: invalid geometry 0 / duplicate canonicalId 0 / bbox valid / area finite / provenance あり /
confidence valid / sourceIds あり / layer type valid / coordinates 有限 / coordinateConvention = znorth-neg-v1 /
schema lib 自己整合（SOURCE_PRIORITY 各 layer が末尾「生成しない」を持つ 等）/ production・protected HTML 不変。

**31A 実行結果**: water 587 feature / schemaErr 0 / dupId 0 / **RESULT PASS**。

## 19. conflict audit

[`tools/audit/canonical-conflicts.js`](tools/audit/canonical-conflicts.js) → [`canonical-conflicts.json`](data/reports/canonical-conflicts.json)

各 conflict に `severity` / `source`（どの source 由来か）/ `confidence` / `overlapAreaM2` / `cause` / `explanation`。
31A は Building∩Water のみ実計算。他 5 ペアは canonical roads/buildings 未構築で `pending`（構築後に自動で有効化）。

## 20. Mission 30 との統合

[`map-detail-audit`](tools/audit/map-detail-audit.js) は現在 7 レイヤーを個別に突合している。
将来（31F）これを **canonical geometry ベース**へ移行し、
「anomaly の cause 分類」を canonical の `qaFlags` / conflict と接続する。**31A では置換しない**。

## 21. migration plan

一気に全 layer を移行しない。**各段階で「既存描画を壊さない」ことを validator + npm test + smoke で保証**。

| 段階 | 内容 | 成果物 | 既存描画 |
|---|---|---|---|
| **31A** | 設計 + schema + water prototype + 大川監査 + road source 比較 | schema.js / water.json / 各 audit / この doc | 不変 |
| **31B** ✅ *(完了)* | canonical water 正式化（polygon-first・§4 merge・大川 polygon 化・Road∩Water 監査・tile prototype） | `canonical/water.json`（526 feat・polygon 75%）/ `canonical/water/`（tile）/ `canonical-water` validator PASS / `canonical-water-preview.geojson` | 不変（並行生成） |
| **31C** ✅ *(完了)* | canonical roads（**polygon source ゼロ → 全 ribbon fallback**・PLATEAU tran 監査・Building∩Road 監査・tile prototype） | `canonical/roads/`（42,547 feat・polygon 0%・**gitignore**）/ `canonical-roads` validator PASS / `canonical-road-preview.geojson` / source inventory | 不変（並行生成） |
| **31D** ✅ *(完了)* | canonical buildings（PLATEAU 574,112 + OSM fallback 41,505・**§5 geometry/attributes 分離**・duplicate 0）＋ road polygon source 取得準備（plateau-sources tranPattern 追加・acquisition report） | `canonical/buildings/`（615,617 feat・polygon 100%・**gitignore**・+`attributes/`）/ `canonical-buildings` validator PASS / `canonical-geometry` 3-layer 統合 / `road-polygon-source-acquisition.json` | 不変（並行生成） |
| **31C2** ⏸ *(STOP: tran 未取得)* | PLATEAU tran:Road 取得 → canonical roads polygon 化。**ネットワーク不可のため tran 未取得（§30 STOP）**。pipeline（`fetch-plateau --layer tran` / `convert-plateau-tran.js` / `build-canonical-roads` polygon-first / validator §28）は完成。ローカルで `MISSION31C2_RUNBOOK.md` を実行すれば polygon 化可能 | canonical/roads/ 再build（保留） | 不変 |
| 31E | canonical conflicts（全 6 ペア。HIGH の geometry 書き換えを個別判断） | conflict 解消ログ | 一部補正 |
| 31F | canonical map 統合（map-detail-audit を canonical ベースへ） | 統合 audit | 不変 |
| 31G | 既存 render layer 切替（derived tile を display layer が読む） | derived/ 統合 | **ここで初めて切替** |

## 完了条件（Mission 31A §23）

- [x] canonical geometry 設計完成（この doc + schema.js）
- [x] source priority 定義（`SOURCE_PRIORITY`。各 layer 末尾「生成しない」）
- [x] provenance schema 定義（`makeProvenance` / validator 強制）
- [x] confidence 設計（`CONFIDENCE` 10 段）
- [x] conflict QA 設計（`CONFLICT_PAIRS` / `CONFLICT_EXPLANATIONS` / `classifyConflictSeverity`）
- [x] style 分離（`STYLE_SEPARATION`。canonical は色を持たない）
- [x] LOD 分離（`DERIVED_OUTPUT`。canonical は LOD で削らない）
- [x] water prototype 設計 + 実装（`build-canonical-water.js` / 587 feature / PASS）
- [x] 大川 audit prototype（`okawa-canonical-water-audit.json`）
- [x] road source 比較（`canonical-road-source-comparison.json`）
- [x] building canonical 方針確定（§13。PLATEAU 原則 + OSM fallback）
- [x] migration plan 完成（31A→31G）
- [x] npm test fail 0 / 既存 validator PASS / smoke PASS / protected・production 不変
