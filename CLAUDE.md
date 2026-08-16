# CLAUDE.md

このファイルは、Claude Code がこのリポジトリで作業する際のガイドです。
**事実ベース**: 以下は実際にアップロードされたリポジトリ一式（config/, tools/, tests/, data/, public/）を
読んだ上での記述です。推測や一般論は含めていません。

## プロジェクト概要

`livecity-data-pipeline`（v0.2.0）は、大阪都市デジタルツイン「Live City」向けの、再利用可能な
データ取得・変換・配信基盤です。対象地域を `config/areas/` に1つJSONを追加するだけで拡張できる
設計を志向しています。現在の対象エリアは `osaka-sumiyoshi`（大阪市住吉区・東住吉区・平野区）。

Live City本体は単一の静的HTML（`public/osaka_3d_buildings.html`、3800行超）で、Three.jsによる
3D都市ビューです。このパイプラインは、そのHTMLが `fetch()` で読み込む `public/map-data/{areaId}/...`
配下のJSONを生成する役割を担います。

## 実行環境の分離（重要）

| 環境 | 役割 | ネットワーク |
|---|---|---|
| Claude Code（このサンドボックス） | スクリプトの作成・修正・fixtureベースのテスト | 利用不可 |
| ローカルWindows PC / 将来のGitHub Actions | 実際のデータ取得（Overpass API、大阪市、e-Stat等への接続） | 利用可能 |

`data:download`系・`data:check-sources`はネットワーク接続が必須のため、Claude Code環境では実行できない
（試みると失敗する）。`data:process`系、`data:catalog`、`npm test`はネットワーク不要で、Claude Code環境
でも実行・検証できる。

## コマンド一覧（package.json実測）

```bash
npm install   # 外部パッケージ依存ゼロ（dependencies/devDependenciesとも空。Node.js 18+組み込み機能のみ）
npm test      # 9本のtestファイルをnode --testで実行（後述「テストスイートの注意点」を参照）

# データセット一覧・取得元の到達確認
npm run data:catalog          # ネットワーク不要
npm run data:check-sources    # ネットワーク必要（ローカル実行のみ）

# 都市データ（道路・公園・鉄道・水域・施設）
npm run data:import -- --area osaka-sumiyoshi        # data:import:urban のエイリアス
npm run data:import:urban -- --area osaka-sumiyoshi
npm run data:download                                 # tools/download/index.js を直接叩く低レベルコマンド
npm run data:process                                   # tools/convert/index.js を直接叩く低レベルコマンド
npm run data:validate                                  # tools/validate/index.js

# 人口統計（フェーズB）
npm run data:download:demographics -- --area osaka-sumiyoshi
npm run data:process:demographics -- --area osaka-sumiyoshi
npm run data:import:demographics -- --area osaka-sumiyoshi   # 上2つを一括実行
npm run data:update:demographics -- --area osaka-sumiyoshi

# 施設データ（拡張・LIFEタブ用）
npm run data:download:facilities -- --area osaka-sumiyoshi
npm run data:process:facilities -- --area osaka-sumiyoshi
npm run data:import:facilities -- --area osaka-sumiyoshi

# 個別データセットの更新（download→processをNode.js側で明示的に連結。--areaを両工程へ確実に伝播）
npm run data:update:households -- --area osaka-sumiyoshi        # osaka-census-2020-household-composition
npm run data:update:population-change -- --area osaka-sumiyoshi # osaka-census-2015-population-households

# 境界データ
npm run data:ingest:boundaries      # tools/ingest/official-boundaries-from-geojson.js
npm run data:compare:boundaries     # tools/compare/boundary-comparison.js

# integration test（ネットワーク必要、通常のnpm testには含まれない）
npm run test:integration:estat
```

