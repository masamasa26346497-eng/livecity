# 大阪市24区 都市レイヤー展開 P1-6 ランブック
## 道路・河川・公園・鉄道

ネットワーク接続が必要な工程は **ローカルWindows PC / GitHub Actions** で実行する
（Claude Code サンドボックスからは Overpass 取得ができない）。

---

## 取得方式の役割分担（P1-6B で変更）

| 用途 | 方式 | ツール |
|---|---|---|
| **通常の都市一括生成（推奨）** | OSM PBF ローカル extract | `tools/import/osm-pbf-city.js` |
| 小規模差分・特定タイルの検証・緊急取得 | 公開 Overpass（タイル単位 failover） | `tools/download/city-tiles.js` |

P1-6 実機取得で、156タイル×4レイヤー = 624リクエストの公開 Overpass 依存が不安定（overpass-api.de:
network failure / 504、kumi.systems: 502 が継続）と判明したため、**本番の都市一括生成は PBF 方式を第一とする**。
Overpass 版（`city-tiles.js` / `overpass-failover.js`）は削除せず、小規模用途として残す。

---

## A. OSM PBF ローカル import（推奨・P1-6B）

### A-0. PBF を用意（ネットワーク必要・1回だけ）

`osm-pbf-parser` を使うので最初に一度だけ:
```bash
npm install          # osm-pbf-parser（pure JS）を入れる。他ツール・npm test には不要
```

大阪周辺の `.osm.pbf` を `data/raw/osm/` へ置く（`data/raw/` は .gitignore 済み）。取得先の例:
- **BBBike extract**（推奨・軽量） … https://extract.bbbike.org/ で大阪を矩形選択 → `.osm.pbf` をダウンロード。
  24区 bbox（S34.585 / W135.342 / N34.77 / E135.601）を少し広めに囲う。数十MB程度。
- **Geofabrik "Kansai"** … https://download.geofabrik.de/asia/japan/kansai.html （府をまたぐため大きめ）。
  そのままでも動くが、`osmium extract -b 135.33,34.57,135.61,34.79 kansai-latest.osm.pbf -o data/raw/osm/osaka.osm.pbf`
  で大阪市 bbox に切ると pass ごとの解凍が速くなる。

```
data/raw/osm/
  osaka-latest.osm.pbf
```

### A-1. 抽出（ネットワーク不要）

```bash
# まず疎通確認（抽出せず PBF を1回流し、node/way/relation が読めるか。全ブロック解凍のため数十秒〜）
node tools/import/osm-pbf-city.js --input data/raw/osm/osaka-latest.osm.pbf --area osaka-city --smoke

# 本抽出（3-pass。roads だけ試すなら --layer roads）
node tools/import/osm-pbf-city.js --input data/raw/osm/osaka-latest.osm.pbf --area osaka-city --layer all
# = npm run data:import:osm-pbf -- --input data/raw/osm/osaka-latest.osm.pbf --area osaka-city --layer all
```
> `osm-pbf-parser` の出力は `readable-stream@2` 系で `for await` 不可のため、`tools/lib/osm-pbf-stream.js` の
> `objectStreamToPrimitives()` が `'data'`/`'end'`/`'error'` を手動購読して async generator へ橋渡しする
> （backpressure 付き）。parser を差し替える場合もこのファイルだけを変更すればよい。
- PBF を **3回ストリーム**（relations → ways → nodes）。メモリは実際に使う地物ぶんに有界。
- config `layers.<layer>.osmFilter` と一致するタグ抽出（Overpass 版とスキーマ互換）:
  roads = `highway ~ ^(motorway|trunk|primary|secondary|tertiary|residential)$` /
  parks = `leisure=park` `landuse=grass` `landuse=recreation_ground` /
  railways = `railway ~ ^(rail|light_rail|subway)$` ＋ `node[railway=station]`（point feature）/
  waterways = `natural=water` `waterway ~ ^(river|canal)$` ＋ relation `natural=water` `waterway=riverbank`。
- relation multipolygon は member way を pass2 で解決し、`osm-multipolygon.js` の assemble が担当（P1-6 と同じ）。
- 大阪市 bbox + `--buffer`（既定 1000m）の外にしか無い feature は除外。
- 出力（Overpass `out geom` 互換 `{elements:[...]}`）:
  ```
  data/raw/osaka-city/roads-osm.json
  data/raw/osaka-city/waterways-osm.json
  data/raw/osaka-city/parks-osm.json
  data/raw/osaka-city/railways-osm.json
  ```
