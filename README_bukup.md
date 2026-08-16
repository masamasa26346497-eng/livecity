# LiveCity データ取り込み基盤

Live City（大阪都市デジタルツイン）向けの、再利用可能なデータ取得・変換・配信パイプラインです。
対象地域を `config/areas/` に1つJSONを追加するだけで、新しい区・市・府全域へ拡張できます。

## 実行環境の分離（重要）

| 環境 | 役割 | ネットワーク |
|---|---|---|
| Claude Code（このサンドボックス） | スクリプトの作成・修正・fixtureベースのテスト | 利用不可 |
| ローカルWindows PC / 将来のGitHub Actions | 実際のデータ取得（Overpass API、大阪市、社人研等への接続） | 利用可能 |

**`data:download`系コマンドは実際にネットワークへ接続するため、Claude Code環境では実行できません。**
`data:process`系、`data:catalog`、テスト(`npm test`)はネットワーク不要で、Claude Code環境でも動作確認できます。

## コマンド一覧

```bash
npm install   # 外部パッケージ依存ゼロ（Node.js 18+組み込み機能のみ使用）
npm test      # fixtureベースのテストスイート（ネットワーク不要）

# データセット一覧・取得元の到達確認
npm run data:catalog          # ネットワーク不要
npm run data:check-sources    # ネットワーク必要（ローカル実行）

# 都市データ（道路・公園・鉄道・水域・施設）- 既存パイプライン
npm run data:import -- --area osaka-sumiyoshi
npm run data:import:urban -- --area osaka-sumiyoshi   # 上と同じ

# 人口統計（フェーズB、新規）
npm run data:download:demographics -- --area osaka-sumiyoshi
npm run data:process:demographics -- --area osaka-sumiyoshi
npm run data:import:demographics -- --area osaka-sumiyoshi   # 上2つを一括実行
```

**重要な修正（フェーズA）**: 以前の`data:import`は`"npm run A && npm run B"`という構成のため、
`-- --area X`がBにしか渡らないバグがありました（実機で再現確認済み）。現在は`tools/orchestrate.js`が
Node.js側で明示的に各ステップを呼び出し、area引数を全工程へ確実に伝播させます。

### 期待される結果

`data:download:demographics` 実行後:
- `data/raw/{area}/census/` にXLSX/CSVと、取得メタデータ（`*.meta.json`、取得元・取得日時・ダウンロードURL・ライセンス）
- 累積CSV等、ファイル名が毎回変わる配布物は配布ページからリンクを検出してから取得する
  （固定URLを仮定しない。検出失敗時はサイト構成変更の可能性を示すエラーで停止する）

`data:process:demographics` 実行後:
- `data/processed/{area}/demographics/` に整形済みJSON、`public/map-data/{area}/demographics/` に配信用JSON
- 町丁目コードでの結合に失敗したレコードは `*.unmatched.json` に分離保存（黙って削除しない）
- `data/manifests/{area}-demographics.json` に件数・検証結果

### うまくいかない場合

`data:download`系でエラーが出た場合、エラーメッセージとコンソール全体のログ、
生成された`data/manifests/{area}-demographics.json`の内容をそのままClaude Codeに貼り付けてください。

## ディレクトリ構成

```
config/areas/{areaId}.json     地域定義（境界・対象レイヤー・人口統計対象行政区）
config/datasets/{datasetId}.json  データセット定義（取得元URL・ライセンス・分類等）
data/raw/{areaId}/             取得した生データ + メタデータ
data/processed/{areaId}/       変換後データ（整形済み、確認用）
data/manifests/                検証結果・件数・サイズ等の記録（ドメインごとに分離）
public/map-data/{areaId}/      配信用データ（LiveCity本体が実際に読み込む）
tools/orchestrate.js           パイプライン共通オーケストレーター（area引数を確実に伝播させる）
tools/download/                データ取得スクリプト（ネットワーク接続必須）
tools/convert/                  変換スクリプト（ネットワーク不要）
tools/join/                     地域コード結合・crosswalk（ネットワーク不要）
tools/calculate/                派生値の計算（livecity-calculated、ネットワーク不要）
tools/lib/                      共通ライブラリ（座標変換・XLSX読込・Overpassクライアント等）
tests/                          fixtureベースのテストスイート
```