**過去の修正（フェーズA）**: 以前の`data:import`は`"npm run A && npm run B"`という構成のため、
`-- --area X`がBにしか渡らないバグがあった（実機で再現確認済み）。現在は`tools/orchestrate.js`が
Node.js側で明示的に各ステップを呼び出し、area引数を全工程へ確実に伝播させる。`tools/update-dataset.js`
も同じ理由で同様の構成を取っている。

## ディレクトリ構成（実測）

```
config/areas/{areaId}.json        地域定義（bbox・投影法・対象レイヤー・人口統計対象行政区）
config/datasets/{datasetId}.json  データセット定義（取得元URL・ライセンス・valueType等、全7件）
config/facilities/categories.json 施設カテゴリ・OSMタグ分類ルール
data/raw/{areaId}/                取得した生データ + メタデータ（*.meta.json）
data/processed/{areaId}/          変換後データ（整形済み、確認用）
data/manifests/                   ドメインごとの検証結果・件数記録
data/reports/                     境界結合レポート・legacy比較・validation report
public/map-data/{areaId}/         配信用データ（Live City本体HTMLが実際にfetchする）
public/osaka_3d_buildings.html    Live City本体（単一HTML、Three.js）
tools/orchestrate.js              パイプライン共通オーケストレーター（urban/demographics/facilitiesをarea引数付きで実行）
tools/update-dataset.js           個別データセット単位のdownload→process連結スクリプト
tools/download/                   データ取得スクリプト（ネットワーク接続必須）
  ├─ index.js                     都市データ（roads/parks/railways/waterways/facilities）取得エントリ
  ├─ facilities.js                拡張施設データ（Overpass）取得
  └─ census/index.js              e-Stat国勢調査データ取得
tools/convert/                    変換スクリプト（ネットワーク不要）
  ├─ index.js, roads.js, parks.js, railways.js, waterways.js, facilities.js, facilities-extended.js
  └─ demographics/                population-households.js, age-structure.js, household-composition.js, population-2015.js, index.js
tools/calculate/                  派生値の計算（livecity-calculated）
  ├─ demographics-ratios.js, population-change.js
tools/join/chocho-crosswalk.js    町丁目コードのcrosswalk結合
tools/ingest/official-boundaries-from-geojson.js  正式境界データの取り込み
tools/extract/boundary-master-from-html.js         既存HTML内TOWN_POLYGONSからの暫定境界マスタ抽出
tools/compare/                    boundary-comparison.js, legacy-vs-official.js
tools/merge/town-stats.js         人口+世帯+年齢構成の統合統計生成（地域統計タブ用）
tools/tile/index.js               タイル分割（現状 config 上は無効。「知られている制約」参照）
tools/validate/                   index.js, boundary-join-report.js
tools/catalog.js                  データセットカタログ表示（ネットワーク不要）
tools/check-sources.js            取得元URLへのHEADリクエストによる到達確認（ネットワーク必要）
tools/lib/                        共通ライブラリ（座標変換・XLSX読込・Overpassクライアント・e-Statクライアント等）
  └─ __fixtures__/                テスト用fixtureデータ（boundaries/, demographics/, estat/, facilities.raw.json 等）
tests/                            fixtureベースのテストスイート（12ファイル）
```

## valueTypeの区別

全ての数値データは次のいずれかの`valueType`を持つ。公式値と計算値・推計値は常に区別される。

- `official`: 国勢調査等の公式統計値そのまま
- `official-estimate`: 推計人口等、公式機関による推計値
- `livecity-calculated`: 公式値からLive City側で計算した値（比率・増減率等）
- `livecity-estimate`: 公式データが存在しない粒度をLive City独自に推計した値（現時点では未実装）

## 町丁目境界データの優先順位（恒久対応）

1. **正式境界データ**（`data/processed/{areaId}/boundaries/administrative-boundaries.json`）
   - `boundaryDataStatus: "official"` または `"official-attributes-with-legacy-geometry"`（属性は公式だが
     頂点座標が暫定形状の場合）