- レポート: `data/reports/osm-pbf-import.json`（PBF size / pass別parse time / peak RSS / feature数）。
- `--help` は入力・パッケージ無しで usage 表示。

### A-2. タイル化 → 検証（以降は P1-6 と共通）

```bash
node tools/build-city-layer-tiles.js --layer all --area osaka-city --public --force
node tools/validate/city-layer-tiles.js --area osaka-city
node tools/audit/water-source.js                      # 水域を OSM way/relation まで遡る監査（P1-6F）
```
`<layer>-osm.json` の生成元が Overpass でも PBF でも、`build-city-layer-tiles.js` 以降は完全に同じ。

- **[P1-6F] 24区外フィルタ**: `data/processed/osaka-city/boundaries/ward-classification-polygons.json` を使い、
  24区ポリゴン（境界 500m バッファ込み）と重ならない feature を除外する（尼崎側の猪名川ポリゴン等が
  「24区 bbox 矩形の隅」をかすめて残っていた問題の根本対処）。`--no-ward-filter` で無効化。
- **`--force`**: レイヤーの旧 `tile_*.json` / `manifest.json` を削除してから書き直す（stale tile を残さない）。
- feature には `source:{type, id, name, memberWayIds}` が付く。実機の `[WATER-DRAW-DEBUG]` で
  巨大 feature の OSM ID を特定できる。
- `data/reports/water-source-audit.json` … 水域 top20（bbox / area / 最大辺 / member way / 24区 overlap）。

---

## タイルグリッド仕様（確定値）

| 項目 | 値 |
|---|---|
| 基準 | `config/areas/osaka-city.json` の bbox（W135.342 / E135.601 / S34.585 / N34.770）+ projection |
| 座標規約 | znorth-neg-v1（北 = z 負。建物・HTML と同一。projection 原点は不変） |
| tile 一辺 | **2000 m**（`tiling.tileSizeMeters`） |
| グリッド | **13 列 × 12 行 = 156 タイル** / 原点タイル (tx=-9, tz=-10) |
| ローカル bbox | x ∈ [-16770, 6962]、z ∈ [-18456, 2138]（約 23.7km × 20.6km） |
| tile id | `tile_<tx>_<tz>.json`（`floor(x/2000)`, `floor(z/2000)`。建物 dataset と同一形式・道路/河川/公園/鉄道で共有） |
| buffer | 取得時に各タイル bbox を **150 m** 外側へ拡張（tile 境界での地物欠落防止） |
| feature 割当 | クリップせず「bbox が重なる全タイル」へ複製配置。**load 時に feature id で dedup** |

grid の実装は `tools/lib/city-tile-grid.js`（`createCityTileGrid`）。`tools/download/city-tiles.js` と
`tools/build-city-layer-tiles.js` の両方がこれを参照するため、Ward ごとの別座標系は生じない。

### tileSize 2000m の妥当性
- 156 タイル × 4 レイヤー = 624 Overpass リクエスト（rate limit 込みで現実的な範囲）。
- 実データ量（1タイルあたりの feature 数・ファイルサイズ）は取得後に
  `data/reports/city-layer-tiles-generation.json` で確認する。中心部（北区・中央区・浪速区）の
  道路タイルが 500KB を超える場合は **1500m へ縮小**を検討（コード変更不要、`--tile-size 1500` で再生成）。

---

## 0. 取得前の診断（ネットワーク不要）

```bash
# query が正しいか確認（tile / WGS84 bbox / bbox順序 / query全文 / bytes / filters）
node tools/download/city-tiles.js --layer roads --area osaka-city --tiles -1_-5 --print-query
```
tile -1_-5（都島区・城東区付近）の実 query は **163 bytes / `out geom;` / recursive expansion なし**:
```
[out:json][timeout:90];
(
  way["highway"~"^(motorway|trunk|primary|secondary|tertiary|residential)$"](34.6747254,135.5015553,34.6953866,135.5266571);
);
out geom;
```
WGS84 bbox は `south,west,north,east` の順・正しい向き・大阪市域内。**query 自体は失敗の原因ではない。**