## LiveCity本体（3Dマップ）のローカルプレビュー

`public/osaka_3d_buildings.html` は、人口・世帯・年齢・地域統計・施設の各情報を
HTML内に埋め込まず、`public/map-data/{areaId}/…/*.json` を **fetchで読み込む** 設計です。

そのため、HTMLファイルを **`file://` でブラウザに直接ドラッグして開くと、
ブラウザのセキュリティ制限（fetchのCORS/ローカルファイル制限）により統計JSONの取得に失敗し、
統計情報が表示されません**（地図・建物は表示されますが、人口・世帯・年齢・地域統計・施設が出ません）。

必ず `public/` フォルダを **ローカルHTTPサーバー経由で配信** して開いてください。

### 必要なファイル配置

```
public/
├─ osaka_3d_buildings.html
└─ map-data/
   └─ osaka-sumiyoshi/
      ├─ demographics/
      │  ├─ summary.json
      │  ├─ age-structure.json
      │  └─ town-stats.json
      └─ facilities/
         └─ facilities.json
```

`osaka_3d_buildings.html` と `map-data/` が **同じ `public/` 内に同居**していることが前提です。

### 起動手順（Windows）

いずれかの方法で `public/` を配信します。

**方法A（Python。Windowsに標準またはpython.orgのPythonがあれば利用可）**

```
cd public
python -m http.server 8000
```

ブラウザで次を開く:

```
http://localhost:8000/osaka_3d_buildings.html
```

**方法B（Node.js。`npx` が使える場合）**

```
npx serve public
```

表示された `http://localhost:xxxx` のURLから `osaka_3d_buildings.html` を開きます。

> macOS / Linux でも同じコマンドで動作します（`python` が `python3` の場合は読み替えてください）。

### 統計JSONが取得できているかの確認

サーバー起動後、以下のURLへ直接アクセスし、いずれも **HTTP 200** で中身（JSON）が表示されれば正常です。

```
http://localhost:8000/map-data/osaka-sumiyoshi/demographics/summary.json
http://localhost:8000/map-data/osaka-sumiyoshi/demographics/age-structure.json
http://localhost:8000/map-data/osaka-sumiyoshi/demographics/town-stats.json
http://localhost:8000/map-data/osaka-sumiyoshi/facilities/facilities.json
```

なお、`file://` で開いた場合は画面上部に赤い警告バナーが表示され、
ブラウザの開発者コンソール（F12）にも同趣旨の警告が出ます。
バナーが出たら、上記のHTTPサーバー経由での起動に切り替えてください。

## valueTypeの区別

全ての数値データは次のいずれかの`valueType`を持ちます。公式値と計算値・推計値は常に区別されます。

- `official`: 国勢調査等の公式統計値そのまま
- `official-estimate`: 推計人口等、公式機関による推計値
- `livecity-calculated`: 公式値からLive City側で計算した値（比率・増減率等）
- `livecity-estimate`: 公式データが存在しない粒度をLive City独自に推計した値（現時点では未実装）

## 町丁目境界データの優先順位（恒久対応）

人口統計と町丁目境界の結合には、次の優先順位を適用します。

1. **正式境界データ**（`data/processed/{areaId}/boundaries/administrative-boundaries.json`）
   - 入力元の無加工ファイルは `data/raw/{areaId}/boundaries/` に配置する。
   - `boundaryDataStatus: "official"`, `officialBoundary: true`
   - 配置すると、暫定データより**必ず**優先されます（混在しません）。
2. **暫定境界データ**（`data/raw/{areaId}/administrative-boundaries.json`）
   - Live City本体HTML内の`TOWN_POLYGONS`（出典未確認の旧データ）から構築。
   - `boundaryDataStatus: "legacy-unverified"`, `officialBoundary: false`
   - 正式データ未配置時、または正式データの読み込みに失敗した場合のフォールバックとしてのみ
     使用されます。削除しません。

