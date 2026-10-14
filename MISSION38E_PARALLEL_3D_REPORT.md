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