```bash
# 1タイルだけ取得して error-body を確認（500/timeout の原因が分かる）
node tools/download/city-tiles.js --layer roads --tiles -1_-5
```
- HTTP 4xx/5xx / JSON parse 失敗時は **`[error-body]` に Overpass 応答の先頭〜1000字**を出力（rate limited / IP block /
  runtime error 等の理由が読める）。
- HTTP timeout は **QL timeout + 30s**（`--timeout 90` なら HTTP 120s）。AbortController が先に切れない。

## 1. Overpass からタイル単位で取得（ローカルPC・小規模/緊急用）

> **P1-6B**: 本番の一括生成は上の「A. OSM PBF ローカル import」を使う。以下は特定タイルの差分更新・
> 検証・PBF が用意できない場合の緊急取得用に残している。624リクエスト規模を公開 Overpass へ流さない。

**一括 bbox 取得はしない**（タイムアウト・メモリの両面で非現実的）。

```bash
# まず smoke（未取得の先頭1タイルだけ）。成功しなければ全取得へ進まない
node tools/download/city-tiles.js --layer roads --area osaka-city --smoke
```
- 連続 5 タイル失敗 かつ 成功 0 件で **全 156 タイルを回さず中断**（`[abort]`）。`--abort-after <n>` で調整、`0` で無効。
- サーバー障害中は時間をおくか `--endpoint https://overpass-api.de/api/interpreter` で別サーバー固定。

```bash
# 4レイヤーすべて（156タイル×4 = 624リクエスト。数十分〜。resume 対応）
node tools/download/city-tiles.js --layer all --area osaka-city

# 特定レイヤー / 特定タイルのみ
node tools/download/city-tiles.js --layer waterways --area osaka-city
node tools/download/city-tiles.js --layer roads --tiles -2_-1,0_-1,1_-1
```

- **複数 endpoint failover**（`tools/lib/overpass-failover.js`）:
  既定 `https://overpass-api.de/api/interpreter` と `https://overpass.kumi.systems/api/interpreter` を使い、
  **429 / 500 / 502 / 503 / 504 / timeout / network エラーでは同一 endpoint で粘らず即座に別 endpoint へ切替**。
  endpoint ごとに health（連続失敗数）を持ち、**連続3回失敗で 60〜180秒 cooldown**（健全な endpoint を優先）。
  429 は `Retry-After` を尊重。request 間隔（グローバル 1.2s / 同一endpoint 2.5s）で公開サーバへ配慮。
  - `--endpoint <url>`（複数可）で endpoint を明示指定できる:
    `node tools/download/city-tiles.js --layer roads --endpoint https://overpass-api.de/api/interpreter`
  - `--help` / `-h` で usage を表示して即終了（ネットワークアクセスなし）
- **request cache** … `data/raw/osaka-city/_cache/<layer>/tile_<tx>_<tz>.json`
- **resume** … 有効なキャッシュがあるタイルは**絶対に再取得しない**。途中失敗しても取得済みは温存。
  失敗タイルだけ `--tiles` で再実行すればよい
- ログ: `[fetch] tile=.. endpoint=..` / `[failover] from=.. to=..` / `[retry] ..` / `[cache] ..` / `[done] ..` /
  `[summary]`（cached / downloaded / failed / endpointFailures）
- 全タイル成功時のみ id で dedup マージ → `data/raw/osaka-city/<layer>-osm.json`

OSM フィルタ（`config/areas/osaka-city.json` の `layers.<layer>.osmFilter`）:
- roads: `way["highway"~"^(motorway|trunk|primary|secondary|tertiary|residential)$"]`
  - `service` / `unclassified` を足す場合は config を編集。描画量が 1.5〜2 倍になる想定 → 性能レポート必須
- parks: `way["leisure"="park"];way["landuse"="grass"];way["landuse"="recreation_ground"]`
- railways: `way["railway"~"^(rail|light_rail|subway)$"];node["railway"="station"]`
- waterways: `way["natural"="water"];way["waterway"~"^(river|canal)$"];relation["natural"="water"];relation["waterway"="riverbank"]`

---

## 2. タイル化・変換

```bash
node tools/build-city-layer-tiles.js --layer all --area osaka-city --public --force
```