どちらの状態でも、**人口・世帯・年齢構成の値自体は常に公式統計**です。`boundaryDataStatus`は
「境界との対応関係」の信頼度を示すものであり、統計値自体の信頼度（`valueType`）とは独立した
情報です。

### 使用する正式境界データの取得元

| 項目 | 内容 |
|---|---|
| データセット名 | 国勢調査町丁・字等別境界データセット（2020年版） |
| 提供機関（一次） | 総務省統計局（e-Stat 統計地理情報システム） |
| 提供機関（二次配布、GeoJSON形式） | Geoshapeリポジトリ（ROIS-DS人文学オープンデータ共同利用センター, CODH） |
| 取得元URL | https://www.e-stat.go.jp/gis/statmap-search?type=2（一次） / https://geoshape.ex.nii.ac.jp/ka/（GeoJSON配布） |
| ライセンス | CC BY 4.0 |
| クレジット表記 | 『国勢調査町丁・字等別境界データセット』（CODH作成）「令和2年国勢調査町丁・字等別境界データ」（e-Stat）を加工 doi:10.20676/00000450 |
| 基準年月 | 令和2年（2020年）10月1日 |
| 対象地域 | 大阪市住吉区・東住吉区・平野区 |
| 主属性 | `KEY_CODE`（11桁、先頭5桁=市区町村コード、残り6桁=町丁字コード）, `PREF_NAME`, `CITY_NAME`, `S_NAME` |

上記は2026年6月にWeb調査で直接確認した内容です（Geoshapeリポジトリの個別ページ
`https://geoshape.ex.nii.ac.jp/ka/resource/27/27120024003.html` を実際に取得し、ライセンス・
出典クレジット・DOIを確認済み）。

**重要な制約**: 本プロジェクトを動かしているClaude Code環境にはネットワークアクセスがないため、
実際のGeoJSONファイル（住吉区・東住吉区・平野区全域分）を自動的にダウンロードすることはできません。
推測でAPIエンドポイントを構築してアクセスすることも行っていません（架空のデータを生成しない
方針のため）。**ローカルPCまたはCI環境でのみ、以下の手順を実行してください。**

### 正式境界データの取得手順（ローカルPC等、ネットワーク接続可能な環境で実行）

1. e-Stat統計地理情報システム（https://www.e-stat.go.jp/gis/statmap-search?type=2）にアクセスし、
   「境界データダウンロード」から「令和2年国勢調査 小地域（町丁・字等）」を選択する。
   都道府県「大阪府」を指定し、「世界測地系・緯度経度座標系・GeoJSON形式」（または該当形式）を
   選択してダウンロードする。
   - あるいは、Geoshapeリポジトリ（https://geoshape.ex.nii.ac.jp/ka/）が提供するGeoJSON配布
     エンドポイントから直接取得する方法もある（リポジトリのトップページから配布形式・URLパターンを
     確認すること。本READMEはAPIエンドポイントを推測で記載しない）。
2. ダウンロードしたファイルを**無加工のまま**次の場所へ保存する。

   ```
   data/raw/osaka-sumiyoshi/boundaries/official-source.geojson
   ```

3. 取り込みコマンドを実行する。

   ```bash
   node tools/ingest/official-boundaries-from-geojson.js \
     --area osaka-sumiyoshi \
     --input data/raw/osaka-sumiyoshi/boundaries/official-source.geojson \
     --reference-date 2020-10-01 \
     --license "CC BY 4.0" \
     --source-name "国勢調査町丁・字等別境界データセット" \
     --provider "総務省統計局（e-Stat） / Geoshapeリポジトリ（CODH）" \
     --retrieved-url "https://geoshape.ex.nii.ac.jp/ka/" \
     --retrieved-at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
     --source-filename "official-source.geojson"
   ```

   これにより `data/processed/osaka-sumiyoshi/boundaries/administrative-boundaries.json` が
   生成され、以降の `data:process:demographics` 実行時に自動的に優先されます。

4. 比較レポートを生成し、TOWN_POLYGONSとの差異を確認する（任意、推奨）。

   ```bash
   node tools/compare/boundary-comparison.js --area osaka-sumiyoshi
   ```