2. **暫定境界データ**（Live City本体HTML内の`TOWN_POLYGONS`から抽出、出典未確認）
   - `boundaryDataStatus: "legacy-unverified"`, `officialBoundary: false`
   - 正式データ未配置時、または結合失敗時のフォールバックとしてのみ使用。**削除しない**（HTML側の
     `LEGACY_TOWN_DATA_UNVERIFIED`定数として隔離保持されており、`tests/html-regression.test.js`が
     この変数の存在を回帰テストで保護している）。

どちらの状態でも、人口・世帯・年齢構成の値自体は常に公式統計。`boundaryDataStatus`は「境界との
対応関係」の信頼度を示すものであり、統計値自体の信頼度（`valueType`）とは独立した情報。

## HTMLへの大量データ直接埋め込みに関する現状（重要・要注意）

README等に記載された設計方針は「HTMLへ新しいデータを直接ハードコードせず、`public/map-data/`から
`fetch`で読み込む」というものであり、**この方針は今回新たに追加された人口統計・施設データについては
実際に守られている**（`DemographicsDataStore`, `AgeStructureDataStore`, `TownStatsDataStore`,
`FacilityDataStore` はいずれも `public/map-data/{areaId}/...` を非同期fetchする実装になっており、
`public/osaka_3d_buildings.html` 内に確認済み）。

一方で、**建物データ（`const BLDGS = [...]`）・道路（`RoadLayer`）・公園（`ParkLayer`）・施設ラベル
（`LabelLayer`）・暫定町丁目境界（`const TOWN_POLYGONS = {...}`）は、現時点でも巨大なJSONリテラルとして
HTML内に直接埋め込まれたままである**（このHTMLファイルは3800行超で、大部分がこれらの座標データ）。

これは既存パイプライン（PLATEAU建物データ等）が本リファクタ開始前から存在していたためで、
`tools/convert/roads.js` / `parks.js` / `railways.js` / `waterways.js` などの変換スクリプト自体は
存在するが、**それらの出力先である `roads.json` / `parks.json` / `railways.json` / `waterways.json`
は `data/raw/`・`data/processed/`・`public/map-data/` のいずれにも実際には見つからない**
（`config/areas/osaka-sumiyoshi.json` ではこれらのlayerは`enabled: true`だが、実行済みの成果物が
リポジトリ内に存在しない）。つまり、これらの都市レイヤーをHTMLの直接埋め込みから`public/map-data/`
経由のfetchへ移行する作業は、**着手されていない、または過去に実行されたが本アップロードには
含まれていない**状態。この点は着手前に必ずユーザーに確認すること。

## Live City本体HTML（`public/osaka_3d_buildings.html`）の主な構成要素（実測）

- **タブ構成**: 基本(`pc-tab-basic`)、年齢(`pc-tab-age`)、地域統計(`pc-tab-townstats`)、生活(`pc-tab-life`)
- **データストア**（いずれも`public/map-data/osaka-sumiyoshi/...`を非同期fetch、状態は
  `loading|ready|error|no-data`）:
  - `DemographicsDataStore`: `demographics/summary.json` + `metadata.json`
  - `AgeStructureDataStore`: `demographics/age-structure.json` + `age-structure-metadata.json`
  - `TownStatsDataStore`: `demographics/town-stats.json`（342件想定、O(1)Map参照設計）
  - `FacilityDataStore`: `facilities/facilities.json` + `metadata.json`（距離計算はstraight-line、
    Haversineではなく既存`geoToThree()`と同一の局所正角円筒図法ベース）
- **検索**: 画面上部の`search-box`/`search-input`、`findSpot()`関数によるジオコーディング的検索
- **カメラ**: 独自実装の`OrbitControls`相当コード（Three.js本体のOrbitControlsは使用していない）
- **夜景モード**: `toggleNight()`（`#btn-night`ボタン）
- **建物クリック**: `selectBuilding(e, h)` → `showPropertyCard(h.d)` → 生活タブ更新
  （`updateLifeTab`は`selectBuilding`末尾から1回だけ呼ばれる設計。`showPropertyCard`内では呼ばない
  二重呼び出し防止済み。`tests/lifestyle-tab-wiring.test.js`で保護）
