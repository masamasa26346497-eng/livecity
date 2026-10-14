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
