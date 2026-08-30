# 大阪市24区化 進捗レポート

大阪市24区の地図基盤構築（第一目標）の作業ログ。新しいエントリを上に追記する。

---

## 2026-08-31 セッション2: 河川geometry修正（OSM multipolygon連結）

### 実行したタスク
`tools/fetch-water.js` / `tools/convert/waterways.js` を調査し、OSM multipolygon relation の
outer member way を端点一致で連結して閉リングを構成するよう修正した。

### 調査結果（確定した原因）
- 旧 `tools/fetch-water.js` は relation の outer member way を **1本ずつ独立した閉ポリゴン**として
  `THREE.ShapeUtils.triangulateShape` に渡していた。member way は単独では閉じていないため、
  三角形分割時に**終点→始点をむすぶ暗黙の閉合辺**が生成される。
- 埋め込み済み `OSM_WATER` を実測したところ、`relation/18530061`〜`18530063`（大和川河岸）が
  それぞれ複数の `area` レコードに分裂し、各レコードの暗黙閉合辺が **4466m / 4879m / 5843m** と
  地物全体（約2km幅の河岸）を横断していた。これが「川面を横切る巨大三角形」の正体。
- `tools/validate/water-geometry.js --html public/osaka_3d_buildings.html` で現行ビルドを検証すると
  この6レコードが `no-oversized-segments` FAIL として検出される（`data/reports/water-geometry-validation.json`）。

### 修正内容
- **`tools/lib/osm-multipolygon.js`（新規）**: `stitchWays()` / `assembleMultipolygon()`。
  - outer/inner を role で分け、端点一致で way を連結（逆順wayも吸収）。
  - 連結しても閉じないリング片は `unclosed` として返す（黙って三角形分割しない）。
  - inner ring（中州）を保持し、内包する outer へ point-in-polygon で割り当てる。
- **`tools/lib/geometry-anomaly.js`（新規）**: `analyzeRing()`。巨大セグメント（中央値×20 かつ >800m、
  または bbox対角比指定時はその比）・自己交差（O(n²)）・非有限・退化・**暗黙閉合辺**を検出。
  `tools/lib/boundary-ingestion-validator.js` の重複ロジックをここへ集約（挙動は不変、テスト14件green）。
- **`tools/lib/water-geometry-validator.js` / `tools/validate/water-geometry.js`（新規）**: OSM_WATER形式
  （JSON または HTML埋め込み）の幾何異常検証CLI。`npm run data:validate:water`。
- **`tools/fetch-water.js`（変更）**: `--overpass` の relation 分岐を `assembleMultipolygon` ベースへ。
  面レコードに `holes` を追加。未連結フラグメントは `stats.skippedUnclosed` に計上し警告出力、描画に出さない。
  クエリに `relation["waterway"="riverbank"]` を追加。way / line の既存挙動は不変。
- **`tools/convert/waterways.js`（変更）**: relation 分岐を追加（同じ共通libを使用）。`convertWaterwaysWithReport()`
  で `unclosed` も返す。既存の way→line / 閉way→area の出力契約（`{type,name,p}`）は維持し `kind`/`holes` を追加。
- **`public/osaka_3d_buildings.html` WaterLayer（変更）**:
  - `appendArea` が `holes`（中州）を `triangulateShape` へ渡すよう対応。
  - `ringHasSpanningEdge()` ガードを追加。地物を横断する巨大な辺（暗黙閉合辺含む）を持つリングは
    三角形分割せずスキップ。これにより**データ再生成前の現行ビルドでも大和川の巨大三角形が描画されなくなる**。
  - protected baseline `osaka_3d_buildings.fullward-v3.html` は変更していない。
- **`tools/lib/area.js`（変更）**: `loadAreaConfig` が UTF-8 BOM 付き area config も読めるよう先頭BOM除去
  （下記「未解決/注意」参照）。

### 変更ファイル一覧
```
新規: tools/lib/osm-multipolygon.js
新規: tools/lib/geometry-anomaly.js
新規: tools/lib/water-geometry-validator.js
新規: tools/validate/water-geometry.js
新規: tools/lib/__fixtures__/water/overpass-water-sample.json
新規: tests/osm-multipolygon.test.js         (8 tests)
新規: tests/water-geometry.test.js           (7 tests)
新規: data/reports/water-geometry-validation.json  (現行ビルドの検出結果=6件FAIL、修正前の記録)
変更: tools/fetch-water.js
変更: tools/convert/waterways.js
変更: tools/lib/boundary-ingestion-validator.js  (共通libへ委譲。挙動不変)
変更: public/osaka_3d_buildings.html            (WaterLayer のみ)
変更: tools/lib/area.js                          (BOM許容)
変更: package.json                               (test へ2ファイル追加、data:validate:water 追加)
```

