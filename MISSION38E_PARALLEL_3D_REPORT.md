# Mission 38E 系統A 報告

**本体 `mission37g-osaka-24ward-mvp.html` には未統合。** 独立プレビューのみ。

## ルート
- ルート1（公式PLATEAU取得）: **未実行**。外部通信がこの環境で承認されないため。新区（浪速/福島）のPLATEAU実建物は**追加していない**。
- ルート2（既存実形状のフォールバック）を採用: `public/__test__/ward-poc/buildings/osaka-hirano` の4 tileを3D Tiles化。

## 実測
| 項目 | 値 |
|---|---|
| 表示対象 | 平野区ポリゴン内の既存テスト用実形状（部分） |
| 建物数 | 4,695 棟（source 4,695 / 区外除外 0 / skipped 0） |
| tile 数 | leaf 4（5_-3, 5_-4, 6_-3, 6_-4）+ LOD 1 |
| 追加容量 | 約4.4MB（`public/mission38e-3dtiles`）。10MB以下 |
| canonicalId | 元の `bldg_<uuid>` を無改変で使用、4,695件すべて一意。新規採番なし |

## 限界・区判定の確度
- 元データはテスト用ファイルで、**PLATEAU原典との一致は未証明**。「PLATEAU 100%」とは主張しない。「既存テスト用実形状の部分3D可視化」。
- 上記 tile の `building.ward` ラベルは全件「東住吉区」で、格納フォルダ（平野区）と不一致。ラベルは使わず、N03区ポリゴン（`ward-classification-polygons.json`）への点内判定（footprint頂点平均）で再判定した。4 tile は全棟が平野区ポリゴン内と判定されたが、N03ポリゴンとテスト用座標の整合自体は独立検証していない。
- **新区カバレッジ（浪速・福島）は主張しない。** 37Hの5区（住吉/北/中央/天王寺/西）に対する追加区もない。

## プレビュー
- `public/mission38e-3d-preview.html?set=hirano-subset`（Cesium 1.121.1をCDNから読込。背景地図は既定なし、`?imagery=1`でOSM）。
- **ブラウザでの表示・回転・クリックQA: 未実施**（この環境ではCDN取得不可）。コードは37Bの検証済みpick経路（`canonicalId` + ids sidecar照合）と同型だが、実機表示は未確認。

## テスト
`node --test tests/mission38e-subset.test.cjs` → 6 tests / 6 pass / 0 fail。

## 再現
```
node tools/mission38e-build-subset.cjs --survey
node tools/mission38e-build-subset.cjs --dataset osaka-hirano --ward hirano --tiles 5_-3,5_-4,6_-3,6_-4
```

## 監査追記（再開ジョブ・区ラベル不整合）
`node tools/mission38e-audit-ward.cjs` で、対象4 tile + `tile_10_-1` の全棟を全24区のN03ポリゴンと突合した。
- 全5 tile（計5,432棟）: `building.ward` ラベルは全件「東住吉区」、N03判定は全件「平野区」のみ（複数区ヒット0・区外0）。
- したがって不整合は再現した。ただし**どちらが正しいかは本環境では未確定**。N03ポリゴンと テスト用座標が同一投影(`znorth-neg-v1`)であることの独立検証、およびラベルの出所の特定は未実施。ラベルは書き換えていない。
- 平野区の判定は「N03ポリゴン基準」であり、PLATEAU原典での裏付けではない。

## 実ブラウザQA（今回も未実施）
- この環境は外部通信不可で、Cesium 1.121.1 のCDN取得と、リポジトリ内にもCesiumのローカルコピーが無いため、表示・回転・クリック・404・JS例外の実測は**未計測**。
- ローカルで `public/` を静的配信し Chrome で `/mission38e-3d-preview.html?set=hirano-subset` を開いて確認が必要。
- 正式PLATEAU新規取得: 外部通信不可のため**未実施**。新区の追加なし。

## テスト
`node --test tests/mission38e-subset.test.cjs` → 7 tests / 7 pass / 0 fail（監査テスト1件を追加）。
`node --test tests/mission38e-subset.test.cjs tests/mission38e-ward-evidence.test.cjs` → 9 tests / 9 pass / 0 fail。

## 区ラベル不整合の解決（独立根拠あり）
**結論: 「東住吉区」は建物の実属性ではなく定数スタンプで、区の根拠にならない。平野区（N03判定）を採用する。**
1. `building.ward` は住吉区33,594・東住吉区38,266・平野区43,843＝計115,703棟すべてで「東住吉区」（`labelCensus()`）。実属性なら区ごとに分布が異なるはず。
2. `data/reports/building-ward-classification.json`: 全584,490棟が同ラベルで、「一致」扱いは東住吉区N03の38,489棟のみ。不一致サンプルは全件 attrWard=東住吉区（住之江区の座標の建物にも付く）。
3. 変換器 `tools/mission36k-convert-citygml-runtime.mjs:180` は `ward: meta.wardHint || ''` と引数をそのまま書く（CityGMLから区を読まない）。
4. 座標側の独立2系統: 旧 TOWN_POLYGONS 由来分類とN03判定が平野区で 43,625/43,843 一致（99.5%、`data/reports/ward-classification-vs-poc.json`）。
- 未確定: `znorth-neg-v1` 原点と実世界緯度経度のPLATEAU原典との直接照合は未実施（外部通信不可）。PLATEAU 100% とは書かない。ラベルは書き換えていない。