- **正規化**: `normalizeTownName()`（漢数字↔算用数字、全角↔半角、「大阪市」prefix有無を統一）。
  各データストアの`normalizeKey`はすべてこの共通関数に委譲している
  （重複した脆弱な独自実装が復活していないことを`html-regression.test.js`が検証）

## テストスイートの注意点（実測・要注意）

`npm test` は次の9ファイルのみを実行する:
```
demographics.test.js, paths.test.js, html-regression.test.js, boundary-master.test.js,
household-composition.test.js, population-2015.test.js, population-change.test.js,
demographics-pipeline-isolation.test.js, facilities-extended.test.js
```
（実行結果: 116 tests / 116 pass / 0 fail / 0 skip。html-regression.test.jsは`public/osaka_3d_buildings.html`
が標準候補パスに存在すれば実行され、存在しなければ自動skipされる設計）

**`tests/lifestyle-tab.test.js`（27件）と`tests/lifestyle-tab-wiring.test.js`（11件）は
`npm test`のスクリプトに含まれていない**。個別に実行する必要がある:
```bash
node --test tests/lifestyle-tab.test.js tests/lifestyle-tab-wiring.test.js
```
（このリポジトリの内容で実行すると38件とも pass する）

`tests/integration/estat-download.integration.test.js` はネットワーク接続が必要なため、
`npm run test:integration:estat` で別途明示的に実行する（`npm test`には含まれない）。

## 既知の課題（data/manifests, data/reports から実測）

- **平野区**: `data/manifests/osaka-sumiyoshi-demographics.json`によれば、行政区単位の統計データ
  342件のうち139件が`unmatchedReason: "コードが町丁目マスタに存在しない（複合キーで未検出）"`として
  未結合（`data/reports/demographics-unmatched.json`で確認、全件`ward: "平野区"`）。境界データの
  `boundaryDataStatus`は`official-attributes-with-legacy-geometry`
  （公式属性206件・正式頂点座標0件・暫定形状201件・座標なし5件・合計342件の内訳）。
- **推計人口の町丁目別配分**: 未実装（行政区単位データのみ存在）。
- **都市レイヤー（道路・公園・鉄道・水域）のmap-data移行**: 上記「HTMLへの大量データ直接埋め込みに
  関する現状」を参照。

## 今後の開発予定（README記載、着手状況は未確認）

1. グラフィック品質向上（リアル表示↔データ表示切替、ライト/影、屋根/側面表現、道路/公園/樹木改善、
   空/フォグ/トーンマッピング、昼/夕/夜切替）
2. ハザードマップ・避難所・避難経路
3. バリアフリー
4. 将来人口・時系列
5. 徒歩・自転車ルート、公共交通
6. 大阪市全域・全国への拡張

## 作業時の注意

- **`data:download`系コマンドを実行しようとしない**（このサンドボックスにネットワークがないため
  必ず失敗する）。ユーザーにローカルPCでの実行を依頼すること。
- 座標変換式（`geoToThree()` / `config/areas/*.json`の`projection`）は「既存の建物データと座標系が
  ズレるため変更禁止」と明記されている。変更が必要な場合は必ずユーザーに確認する。
- HTMLを編集する際は、必ず`node --test tests/html-regression.test.js`（および該当すれば
  `lifestyle-tab*.test.js`）を実行し、既存レイヤー・データストアの重複/消失がないか確認する。
- 新しいデータセットを追加する場合、`public/osaka_3d_buildings.html`への直接埋め込みではなく
  `public/map-data/{areaId}/...`経由のfetchで配信する設計方針を踏襲する。