### テスト結果
- `npm test`: **167 tests / 152 pass / 0 fail / 15 skip**（セッション1の 152/137 から +15）。
- `tests/osm-multipolygon.test.js` 8/8、`tests/water-geometry.test.js` 7/7。
- `LIVECITY_HTML_PATH=public/osaka_3d_buildings.html node --test tests/html-regression.test.js`: **15/15 pass**
  （WaterLayer変更後も RoadLayer/ParkLayer/BLDGS/LabelLayer/行政区境界の重複・消失なし、JS構文OK）。
- 「大和川の巨大三角形が消えることの確認」: fixture（大和川を模した細長い河岸relation、outer 3本＋
  逆順1本＋中州1本）を新パイプラインに通すと `validateWaterGeometry` が `oversizedSegments: 0` で PASS。
  旧挙動を再現した3点レコード（暗黙閉合辺≒2km）は `no-oversized-segments` FAIL として検出される。
- `git diff --check`: 空白・改行問題なし（CRLF警告のみ。既存ファイルと同じ扱い）。

### 未解決 / 注意
1. **git index.lock**: 作業中 `.git/index.lock` が別プロセス（ユーザー側のgit / OneDrive）に掴まれており、
   Claude Code 側から git 操作ができなかった。今回のセッション2の変更はコミットしていない（未ステージ）。
2. **worktree から2ファイルが消えている**: `data/processed/osaka-city/boundaries/administrative-boundaries.json`
   と `data/reports/boundary-ingestion-validation.json`（どちらもコミット `94868ef` に含まれる）が
   作業ツリーから欠落し `deleted` 表示になっている。Claude は削除していない（OneDrive同期ずれか
   index.lock の影響と推定）。**コミットしないこと。`git restore <この2ファイル>` で復元できる**。
   参考: HEAD版の administrative-boundaries.json を検証したところ、24区・znorth-neg-v1変換済み・
   出典metadata完備で `tools/validate/boundary-ingestion.js` は全項目 PASS（P1-2の実データ検証は完了）。
3. **`config/areas/osaka-city.json` の BOM**: ユーザーがエディタで status を production へ変更した際に
   UTF-8 BOM 付き＋CRLF で保存され、`JSON.parse` が落ちるようになっていた。BOMなし・LF で書き直し、
   併せて `loadAreaConfig` に BOM 除去を追加した。**このファイルは BOMなし・LF で保存すること**。
   なお status は `staged` に戻した（BOM修正で書き直しが必要だったため）。コミット `94868ef` は
   `production` にしていたので、実データ検証が済んでいる以上 production へ戻して良い（1語変更）。
4. **`tools/convert/index.js` は `unclosed` を surface しない**: `convertWaterways()` は後方互換のため
   items のみ返す。オーケストレータで未連結relationを警告したい場合は `convertWaterwaysWithReport()` へ
   切り替える小改修が必要（今回スコープ外）。
5. 河川ライン（大和川など複数wayに分割された長い川の中心線）の way 連結は未実装。断片化・隙間は
   残る可能性があるが、「巨大三角形」は area 側の問題であり本修正で解消。line stitching は別タスク。
6. 実 `OSM_WATER` の再生成（`node tools/fetch-water.js --overpass ...`）はネットワーク必須のためローカルPC作業。

### 次に進むべき作業
- **A（ユーザー、ローカルPC）**: `git restore` で欠落2ファイルを復元 → セッション2の変更をレビュー・コミット →
  `node tools/fetch-water.js --overpass --coordinate-config data/buildings/coordinate-config.json --html public/osaka_3d_buildings.html`
  で `OSM_WATER` を再生成 → `npm run data:validate:water -- --html public/osaka_3d_buildings.html` が PASS することを確認 →
  ブラウザ（`npm run preview`）で大和川周辺の巨大三角形が消えていること、中州が抜けていることを目視確認。
