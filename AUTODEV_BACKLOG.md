# Live City Auto Development Backlog

## 運用原則

このBacklogはユーザー不在時の自動開発候補を管理する。

AutoDevはこのファイルの上位から、
現在のコード・データ・AUTODEV_RULES.mdを確認し、
「1回の実行で安全に完結できる最優先タスクを1つだけ」選択する。

上位タスクでも、
仕様判断・破壊的変更・production変更・大規模リファクタが必要な場合は
無理に実装しない。

その場合は

NEEDS_USER_DECISION

または

BLOCKED

としてAUTODEV_REPORT.mdへ記録する。

完了したタスクは [x]、
未完了は [ ] とする。

---

# P0 — 安全性・基盤

## P0-1 Ward切替回帰テスト拡充

[x] 住吉区・東住吉区・平野区のWard切替について自動回帰テストを追加する

確認項目:

- switchWard()が正常に呼べる
- generation/superseded guardを破壊していない
- failed tile時にcommit abortされる既存挙動を維持
- WardAreaFill / WardBoundary / WardLabelがcurrentWardIdに追従
- Ward SelectorのdataReady=false区がfetch対象にならない

注意:

Ward lifecycleそのものを変更しないこと。

---

## P0-2 WARM / picking問題の調査

[x] hidden/disposed datasetとbuilding picking/raycastの現在の挙動を調査する

目的:

過去の調査で、
loaded-hidden meshまでraycast対象になる可能性が指摘されている。

今回はまず調査・再現テストを作る。

安全に局所修正できることが明確な場合のみ修正候補を作る。

Ward lifecycle全体の再設計が必要なら

NEEDS_USER_DECISION

で停止する。

---

## P0-3 superseded load cleanup調査

[x] FullWardManagerのsuperseded loadで残るhidden tile/metadataについて調査する

目的:

現在専用orphan cleanupは存在しない。

まずメモリリーク・不要geometry保持が本当に発生するかを
コードとテストで確認する。

自動的に新しいorphan cleanup機構を追加してはいけない。

必要性が確認された場合は
NEEDS_USER_DECISIONとして報告する。

---

# P1 — 大阪市24区化

## P1-1 残り21区の行政区境界取得パイプライン調査

[ ] 残り21区の行政区境界データを取り込む方法を調査・設計する

現在:

- 住吉区
- 東住吉区
- 平野区

のTOWN_POLYGONSのみ存在。

残り21区はpolygon未整備。

このタスクではまず:

- 既存ingestツール
- 既存GeoJSON入力仕様
- ward code
- coordinate transform
- znorth-neg-v1への変換
- polygon validation

を確認する。

外部データの取得元が不明確、
ライセンス確認が必要、
production/rawを変更する必要がある場合は
勝手に取得・上書きせず

NEEDS_USER_DECISION

として報告する。

---

## P1-2 Boundary ingestion validator

[ ] 行政区境界を追加した際に自動検証できるvalidatorを整備する

確認:

- polygon parse成功
- ward code一致
- polygonが空でない
- NaNなし
- 異常自己交差の検出可能性
- znorth-neg-v1整合
- 既存3区を壊していない

production変更禁止。

---

## P1-3 新Ward dataset自動生成

[ ] 新しい行政区polygonが利用可能になった場合、
build-ward-poc-data.cjsを使ってWard datasetを生成・検証する

必須:

- building.ward属性を正本にしない
- point-in-polygonを正本にする
- ID重複0
- ward間重複0
- manifest/tile整合
- coordinateConvention=znorth-neg-v1
- production releaseへ直接書かない

polygon未準備ならBLOCKED。

---

## P1-4 Ward Registry自動同期

[ ] config/wards/registry.json と Ward Selector のdataReady管理を改善する

目的:

dataset生成済みなのにdataReady=false、
または未生成なのにtrue、
という人的ミスを減らす。

ただしブラウザ起動時に24区分大量fetchする方式は禁止。

build時/validation時に静的判定できる方式を優先する。

---

# P2 — Ward UX

## P2-1 区名ラベル最終調整

[ ] Ward Labelの遠景視認性を実装上さらに調整可能か確認する

現在の見た目を大幅変更しない。

ユーザーの目視判断が必要な変更の場合は
実装せず候補だけAUTODEV_REPORT.mdへ書く。

---

## P2-2 Ward Selectorレスポンシブ対応

[ ] 狭い画面幅でWard Selectorが崩れないようCSSを改善する

条件:

- 既存デスクトップUIを壊さない
- JavaScript lifecycleに触れない
- CSS中心の小規模変更

---

## P2-3 Ward Selector keyboard accessibility

[ ] Esc/Enter/Arrow key等による基本操作を確認・改善する

既存UIを大規模変更しない。

---

# P3 — Performance

## P3-1 FPS計測基準整理

[ ] Ward UX追加前後でFPS/Draw Calls/triangle数を比較しやすくする診断方法を整理する

production UIへ常時表示を増やさない。

診断モードまたはテスト用途に限定する。

---

## P3-2 Ward Area Fill描画コスト確認

[ ] WardAreaFillLayer追加によるgeometry・draw call・memoryへの影響を静的に確認する

毎フレーム再生成されていないことも確認する。

問題が無ければ変更しない。

---

## P3-3 不要な毎フレーム処理監査

[ ] WardLabelLayer / WardBoundaryLayer / WardAreaFillLayer / Ward Selectorに
不要な毎フレームDOM生成・polygon計算・geometry rebuildがないか監査する

安全な局所最適化だけ実装可能。

大規模renderer変更は禁止。

---

# P4 — 観光機能の準備

## P4-1 Landmark Registry設計調査

[ ] 観光ランドマークをデータ駆動で追加するRegistry設計を調査する

想定項目:

- id
- name
- category
- coordinates
- wardId
- description
- image references
- detailPage

今回は設計・既存コード調査を優先。

ユーザー向け仕様判断が必要ならNEEDS_USER_DECISION。

---

# AutoDevが選んではいけないタスク

以下はユーザー不在時に自動実装しない。

- baseline変更
- production deploy
- main merge
- 座標規約変更
- Ward lifecycle大規模再設計
- ACTIVE1+WARM2 poolの新設
- Ward単位LRUの新設
- raw CityGML削除
- production building release上書き
- dependency大量更新
- UI全面リニューアル
- 課金/API key操作
- 外部有料サービス契約
- 大量ファイル削除

---

# タスク選択ルール

AutoDevは各実行で以下を行う。

1. AUTODEV_RULES.mdを読む
2. このBacklogを読む
3. git statusがcleanか確認
4. 上から未完了タスクを確認
5. 1回で安全に完結できるタスクを1件選ぶ
6. 調査
7. 最小変更
8. テスト
9. 自己レビュー
10. SUCCESSならタスクを[x]へ変更
11. AUTODEV_REPORT.mdへ結果記録
12. 条件を満たした場合のみAutoDevブランチへcommit

BLOCKED / NEEDS_USER_DECISIONの場合は
Backlogを[x]にしない。