### 結合キー

正式コードでの結合は `municipalityCode + chochoCode` の複合キー（形式: `27120:030010`）を使います。
両方の値は**文字列のまま保持し、数値化しません**（数値化すると先頭ゼロが失われ、桁数が不安定に
なるため）。`chochoCode`単独は区内連番のため、複合キーを使わないと異なる区で偶然同じコードが
衝突するリスクがあります。複合キーで結合できない場合のみ、正規化町名でのフォールバック結合を
行います。

各レコードには結合結果の状態が保存されます。

- `joinMethod`: `municipality-and-chocho-code` | `full-normalized-name` | `normalized-name` | `unmatched`
- `joinConfidence`: `high`（正式コード結合） | `fallback`（町名結合） | `unavailable`（未結合）
- `displayStatus`: `in-current-render-area`（既定値） | `outside-current-render-area`
  （対象地域外として地図表示しない判断をした場合。統計未結合とは区別する）

## 既知の制約

- 推計人口・将来推計人口は**行政区単位までしか公式データが存在しません**。町丁目別の値への
  機械的な配分は行いません。
- **正式境界データ（属性・コードのみ）は住吉区・東住吉区分を取得済みです。**
  Geoshapeリポジトリ（`https://geoshape.ex.nii.ac.jp/ka/`、CC BY 4.0）の市区町村別一覧ページを
  `web_fetch`で取得し、206件（住吉区104件・東住吉区102件）の標準地域コード・名称・人口・世帯数を
  `data/raw/osaka-sumiyoshi/boundaries/`へ無加工保存し、`data/processed/osaka-sumiyoshi/boundaries/
  administrative-boundaries.json`へ変換済みです。これにより**正式コード（municipalityCode+
  chochoCode）での結合が203件**（取得対象342件のうち）成立しています（以前は0件）。
- **属性データの公式性と境界形状の公式性は別の軸として明確に区別しています。**
  公式属性データ（コード・名称・人口・世帯数）が存在することは、ポリゴン頂点座標（境界形状
  そのもの）の公式性を保証しません。本パイプラインは各町丁目につき以下のいずれかの
  `boundaryDataStatus`を持ちます。
  - `official`: 公式属性＋有効な公式Polygon/MultiPolygon形状の両方を保持（現状0件）
  - `official-attributes-with-legacy-geometry`: 公式属性データを持ち、形状は暫定TOWN_POLYGONS
    （出典未確認）で補完（201件）。`officialBoundary`は常に`false`のまま——形状自体は依然
    検証されていないため。
  - `official-attributes-only`: 公式属性データのみで、形状（公式・暫定いずれも）が無い（5件:
    `住吉区杉本三丁目`・`東住吉区今林一丁目`・`住吉区長峡町`・`住吉区山之内元町`・
    `東住吉区長居公園`、いずれも丁目区分の無い大字・字レベルの地名でTOWN_POLYGONS自体に
    元々収録されていない）。
  - `legacy-unverified`: 公式属性データが無く、暫定データのみ（公式データ未取得時の従来挙動）。
  **ポリゴンの頂点座標（境界形状そのもの）自体は、いずれの場合も「公式」としては未取得です。**
  地図上のポリゴン描画は依然`TOWN_POLYGONS`（暫定データ）を使用し続けます。
- **平野区の境界データは未取得です**（今回の取得指示範囲は住吉区・東住吉区のみ）。これにより
  人口統計342件のうち139件（すべて平野区）が`reasonCode: "official-boundary-not-acquired-for-this-ward"`
  として未結合のままです。これは表記揺れやデータ品質の問題ではなく、単純に取得範囲外であることが
  原因です。
- `住吉区杉本三丁目`（人口3人・世帯3、秘匿扱い）・`東住吉区今林一丁目`（人口0人・世帯0、秘匿では
  なく真の0）は、いずれも正式コード結合（`joinConfidence: high`）で解決済みです。Geoshapeリポジトリの
  個別ページで実在を確認しています。
- タイル分割（`tools/tile/`）は現在のエリア規模では無効化されています。