- **B（次セッション）**: 河川ライン（waterway=river/canal の複数way）の端点連結。同 `tools/lib/osm-multipolygon.js`
  の `stitchWays` を line 用に流用できる。
- **C（次セッション）**: P1-3 — N03 24区ポリゴンから point-in-polygon 用 Ward polygon を生成するパイプライン設計。

---

## 2026-08-31 セッション1: N03エリア基盤 + 境界validator（P1-1/P1-2の一部）

### 実行したタスク
1. リポジトリ現状の全面調査（24区基盤の進捗、道路・河川geometryの乱れの原因）
2. `config/areas/osaka-city.json` の新設（24区共通エリア定義）
3. P1-2 境界取り込みvalidator（`tools/validate/boundary-ingestion.js` + lib + テスト）の実装
4. 実N03 24区データ（`temp/n03-validation/osaka-city-wards.json`）に対する検証実行
5. `MAP24_P1_RUNBOOK.md`（ローカルPCでの再取り込み・検証手順）作成

### 調査結果

**24区基盤（想定より進捗あり）**
- `config/wards/registry.json` は24区すべてを保持済み。
- `temp/n03-validation/osaka-city-wards.json`（本日更新、gitignore下）に、実N03 2026大阪府データから
  抽出済みの24区分の生 MultiPolygon（WGS84）が存在。`missingWards: []`。9ポリゴン(此花区: 夢洲/舞洲)、
  5ポリゴン(住之江区: 咲洲)など飛び地も正しく統合されている。
- ただし metadata の `license` / `referenceDate` / `retrievedUrl` が **null**（出典未記録）。
- まだ無いもの: `config/areas/osaka-city.json`（→本セッションで作成）、znorth-neg-v1 変換済み出力、
  P1-2 validator（→本セッションで作成）、21区の point-in-polygon 用ポリゴン。

**河川geometryの乱れ（原因特定）** — ※本セッションでは未修正。次セッション対象。
- `tools/fetch-water.js` に2つのバグ:
  1. 河川ライン（大和川など長い川）が複数OSM wayに分かれているのに連結せず、way単位で独立リボン化
     → 断片化・隙間。
  2. 河岸エリア（`relation/18530061-63` 等の multipolygon）の outer メンバー way を1本ずつ独立した
     「閉リング」として `triangulateShape` に渡している。実際は複数 member way を順に連結して1リングを
     作る必要がある。未連結の部分 way を閉ポリゴン扱いするため、**川を横断する最大1431mの巨大三角形**が
     生成される。inner ring（中州）も欠落。
- 実データ: `public/osaka_3d_buildings.html` 埋め込みの OSM_WATER 130件中 **12件が300m超の内部ジャンプ**。
- これが「川の輪郭の崩れ / line・polygonの乱れ / 他地物との不自然な重なり」の正体。

**道路geometryの乱れ（軽微）**
- OSM_ROADS 7047本 / 36518点中、500m超のセグメントジャンプは **1件のみ**。
- `tools/convert/roads.js` の `mergeParallelDuplicates`（並走上下線の統合）は機能している。
- 優先度は河川より低い。way単位の未連結は存在するが視覚的実害は小さい。

**ドキュメントと実コードの乖離（記録のみ、修正せず）**
- CLAUDE.md は「roads.json / waterways.json は存在しない」「HTMLは3800行」と記載しているが、実際は
  `osaka_3d_buildings.html`（6917行）に `OSM_ROADS` / `OSM_WATER` / `OSM_PARKS` が直接埋め込まれている。
  AUTODEV_RULES.md 1条により、ドキュメントの自動書き換えはせず記録に留める。ユーザー判断で更新のこと。

### 修正内容（新規追加のみ。既存ファイルの変更は package.json の test スクリプトのみ）

- **`config/areas/osaka-city.json`（新規）**
  - projection: osaka-sumiyoshi と数値完全一致（centerLat 34.604208 / centerLon 135.52502 /
    metersPerDegree 111320）。既存3区の建物座標は一切変化しない。
  - bbox: 実N03 24区ポリゴンの外接矩形（S34.586154/W135.343508/N34.768849/E135.599350）を外側へ丸めた
    S34.585/W135.342/N34.770/E135.601。
  - `status: "staged"`（production未確定。N03の出典記録付き再取り込み + validator通過で production へ）。
  - 都市レイヤーは tiling 前提（`tiling.enabled: false` + 注記）。24区展開は未着手であることを明記。
  - demographics.targetWards に24区名を列挙。
