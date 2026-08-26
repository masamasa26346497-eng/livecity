# AutoDev Run

実行日時: 2026-08-23
タスクID: P0-3
タスク名: superseded load cleanup調査

RESULT:
SUCCESS

## 調査結果
- superseded generationで生成されたtileはloadAllTiles()内でhide()され、loaded-hidden状態になる。
- remote + loaded-hidden tileはfull-mode datasetを除外せずmaxCachedHiddenTilesのLRU管理対象になる。
- LRU上限超過時はtile.dispose()が呼ばれ、sceneからmeshを除去しgeometryをdisposeする。
- superseded generation完了後もFullWardManager.getLoadingState()にstale stateは残らない。
- disposed remote tileのmetadataは既定120000ms経過後にevictTileMetadata()で回収される。
- metadata evictionでもfull-mode datasetを除外する条件は無い。
- よってsuperseded専用の新しいorphan cleanup機構は不要と判断した。

## 変更ファイル
- tests/superseded-load-cleanup.test.js
- AUTODEV_BACKLOG.md
- AUTODEV_REPORT.md

## テスト結果
- node --test tests/superseded-load-cleanup.test.js: 5 pass / 0 fail
- npm test: fail 0
- git diff --check: PASS

## 結論
P0-3は調査完了。Ward lifecycleの再設計や新しいorphan cleanup機構は追加していない。

## 次の課題
P1-1 残り21区の行政区境界取得パイプライン調査。
AutoDev運用側には、ログファイルが一時ロックされた際にwrapperが落ちる問題が残っている。

---

# AutoDev Run

実行日時: 2026-08-26
タスクID: P1-1
タスク名: 残り21区の行政区境界取得パイプライン調査

RESULT:
NEEDS_USER_DECISION

## 調査

- Ward Registry (`config/wards/registry.json`) は既に大阪市24区すべてのid/code/townPrefix/datasetIdを
  保持している。`tools/build-ward-poc-data.cjs`は各区のtownPrefixに一致するpolygonが
  `--town-polygons`入力(TOWN_POLYGONS.json)に1件も無い区を自動的にスキップする設計であり、
  Registry自体は21区追加のボトルネックではない。
- Ward Mode（建物のpoint-in-polygon区分類）が実際に参照する境界ポリゴンは、Live City本体HTML
  埋め込みの`TOWN_POLYGONS`（住吉区・東住吉区・平野区、340町丁目）のみであり、その出典は
  `boundaryDataStatus: "legacy-unverified"`と明記の通り**未確認**（`tools/extract/boundary-master-from-html.js`
  はこの既存データを再パッケージするだけで、新たな座標は一切生成しない）。
- 既存の「正式境界取り込み」パイプライン(`tools/ingest/official-boundaries-from-geojson.js`)は
  KEY_CODE・Polygon/MultiPolygon geometry・既存projection.jsによるThree.js座標変換に対応した
  実装が既にあるが、これはあくまで**人口統計の複合キー結合用の属性マスタ
  (data/processed/{areaId}/boundaries/administrative-boundaries.json)** を作るためのものであり、
  Ward Mode描画用のポリゴンとは別系統。
- `data/raw/osaka-sumiyoshi/boundaries/official-source.geojson`(住吉区・東住吉区、206件)を実際に
  確認したところ、`geometry`フィールドは204件が`null`、残り2件（今林一丁目・杉本三丁目）のみ
  Point(中心点)で、real Polygon/MultiPolygon頂点座標は1件も含まれていない。
  `metadata.json`にも「ポリゴンの詳細頂点座標は本ページに含まれておらず、取得できていない」
  「平野区の境界データは今回取得対象外」と明記されている。
  つまり既存の「official」境界データ取得は、Geoshapeリポジトリの町丁目一覧HTMLページを
  web_fetchで取得した属性テーブルであり、実ポリゴン形状の取得ルートではない。
  `official-boundaries-from-geojson.js`は実際にはまだ「real polygon付きGeoJSON」を一度も
  入力として受け取ったことがない。
