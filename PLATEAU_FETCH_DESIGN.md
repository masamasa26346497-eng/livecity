# PLATEAU CityGML 自動取得 設計書

`tools/fetch-plateau.js` — PLATEAUの建物CityGMLを自動取得し、`data/raw/{datasetId}/` に配置する。
`setup-area.js` の STEP0 として自動実行されるため、区の追加に手動作業は発生しない。

## 全体フロー

```
node tools/setup-area.js --dataset osaka-higashisumiyoshi --ward 東住吉区 --ward-code 27114
        │
        ├─ STEP0  fetch-plateau.js                     ← 本設計書の対象
        │    ① URL解決（3段フォールバック）
        │    ② ダウンロード（リトライ・進捗・キャッシュ）
        │    ③ ZIP選択展開（中央ディレクトリ読取り → 必要エントリのみ）
        │    ④ 区コードで絞り込み（ファイル内容で判定）
        │    ⑤ 一時ファイル削除
        │         → data/raw/{datasetId}/*.gml
        │
        ├─ STEP1-3 原点較正（都市で初回のみ。既存configがあればスキップ）
        ├─ STEP4  convert-plateau-buildings.js  → data/processed/{datasetId}-buildings.json
        ├─ STEP5  split-building-tiles.js       → public/data/buildings/{datasetId}/ + 上位manifest登録
        └─ STEP6  fetch-overlays.js             → public/data/overlays/{datasetId}.json
                    ↓
             ブラウザ再読込 → BuildingTileLayer と OverlayDataLoader が manifest から自動登録
```

## ① URL解決 — 3段フォールバック

配布URLの変更に対してコード修正を不要にするための多重化。

| 優先 | 手段 | 使う場面 |
|---|---|---|
| 1 | `--url <zip>` | 配布URLが判明している / 検証用 |
| 2 | `data/plateau-sources.json` | 運用側でURLを管理したい。`wards.{区コード}.url` → `cities.{市コード}.url` の順に参照 |
| 3 | CKAN API 検索 | 上記が未設定でも自動探索。`package_search` の結果からZIPリソースを抽出しスコア順に採用 |

CKANのスコアリングは「URL/名称に citygml を含む(+2)」「bldg・建築物・建物を含む(+2)」「市コードを含む(+3)」の合計。
`--list` で候補一覧のみ表示でき、意図と違うものが選ばれる場合は `--url` か設定ファイルで確定させられる。

CKANのベースURLは `--ckan-base` / 環境変数 `PLATEAU_CKAN_BASE` で差し替え可能（サイト移転・社内ミラー・オフライン検証に対応）。

**区コード → 市コードの導出**：`27114`（東住吉区）→ 上位3桁 + `00` = `27100`（大阪市）。
横浜 `14101`→`14100`、名古屋 `23101`→`23100` と同じ規則で、政令指定都市全般に適用できる。`--city-code` で明示指定も可能。

## ② ダウンロード

- 3回リトライ（指数的待機）、`content-length` があれば3秒ごとに進捗表示
- `.cache/plateau/` に保存。既存ファイルがあれば再ダウンロードしない
- 書込中は `.part` 拡張子を使い、完了時にリネーム（中断ファイルを正規ファイルと誤認しない）

## ③ ZIP選択展開 — 全展開しない

PLATEAUの市単位ZIPは数GBに達するため、全展開は非現実的。本ツールは次の方式を採る。

1. ファイル末尾から EOCD（End Of Central Directory）を探索
2. Zip64（4GB超・65535エントリ超）の場合は Zip64 EOCD ロケータを辿る
3. 中央ディレクトリを読み、全エントリの名前・サイズ・オフセットを取得
4. `bldgPattern` に一致するエントリのみ、ローカルヘッダを読んで該当バイト範囲だけを読み出し `inflateRaw` で展開

不要なファイル（テクスチャ・codelists・地物種別違いのGML）はディスクに書き出されない。
外部コマンド（`unzip` / PowerShell `Expand-Archive`）に依存しないため、Windows/Linux/macOS で同一に動作する。

対象判定の正規表現は `data/plateau-sources.json` の `patterns` に外出ししてある。

```json
"patterns": {
  "gmlPattern":  "\\.gml$",
  "bldgPattern": "(^|/)[^/]*bldg[^/]*\\.gml$"
}
```

`bldgPattern` に一致するエントリが0件の場合は、**全GMLを対象とするフォールバック**が働く（命名規則が変わっても取得自体は継続する）。

## ④ 区の絞り込み — ファイル名ではなく内容で判定

