# 大阪市24区 都市レイヤー展開 P1-6 ランブック
## 道路・河川・公園・鉄道

ネットワーク接続が必要な工程は **ローカルWindows PC / GitHub Actions** で実行する
（Claude Code サンドボックスからは Overpass 取得ができない）。

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

## 1. Overpass からタイル単位で取得（ローカルPC）

**一括 bbox 取得はしない**（タイムアウト・メモリの両面で非現実的）。

```bash
# 4レイヤーすべて（156タイル×4 = 624リクエスト。数十分〜。resume 対応）
node tools/download/city-tiles.js --layer all --area osaka-city

# 特定レイヤー / 特定タイルのみ
node tools/download/city-tiles.js --layer waterways --area osaka-city
node tools/download/city-tiles.js --layer roads --tiles -2_-1,0_-1,1_-1
```

- retry / exponential backoff / rate limit … `tools/lib/overpass.js` に委譲
- **request cache** … `data/raw/osaka-city/_cache/<layer>/tile_<tx>_<tz>.json`
- **resume** … 有効なキャッシュがあるタイルは再取得しない。途中失敗しても取得済みは温存。
  失敗タイルだけ `--tiles` で再実行すればよい
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

`npm run preview` → ward-ux-v1.html で実機確認。

---

## やってはいけないこと

- protected baseline `public/osaka_3d_buildings.fullward-v3.html` の変更
- projection 原点・znorth-neg-v1 の変更
- 行政区 polygon を水面 fill として使うこと
- 一括 bbox での Overpass 取得
- ネットワーク取得が必要な箇所で推測データを作ること