- **`tools/lib/boundary-ingestion-validator.js`（新規）**: `validateBoundaryIngestion()` / `evaluateRing()`。
  例外を投げず構造化結果を返す。自己交差は O(n²) セグメント交差スキャン、未連結multipolygonは
  「同一リング内の中央値セグメント長の20倍かつ800m超」ヒューリスティックで検出。
- **`tools/validate/boundary-ingestion.js`（新規）**: CLI ラッパ。`--input` / `--area` / `--report`。
  error重大度の失敗があれば exit 1。
- **`tests/boundary-ingestion-validator.test.js`（新規）**: 14テスト。
- **`package.json`（変更）**: test スクリプトへ `tests/n03-boundaries.test.js` と
  `tests/boundary-ingestion-validator.test.js` を追加（n03テストは従来 npm test 対象外だった）。
  `data:validate:boundaries` スクリプトを追加。
- **`MAP24_P1_RUNBOOK.md`（新規）**、**`MAP24_PROGRESS.md`（新規、本ファイル）**

### 変更ファイル一覧
```
新規: config/areas/osaka-city.json
新規: tools/lib/boundary-ingestion-validator.js
新規: tools/validate/boundary-ingestion.js
新規: tests/boundary-ingestion-validator.test.js
新規: MAP24_P1_RUNBOOK.md
新規: MAP24_PROGRESS.md
変更: package.json (test スクリプト + data:validate:boundaries)
```

### テスト結果
- `npm test`: **152 tests / 137 pass / 0 fail / 15 skip**（従来 116/101/0/15 から +36 tests。
  15 skip は従来どおり html-regression.test.js が標準候補パスに HTML が無いため）。
- `node --test tests/n03-boundaries.test.js`: 22 pass / 0 fail。
- `node --test tests/boundary-ingestion-validator.test.js`: 14 pass / 0 fail。
- 実データ検証: `node tools/validate/boundary-ingestion.js --input temp/n03-validation/osaka-city-wards.json --area osaka-city`
  → `provenance-recorded` の WARN 以外すべて PASS。自己交差・巨大セグメントなし。**RESULT: PASS**。
- `git diff --check`: 問題なし。作業ツリーは既存3区・protected HTML・production データを一切変更していない。

### 未解決事項
1. **実N03の出典付き再取り込み**（ユーザー選択済み: 「出典を記録して再取り込みしてから」）。
   `temp/n03-validation/osaka-city-wards.json` は license/referenceDate/retrievedUrl が空。
   `MAP24_P1_RUNBOOK.md` の手順でローカルPCから再実行が必要（元N03 GeoJSONの入手にネットワーク必要）。
2. `config/areas/osaka-city.json` は `status: "staged"`。上記1と validator 通過まで production 化しない。
3. **河川geometryの乱れ**（`tools/fetch-water.js` の multipolygon リング未連結・way未連結）は原因特定のみ。
   修正はネットワーク再取得を伴うため次セッション + ローカルPC作業。
4. 21区の point-in-polygon 用ポリゴン（Ward classification 用）は未生成（P1-3）。
5. 24区の都市レイヤー（道路・公園・鉄道・水域）タイル化は未着手（P1-3、`tiling` 設計が必要）。

### 次に進むべき作業
- **A（ユーザー、ローカルPC）**: `MAP24_P1_RUNBOOK.md` P1-1 手順で N03 を出典付き再取り込み →
  `tools/validate/boundary-ingestion.js` で検証 → PASS なら `config/areas/osaka-city.json` の
  `status` を production へ、`data/processed/osaka-city/boundaries/administrative-boundaries.json` をコミット。
- **B（次セッション）**: `tools/fetch-water.js` / `tools/convert/waterways.js` の multipolygon リング組み立て
  修正（outer メンバー way の連結、inner ring 保持）+ 未連結セグメント検出 validator + fixture テスト。
  実データ再取得はローカルPC。
- **C（次セッション）**: P1-3 — N03 24区ポリゴンから point-in-polygon 用 Ward polygon を生成する
  パイプライン設計（`tools/build-ward-poc-data.cjs` との接続、building.ward属性を正本にしない）。