## Chrome 実機QAが不可能な理由と手順
- 理由: Cesium 1.121.1 をCDN読込、本環境は外部通信不可、ローカルコピーなし。
- 手順（ローカルPC）: `npx http-server public -p 8080` → Chrome で `http://localhost:8080/mission38e-3d-preview.html?set=hirano-subset` → Console にJS例外なし・Networkに404なし、左ドラッグで回転、建物クリックで `bldg_<uuid>` 表示を確認。

## 原点・ID の静的検証（今回ジョブ）
- `tests/mission38e-origin-check.test.cjs`（新規・外部通信なし）:
  - 平野区subset 4,695棟の footprint 重心を `config/areas/osaka-city.json` の投影（centerLat 34.604208 / centerLon 135.52502 / 111320 m/deg）で緯度経度へ逆変換 → 全棟が北緯34.58–34.66・東経135.50–135.60に入る。**この範囲は地理的な目安で公式境界ではなく、PLATEAU原典との照合ではない**（位置誤差の実測値ではなく粗い妥当性確認）。
  - 投影定数が37B/37C/設定と一致。
  - 平野区subsetのIDは住吉区・東住吉区テストデータと重複0。
- 合計テスト: `node --test tests/mission38e-*.test.cjs` → 12 tests / 12 pass / 0 fail。
- 未実施: 正式PLATEAU取得（外部通信不可。`tools/plateau-sources.json` の大阪市27100の url は null で、取得にはG空間情報センター/CKAN検索が必要）、Chrome QA、容量以外の性能測定、新区の追加。
- 24区展開の現実的手順（ローカルPC）: ①`tools/mission36k-fetch-citygml-ward-range.mjs` でHTTP Rangeにより対象メッシュのみ取得（ZIP全体は取得しない）→ ②`mission36k-convert-citygml-runtime.mjs` でJSONL化（`--ward-hint` は定数スタンプなので区判定にはN03点内判定を使う）→ ③`mission37h-build-ward-sample.cjs` で3D Tiles化 → ④既存IDとの重複0・原点逆変換・10MB以内をテストで確認。原点の厳密検証は、CityGML原座標と変換結果の直接照合（②の入出力比較）で行う。

## 新区(浪速区)最小メッシュ取得プラン（今回ジョブ・取得は未実施）
- 訂正: 前回「取得元URLが不明」としたのは `tools/plateau-sources.json`(大阪市 url:null)のみの話。既存の36K probe（`data/reports/mission36k-citygml-zip-probe.json`）には実URL・ETag・ZIP中央ディレクトリ実測値が記録済み。
  - 出典: PLATEAU 大阪市 CityGML（v4）`https://assets.cms.plateau.reearth.io/assets/40/a85f8e-049c-4b3f-a97b-4a217df787df/27100_osaka-shi_city_2024_citygml_1_op.zip`（1,523,942,100 B / ETag `982370ac…3fe` / Last-Modified 2025-03-31）。Range対応は36K probeで確認済み（本ジョブでは再確認していない）。ライセンス条件は未再確認。
- 新規 `tools/mission38e-plan-ward-mesh.cjs`（オフライン・読み取り専用）: probeのentryとN03区ポリゴンから、5×5サンプル点の区内率でメッシュを選定。出力 `public/mission38e-3dtiles/plans/naniwa-mesh-plan.json`。
- 浪速区の選定結果: メッシュ **51357399**（区内率 100%、圧縮 1,392,193 B ≒1.3MB、展開 34.5MB）。候補は9メッシュ。福島区も算出可能（テストのみ、ファイル未出力）。
- 取得コマンド（ネットワーク可能なローカルPCで）: `node tools/mission36k-fetch-citygml-ward-range.mjs --ward naniwa --meshes=51357399 --out temp/gml-naniwa` → `mission36k-convert-citygml-runtime.mjs` → `mission37h-build-ward-sample.cjs`。取得後に sha256 を記録すること。
- 未実施: 実取得・変換・3D Tiles化・sha256記録・Chrome QA。浪速区の建物は一棟も追加していない。既存5区＋平野区subset・本体37G・写真は無変更。
- テスト: `tests/mission38e-plan.test.cjs` を追加。`node --test tests/mission38e-*.test.cjs` → 17 tests / 17 pass / 0 fail（`npm test` は未実行）。
