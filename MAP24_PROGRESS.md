# 大阪市24区化 進捗レポート

大阪市24区の地図基盤構築（第一目標）の作業ログ。新しいエントリを上に追記する。

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