- 上記より、Ward Modeの点内判定に使える「出典確認済みの実ポリゴン座標」は、現状どの区についても
  存在しない（既存3区分もlegacy-unverified）。21区分を追加するには、住吉区・東住吉区で試みた
  「web_fetchでHTML表を取得」方式では実ポリゴンが手に入らないことが既に判明しているため、
  別の取得ルート（e-Stat/Geoshapeの本来のShapefile/GeoJSON配布、または国土数値情報の行政区域
  データ等）を新たに特定する必要がある。
- `config/areas/`には`osaka-sumiyoshi.json`（住吉区・東住吉区・平野区、bbox・projection origin固定）
  しか存在せず、残り21区または大阪市全域をどう`config/areas/*.json`としてスコープするか
  （区ごとに分けるか、大阪市全域1エリアにまとめるか）自体が未決定。これはprojection原点・bboxの
  設計に波及する。

## 変更ファイル
- AUTODEV_REPORT.md（本エントリ追記のみ）

## 実装内容
なし（調査のみ。コード変更・データ取得は行っていない）。

## テスト
コード変更なしのため実施せず。

## テスト結果
該当なし。

## Git

branch: autodev/2026-08-26
commit: (wrapper側で判断、本タスクはNEEDS_USER_DECISIONのためcommit対象コード変更なし)
push: 未実施

## 残課題
P1-1は未着手のまま。実ポリゴン座標の取得ルートとconfig/areasのスコープ設計が確定するまで
21区の境界取り込みパイプラインは着手不可。

## 実機確認事項
なし。

## ユーザー判断が必要な点
1. 21区分の行政区ポリゴン（実頂点座標）をどこから取得するか。
   - 既存の「Geoshape町丁目一覧HTML」方式は属性のみでポリゴン座標を含まないため不採用。
   - e-Stat/Geoshapeの本来のGISデータ配布（Shapefile/GeoJSON、実ポリゴン付き）のURLとライセンスを
     確定する必要がある。取得はネットワーク接続が必要なため、ローカルPC/将来のGitHub Actions側での
     実行が前提になる（CLAUDE.mdの実行環境分離方針どおり）。
   - 代替として、現行のlegacy-unverified TOWN_POLYGONSと同様に出典未確認のまま暫定形状を
     追加するという妥協策もあり得るが、AUTODEV_RULES.md 1条（実コード優先）・6条
     （productionデータ保護）に照らし、AutoDevの判断だけで新たな出典未確認データを追加してよいか
     ユーザー確認が必要。
2. 21区分（または大阪市全域）を`config/areas/*.json`としてどう区切るか
   （区ごとに個別area config／大阪市全域1エリアへ再設計）。
   projection原点・bboxに影響するため、AUTODEV_RULES.md 4条により自動決定しない。

## USER_DECISION 2026-08-26

P1-1のユーザー判断を以下で確定する。

1. 行政区境界のcanonical source
   - 国土交通省「国土数値情報 N03 行政区域データ」2026年版を採用する。
   - 大阪市24区の行政区外周およびWard classificationの基準に使用する。
   - N03_005（政令指定都市の行政区名）等を使用して大阪市24区を抽出する。
   - ライセンス・出典・基準年月日・測量法上の注意事項をmetadataへ必ず記録する。

2. 町丁目ポリゴン
   - e-Stat「令和2年国勢調査 町丁・字等境界データ」を採用する。
   - 町丁目表示、町丁目属性、人口統計等とのjoinに使用する。
   - e-Stat自身が示す「実際の町丁境界とは一致しない場合がある」という注意事項をmetadataへ記録する。
   - 行政区外周のcanonical判定をe-Statだけに依存しない。

3. Geoshape
   - 調査・検証・開発補助には使用可。
   - canonical sourceにはしない。