- 座標変換は既存 `tools/convert/{roads,parks,railways,waterways}.js` を流用（`geoToLocal` は北=z正）し、
  本ツールが **z を反転して znorth-neg-v1** に揃える（`coordinateConvention: "znorth-neg-v1"` を stamp）。
- 河川は `tools/convert/waterways.js`（`assembleMultipolygon` / `stitchWays` 済み）を使用:
  - relation の outer member way を端点一致で連結（reversed 対応）
  - inner ring（中州）は `holes` として保持
  - **未連結 relation は描画しない**（`layerMeta.unclosedRelations` にカウント）
  - 巨大セグメント / 自己交差を含む area は除外（`layerMeta.oversizedDropped` / `selfIntersectionDropped`）
- 出力:
  ```
  data/processed/osaka-city/<layer>/manifest.json
  data/processed/osaka-city/<layer>/tiles/tile_<tx>_<tz>.json
  public/map-data/osaka-city/<layer>/manifest.json          (--public、HTML が fetch)
  public/map-data/osaka-city/<layer>/tile_<tx>_<tz>.json     (flat)
  ```
- 大容量なので生成物は `.gitignore`。`data/reports/city-layer-tiles-generation.json` に feature 数・tile 数を記録。

### 旧壊れ record を merge で温存しない
`tools/fetch-water.js` は `--replace` / `--no-merge` + merge 時の壊れ record フィルタ済み（P1-5B）。
`osaka_3d_buildings.html` の埋め込み OSM_WATER は `node tools/clean-embedded-water.js --html ... --write` で
`relation/18530061〜63` を除去済み。P1-6 の river tile は clean な再生成物。

---

## 3. 検証

```bash
node tools/validate/city-layer-tiles.js --area osaka-city
# または npm run data:validate:city-layer-tiles
```

共通チェック（error 重大度があれば exit 1）:
manifest/tile 存在・source count 整合・同一tile内 id 重複なし・finite・feature が tile bbox 内・
巨大セグメント（面）・自己交差（面）・coordinateConvention=znorth-neg-v1・24区 bbox coverage・
既存3区 coverage。**河川は water geometry validator を併用**（`oversized-segment 0` が目標）。

主要河川（大和川・淀川・寝屋川）は生成後に `data/reports/city-layer-tiles-validation.json` の
waterways セクションで `no-oversized-area-segments` / `water:no-oversized-segments` が PASS であることを確認。

---

## 4. HTML への統合（`public/osaka_3d_buildings.ward-ux-v1.html`）

`CityTileLayer`（新規・独立 IIFE、既存 RoadLayer/ParkLayer/WaterLayer には触れない）が
`map-data/osaka-city/<layer>/` を Ward 周辺タイルだけ progressive load する。
- Ward 選択 → camera 移動 → 建物 tile・道路 tile・河川 tile・公園 tile・鉄道 tile を**独立して**順次ロード
- 旧 Ward の不要 tile は LRU / dispose
- `[LAYER-PERF]` を console 出力
- データ未配置（404）時は既存の埋め込み3区レイヤーがそのまま動作（安全側）

### [P1-6E–G] 実機描画の診断フラグ

ブラウザの devtools console で:
```js
window.__WATER_DRAW_DEBUG__ = true;      // [WATER-DRAW-DEBUG]（feature 単位: sourceId / waterClass / family / giant / ok / reason）
window.__BUILDING_DRAW_DEBUG__ = true;   // [BUILDING-DRAW-DEBUG]（ward bbox ロードの要求/発行 tile 数）
BuildingTileLayer.getDrawDebug();        // 建物描画スコープ（camera / enabledDatasets / visibleTiles / visibleBuildings）

// [P1-6G] 河川描画方式の切替（同一視点で比較）
CityTileLayer.setWaterStyleMode('legacy');    // 旧: 全 water area を opacity 0.5 でベタ塗り
CityTileLayer.setWaterStyleMode('shoreline'); // 岸線のみ（fill 完全 off）
CityTileLayer.setWaterStyleMode('lod');       // 既定: 距離LOD（far=岸線 / mid=薄fill / near=通常fill、巨大河川は near のみ）
```
- 水域は `classifyWater`（tools/lib/water-classify.js）で river/canal/lake/pond/reservoir/harbour に分類。
  river/canal=岸線主体（距離LOD）、lake/pond/reservoir=面フィル、harbour=背景寄り。