PLATEAUの建物GMLは**メッシュ単位**（例 `52350512_bldg_6697_op.gml`）で分割されており、
ファイル名に区名・区コードを含まない。したがって次の方式を採る。

- 展開した各GMLの内容に**区コード文字列（例 `27114`）が含まれるか**で判定する
- 含まないファイルは即削除する

PLATEAUの建物には `uro:BuildingIDAttribute` などに市区町村コードが格納されるため、
この判定は命名規則の変更から独立している。区をまたぐメッシュは両区で採用される（建物単位の重複は
`split-building-tiles.js` と `BuildingTileLayer` のID重複除外が処理する）。

`--ward-code` を省略すると絞り込みを行わず、市全体の建物GMLを取得する。

## ⑤ 一時ファイル削除

- 展開作業用の `.cache/plateau/tmp-{datasetId}/` は処理後に削除
- ダウンロードしたZIPも削除（`--keep-archive` で保持可能。複数区を続けて追加する場合に有効）
- 区コード不一致のGMLは判定直後に削除（ディスクに残さない）

## 冪等性

`data/raw/{datasetId}/` にGMLが既に存在する場合は取得をスキップする。
`setup-area.js` を何度実行しても再ダウンロードは発生しない。`--force` で強制再取得。

## 実行コマンド

```powershell
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# 区を1コマンドで追加（取得 → 変換 → タイル → オーバーレイ → manifest登録）
node tools/setup-area.js --dataset osaka-higashisumiyoshi --ward 東住吉区 --ward-code 27114

# 取得のみ実行したい場合
node tools/fetch-plateau.js --dataset osaka-higashisumiyoshi --ward-code 27114

# 配布リソースの候補を確認（ダウンロードしない）
node tools/fetch-plateau.js --city-code 27100 --list

# 取得計画のみ表示
node tools/fetch-plateau.js --dataset osaka-higashisumiyoshi --ward-code 27114 --dry-run

# 配布URLが判明している場合は直接指定（CKAN検索を経由しない）
node tools/setup-area.js --dataset osaka-higashisumiyoshi --ward 東住吉区 `
  --ward-code 27114 --url https://.../27100_osaka-shi_citygml.zip
```

主なオプション: `--out`（展開先）、`--cache`（アーカイブ保存先）、`--keep-archive`、`--force`、
`--sources`（定義ファイルのパス）、`--ckan-base`、`--city-code`。

## 配布形式が変わったときの対応手順

| 変化 | 対応 | コード変更 |
|---|---|---|
| 配布URLが変わった | `data/plateau-sources.json` の `url` を更新、または `--url` 指定 | 不要 |
| CKANのURLが変わった | `--ckan-base` / 環境変数 `PLATEAU_CKAN_BASE` | 不要 |
| ZIP内のディレクトリ構成が変わった | 再帰探索のため影響なし | 不要 |
| GMLの命名規則が変わった | `patterns.bldgPattern` を更新（未一致時は全GMLへ自動フォールバック） | 不要 |
| 区コードの格納形式が変わった | 内容一致判定のため、コードが文字列として含まれる限り影響なし | 不要 |
| 圧縮方式が deflate 以外になった | 展開器の対応追加が必要 | 要 |

## 検証結果（モック配布サーバ・ローカル）

外部ネットワーク不通の環境のため、配布サーバとCKAN APIをローカルにモックして全経路を検証した。
検証データはPLATEAU配布ZIPの構造（`udx/bldg/` 配下のメッシュ単位GML、`codelists/`、README）を模し、
東住吉区(27114)2メッシュ・住吉区(27115)1メッシュ・阿倍野区(27120)1メッシュを格納。

| 検証 | 結果 |
|---|---|
| `--url` 直接指定 | ダウンロード → 9エントリ走査 → 建物GML 4件検出 → **2件展開/2件除外** (397ms) |
| CKAN自動探索 | `package_search` からZIPリソースを特定し同一結果 |
| 区コード絞り込み | 27114の2ファイルのみ採用、27115/27120を削除 |
| 選択展開 | codelists・READMEは展開されず |
| `setup-area.js` 一発 | STEP0取得 → STEP4変換(200棟) → STEP5タイル(3タイル)+manifest登録まで**手動介入なし** (1,832ms) |
| 冪等性 | 再実行時「取得済みのためスキップ」 |
| 一時ファイル | アーカイブ・tmpディレクトリとも削除済み |
| `--dry-run` | 取得計画のみ表示 |
| 指定漏れ時 | `--ward-code` / `--url` / `--citygml` の案内を表示して停止 |

Zip64経路は実データ規模（4GB超）でのみ通るため、モックでは未通過。実データ投入時に確認が必要。