4. legacy-unverified
   - 現在の3区TOWN_POLYGONSは互換性維持のため直ちには削除しない。
   - 残り21区へlegacy-unverified形状を新規追加することは禁止。
   - 公式データ移行後に3区も同一pipelineへ置換する。

5. area設計
   - 大阪市24区は共通の1 area / 1 projectionとして設計する。
   - config/areas/osaka-city.jsonを新設する方向とする。
   - 現在のprojection originおよびznorth-neg-v1を維持し、既存3区の座標を変えない。
   - bboxは大阪市24区全域へ拡張する。
   - Wardごとのdataset管理はconfig/wards/registry.jsonに維持する。
   - config/areas/osaka-sumiyoshi.jsonは移行完了まで破壊的変更しない。

6. 実装順序
   - まず取得・ライセンス・属性schema・座標変換を検証する小さなP1-1実装を行う。
   - 一度に21区datasetをproduction化しない。
   - validatorを通してから段階的にregistryのdataReadyを更新する。

この決定を前提にP1-1を再開する。

## USER_DECISION 2026-08-26 P1-1 continuation

P1-1の追加判断を以下で確定する。

- Option 2を採用する。
- 実N03データの取得を待たず、まずN03 ingestion toolを実装する。
- synthetic fixtureを使用したテストを許可する。
- fixtureは国土交通省「国土数値情報 N03 行政区域データ 2026年版」の公式schemaを根拠に作成する。
- 少なくとも N03_001, N03_004, N03_005, N03_007 と Polygon/MultiPolygon geometry を検証対象にする。
- 大阪府 / 大阪市 / 24行政区以外を誤って採用しないようfail-fastで検証する。
- 実データ投入時にschema不一致があれば推測で補正せずエラー終了する。
- productionデータ、既存3区、config/areas/osaka-sumiyoshi.jsonはこの段階では変更しない。
- config/areas/osaka-city.jsonのproduction確定も実N03検証後とする。
- 実N03ファイル取得後、synthetic fixtureとのschema整合性を必ず再検証する。

またAutoDev無人実行中はユーザーへ対話質問を出さないこと。
判断が足りない場合は質問文で終了せず、
AUTODEV_RESULT=NEEDS_USER_DECISION
を必ず出力し、判断事項をAUTODEV_REPORT.mdへ記録すること。

## REAL_N03_VALIDATION 2026-08-27

実N03 2026大阪府GeoJSONで以下を確認した。

- 大阪市の行政区数: 24
- 大阪市に該当するsource Feature数: 39
- geometry: MultiPolygon 39件
- N03_004 = "大阪市"
- N03_005 = 行政区名（例: "都島区"）
- N03_007 = 5桁の全国地方公共団体コード

P1-1の実装を以下の通り修正する。

1. N03属性対応
   - N03_005 は ward name として扱う。
   - N03_007 は ward code として扱う。
   - N03_005 と config/wards/registry.json の ward.name を照合する。
   - N03_007 と registry の ward.code を照合する。
   - name/codeのどちらか一方でも不一致ならfail-fastする。

2. 複数Feature
   - 同一wardCodeの複数Feature出現は正常データとして扱う。
   - 重複エラーにしてはならない。
   - 同一区の複数Polygon/MultiPolygonを1 ward recordへ安全に統合する。
   - source feature数もmetadataへ保持する。
   - 最終結果は大阪市24 ward recordsになることを検証する。

3. fixture/test
   - synthetic N03 fixtureを実N03 schemaに合わせて修正する。
   - N03_005に区名、N03_007に5桁codeを格納する。
   - 同一区が複数Featureに分割されるfixtureを追加する。
   - 24区/39 Feature相当の構造を扱えることをテストする。
   - name/code mismatchはfail-fastすることをテストする。

4. production保護
   - 実N03原本は変更しない。
   - 既存3区datasetおよびprotected HTMLは変更しない。
   - config/areas/osaka-city.jsonはまだproduction確定しない。
   - WGS84構造検証を先に完了する。

この実データ確認結果はユーザー判断済みとして扱い、対話質問せず修正を進める。