- 距離しきい値: far>6000m / mid 3000–6000m / near<6000m。ward 選択時（≈3–5km）は mid。
- 巨大河川（outer bbox 対角 > 2500m: 大和川・神崎川・安治川等）は mid でもフィルを出さず岸線のみ。

### [P1-7] City Mode（大阪市24区全域表示）

Ward Mode に加え、エリア選択パネル最上部の「大阪市全域」で大阪市全体を一望できる。

- 建物: 24区すべての dataset を enable するが、実際に fetch されるのは camera 近傍 tile のみ
  （既存の ring 判定は無変更。574,112棟の一括ロードにはならない = Option A）。加えて
  `CityBuildingLOD`（P1-7B）が24区の軽量メッシュ（壁+屋根のみ・共有マテリアル1個・影なし）を
  1区ずつ progressive load し、camera 距離3000m未満で `BuildingTileLayer` 実体表示へ handoff する。
- 道路・河川・公園・鉄道: 156 tile を各レイヤーの manifest からそのまま取得し、中心→外の順で
  10 tile/バッチ・70ms 間隔の progressive load（`CityTileLayer.coverCityBbox()`）。
- 距離 LOD（P1-7B で再編）: 道路は major(幹線)常時・濃色 / secondary=常時・薄色 /
  local(tertiary+residential+不明)≤3500m。公園は 2ha 以上=常時 / それ未満=≤4000m。
  鉄道路線は常時、駅は≤5000m。水域は既存の P1-6G/H の LOD に加え、9000m 以遠でさらに岸線を
  減衰させる City Mode 用カーブ（basin/harbour除く）。
- カメラ: `getCityCameraTarget()` の `radiusFactor=0.5`（Ward用の0.62より詰めて大阪市模型が
  画面の大半を占めるように）。
- 「大阪市全域」選択のたびに console へ自動出力される `[CITY-PERF]` ログ:
  `firstRoadMs`/`firstWaterMs`/`firstParkMs`/`firstRailMs`/`loadedXxxTiles`/`drawCalls`/`geometries`/`triangles`。
- layer UI（左下パネル）: 建物/道路/河川/公園/鉄道/駅名 を個別 ON/OFF（「建物」は `CityBuildingLOD` にも連動）。
- 水域 area は `tools/lib/polygon-fill.js` と同じ検証（triArea/polyArea 比・1枚支配率・三角形重心）に通り、
  NG（自己交差・退化・bbox > 12km）は描画されず `ok:false` としてログに出る。実データは全件 `ok:true`。
- Ward 選択時は `getWardCameraTarget(wardId).bbox` を基に、建物（`loadDatasetBbox`）と都市レイヤー
  （`CityTileLayer.coverBbox`）が**同じ区 bbox 全域**を中心→外の順で段階ロードする（camera 位置に依存しない）。
- Ground extent（P1-7B）: `GroundVisualLayer` の表示範囲のみ `groundPad=9000` で外側へ拡張し、
  model style 時の地表色を fog 色寄りへブレンド。四角い外周が City Mode 遠景で目立ちにくくする
  （`OSAKA_CITY_GROUND_EXTENT` 定数自体は camera/tile grid 共有のため不変）。
- 大阪市外 feature の混入対策（P1-6F/P1-7B）: area/station は ward-polygon との overlap 割合で
  フィルタ、line（道路/鉄道/河川centerline）は `tools/lib/polyline-ward-clip.js` で頂点単位の
  真のクリップ（区境を跨ぐ長い道路/鉄道は Osaka 側の区間だけ残す）。再生成は
  `node tools/build-city-layer-tiles.js --layer all --area osaka-city --public --force` →
  `node tools/validate/city-layer-tiles.js --area osaka-city` で確認（PASS必須）。

`npm run preview` → ward-ux-v1.html で実機確認。

### [河川再導入] centerline+width ribbon方式（RiverLayerV2、全172河川表示）

