# Mission 31 ランブック — 大阪市北部 OSM 道路 SOURCE_MISSING 完全解消

> **ネットワークが必要な工程はローカル PC / GitHub Actions で実行する**
> （Claude Code サンドボックスからは PBF ダウンロードができないため、この工程はユーザー環境で実施する）。

## 背景（Mission 31 §1 で監査済み）

現在の `data/raw/osm/osaka-latest.osm.pbf` は **道路データが lat ≈ 34.735 で切れている**
（road way に属する node の緯度ヒストグラムで確認: lat 34.73 に 20,634 点 → lat 34.74 に 352 点の cliff）。

| | 値 |
|---|---|
| 大阪市 N03 24区 bbox | S 34.586154 / **N 34.768849** / W 135.343508 / E 135.599350 |
| 必要 bbox（+3km margin・N03 から自動算出） | S 34.559205 / **N 34.795798** / W 135.310767 / E 135.632091 |
| 現 PBF road-way-node bbox | S 34.547 / **N 34.7545** / W 135.274 / E 135.700 |
| 北側の不足 | **約 4.6km**（東淀川区の北 ~78% / 淀川区の北 ~25%） |

影響区: **東淀川区（road cell coverage 10%）・淀川区（57%）** — `roadStatus: SOURCE-MISSING`。

## 手順（ユーザー環境で実行）

### 1. より広域の PBF を取得

必要 bbox `[S 34.559205 / N 34.795798 / W 135.310767 / E 135.632091]` を**完全に包含する** PBF を用意する。
推奨（優先順）:

- **A. 大阪府全域 PBF** — Geofabrik の `kansai-latest.osm.pbf`（関西広域。大阪府を完全包含）
  `https://download.geofabrik.de/asia/japan/kansai-latest.osm.pbf`
- **B. BBBike の大阪圏カスタム抽出** — `https://extract.bbbike.org/` で上記 bbox（少し広め）を指定
- **C. osmium で大阪府全域から市域を切り出し**（既に kansai PBF があるなら）

既存 `osaka-latest.osm.pbf` は**破壊せず**、新ファイルは別名で保存:

```bash
# 例: Geofabrik 関西
curl -L -o data/raw/osm/osaka-full-coverage.osm.pbf \
  https://download.geofabrik.de/asia/japan/kansai-latest.osm.pbf

# （任意）大きすぎる場合は osmium で市域 + margin に絞る
# osmium extract -b 135.310767,34.559205,135.632091,34.795798 \
#   data/raw/osm/osaka-full-coverage.osm.pbf -o data/raw/osm/osaka-city-clip.osm.pbf
```

### 2. ソースカバレッジを検証（import 前ゲート）

```bash
node tools/audit/osm-source-coverage.js --pbf data/raw/osm/osaka-full-coverage.osm.pbf --rescan
node tools/validate/osm-source-coverage.js
```

→ **RESULT: PASS** を確認する（`contains: {north:true, south:true, east:true, west:true}` かつ cliff なし）。
FAIL なら PBF がまだ市域を包含していない。次へ進まない。

### 3. roads を再 import（Mission 26 の highway class を全維持）

```bash
# npm script（data:import:osm-pbf）は既定 PBF を使うため、--input で新 PBF を指定して直接呼ぶ:
node tools/import/osm-pbf-city.js --input data/raw/osm/osaka-full-coverage.osm.pbf --area osaka-city --layer roads
```

- 維持される class: motorway / trunk / primary / secondary / tertiary（+ *_link）/ residential /
  living_street / service（alley 含む）/ unclassified / road / track / pedestrian
- 出力: `data/raw/osaka-city/roads-osm.json`（上書き）

### 4. （§6 副作用チェック）他レイヤーも再 import して before/after 比較

```bash
# 現行件数を控える
node -e "for (const l of ['roads','waterways','parks','railways']) { const j=require('./data/raw/osaka-city/'+l+'-osm.json'); console.log(l, (j.elements||j).length); }"

node tools/import/osm-pbf-city.js --input data/raw/osm/osaka-full-coverage.osm.pbf --area osaka-city --layer all
node tools/build-osm-building-fallback.js   # 建物 fallback も新 PBF で
```

**異常な減少（10% 超）があれば STOP** し、旧 `osaka-latest.osm.pbf` へ戻す。

### 5. tile を再生成

```bash
node tools/build-city-layer-tiles.js --layer roads --area osaka-city --public --force
# 副作用があった場合は他レイヤーも
node tools/build-city-layer-tiles.js --layer all --area osaka-city --public --force
node tools/build-river-layer.js
```

### 6. 監査を再実行（SOURCE_MISSING は自動で再評価される）

```bash
node tools/audit/road-network.js
node tools/audit/building-coverage.js
node tools/audit/building-visual-gap.js
node tools/audit/map-completeness.js
node tools/audit/map-detail-audit.js

node tools/validate/road-density.js
node tools/validate/road-network.js
node tools/validate/building-density.js
node tools/validate/map-completeness.js
node tools/validate/map-detail-audit.js
node tools/validate/performance-budget.js
npm test
node tests/_ward-ux-v1-smoke-harness.cjs
git diff --check
```

**期待**: `road-network-coverage.json` の `density.sparseWards` / `sourceMissingWards` が
**空**になり、`map-completeness` の 東淀川区・淀川区 `roadStatus` が `SOURCE-MISSING` → `PASS`、
`map-detail-audit` の `sourceMissing` が **空**、24区 road SOURCE_MISSING = 0。

### 7. （任意）新 PBF を canonical に昇格

副作用チェックが問題なければ、`osaka-full-coverage.osm.pbf` を canonical に。
`tools/import/osm-pbf-city.js` の使用例・README の PBF path を更新し、
旧 `osaka-latest.osm.pbf` は `data/raw/osm/_archive/` へ移動（削除しない）。

## SOURCE_MISSING vs SOURCE_SPARSE（§18）

再 import 後、`road-network-coverage.json` の `density`:

- **`sourceMissingWards`**（区の最北端が現 PBF の road cliff 緯度より北 & sourceMissingCells ≥ 15%）
  → PBF 拡張で**解消可能**。現状 `[yodogawa, higashiyodogawa]`。
- **`sourceSparseWards`**（PBF 範囲内だが当該区の道路が OSM 未整備）
  → PBF 拡張では解消しない。**OSM への実データ投入待ち**（§0: 架空生成しない）。現状 `[]`。

新 PBF で `sourceMissingWards` の道路が実在すれば、その区は自動的に PASS へ変わる。
それでも道路が薄ければ `sourceSparseWards` へ移動し、SOURCE_SPARSE として区別表示される。