旧河川描画（OSM water area polygonをそのまま塗る方式）は `WATER_LAYER_ENABLED = false`
（既定）でcanonical表示から完全に外れている。新しい河川は独立モジュール `RiverLayerV2`
（旧名 `CleanWaterLayer`。セッション6Mでリネーム）が
`public/map-data/osaka-city/rivers-v2/rivers.json` を読んで描画する。
主要7河川（淀川/大和川/神崎川/安治川/木津川/寝屋川/道頓堀川）は実機確認・承認済み
（セッション6N）で、**既定は全172河川（canal・小河川含む）表示**（`nameFilter`初期値=`null`）。
canal・小河川はminor tierとしてCity Mode遠景（camera距離6000m超）で自動的に非表示になる。

生成・検証コマンド（ネットワーク不要。既存 `public/map-data/osaka-city/waterways/` の
line/area featureから再構築するため、PBFの再取得は不要）:
```bash
node tools/build-river-layer.js          # rivers.json 生成（data/processed・public/map-data両方。全172河川分）
node tools/validate/river-ribbon.js      # river ribbon validator + 市外飛び出しチェック（PASS必須）
node --test tests/river-width.test.js tests/river-ribbon.test.js tests/river-ribbon-validator.test.js tests/river-ribbon-regression.test.js tests/river-layer-v2.test.js
```

ブラウザ devtools console での実機切り分け用コマンド（何も操作しなければ既定で全河川が
表示された状態になる）:
```js
RiverLayerV2.setNameFilter(['淀川']);                                          // 淀川だけに絞る
RiverLayerV2.setNameFilter(['淀川', '大和川', '神崎川', '安治川', '木津川', '寝屋川', '道頓堀川']); // 主要7河川のみ（旧第一段階相当）
RiverLayerV2.setNameFilter(null);                                              // 全河川へ戻す（既定）
RiverLayerV2.getStats();  // {riverCount, shownCount, skippedError, majorCount, minorCount, majorTriangles, minorTriangles, totalTriangles}

// 河川自体を完全に隠す場合:
RiverLayerV2.hide();

// 色・opacityを実機で調整する場合（Mission05。geometry/widthは変更しない）:
//   opacityは NEAR/MID/FAR × major/minor/shore の3バンド構成。
RiverLayerV2.setStyle({ fillColor: 0x9ed6e6, majorOpacity: 0.72, majorOpacityFar: 0.40, shoreOpacity: 0.50 });
RiverLayerV2.getStyle();         // 現在値を確認
RiverLayerV2.getDefaultStyle();  // 既定値
//   既定: fill #9ed6e6 / 岸線 #6fafc4
//   major opacity NEAR 0.72 / MID 0.55 / FAR 0.40（City Mode遠景でも残る）
//   minor opacity NEAR 0.62 / MID 0.44 / FAR 0.20（4500m超で非表示）
//   岸線 opacity   NEAR 0.50 / MID 0.40 / FAR 0.28
//   距離アンカー: NEAR<=2500m / MID=6000m / FAR>=14000m（間は線形補間）

// 建物干渉で suppress / shrink された小河川の確認（Mission04-B）:
RiverLayerV2.getConflictDebug();          // shrink/suppress された minor の一覧
RiverLayerV2.getConflictDebug({all:true}); // minor 全件

// 旧描画へ一時的に戻す場合のみ（デバッグ用。既定では絶対に使わない）:
window.WATER_LAYER_ENABLED = true; WaterLayer.show();
```

対象タグは `waterway=river/canal/riverbank`, `water=river` のみ（pond/lake/reservoir/harbour/
streamは現時点で未対応＝旧レイヤー停止の間はすべて非表示）。centerline+widthの計算ロジックは
`tools/lib/river-width.js`（幅推定: riverbank polygonからのcenterline断面実測→median、
widthタグ→未実装・default fallback）/ `tools/lib/river-ribbon.js`（miter clamp方式のoffset・
triangle化・maxTriangleEdge等の統計出力）が canonical。HTML側の `RiverLayerV2` はNode側で
計算済みのleft/right offset polylineをそのまま三角形化・岸線化するだけで、幅推定・offset計算を
ブラウザ側で再実装していない。`validationErrors`が付いたriverは自動的に描画から除外される。

---

## やってはいけないこと

- protected baseline `public/osaka_3d_buildings.fullward-v3.html` の変更
- projection 原点・znorth-neg-v1 の変更
- 行政区 polygon を水面 fill として使うこと
- 一括 bbox での Overpass 取得
- ネットワーク取得が必要な箇所で推測データを作ること
