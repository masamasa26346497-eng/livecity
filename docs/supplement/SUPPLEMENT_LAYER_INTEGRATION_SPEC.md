# 補完レイヤー接続仕様（案） — 高速化側は変更しない

## 合流先
- 高速化: PR #68（branch `claude/issue-67-20261114-1354`、直近報告 SHA `9fc02a3`・未確認）。安定側: PR #61。#64 は古い。**これらのブランチ/HTML は本PRで変更しない**。実SHAは接続時に再確認。
- 現行 HTML には旧 `derived-v2-osmv3` / `derived-v4-final` の `recovered-index.json` 読込（L14307/L14395付近、QA用）があるが、**接続済みの証拠にしない**（データ未配置）。

## 仕様
- 配置: `public/map-data/osaka-city/buildings-supplement/{wardId}/`（既存 `buildings/{wardId}/` とは別。上書きしない）。
- `manifest.json`（`schema: livecity-supplement-layer-v1`）: `defaultEnabled:false`、`lazyLoad:true`、`tileSize`（既存と同一）、`tiles[{tx,tz,file,count}]`、`publishable`、`license`、`existingRef`（照合した既存manifestのsha256）。
- タイル `tile_{tx}_{tz}.json`: 既存タイルと同形式（`id, fp, z0, dz, h`）＋ `polys`（内周/複数パート）, `heightSource`, `heightEstimated`(true/false/null), `heightAccuracy`, `status`, `matchedExistingIds`, `sourceId`。`h:null` は根拠なし（表示側既定値を使うなら「未確認」表示）。
- 表示側の最小変更案: (1) UI トグル（既定OFF）で初めて supplement manifest を fetch、(2) 可視タイルのみ遅延 fetch（既存の可視タイル管理に相乗り）、(3) 既存建物のクリック/高速化経路には触れず、補完は別 Group・別ピック対象、`status` 付きで「補完（未確認含む）」と表示、(4) `publishable:false` は本番配信に載せない。
- `hold.json` / `matched-existing.json` は検証用で配信しない。

## 状態
HTML 変更は未実施（PR #68 側の現行表示方式の確認後、独立 Draft PR で実施）。

## 第6段階の実装状況
- 独立モジュール実装済み: `public/supplement-layer/supplement-layer.js`（既定OFF・明示 enable・近距離のみ遅延取得・重複合流・disable/範囲外で abort/dispose・失敗隔離・publishable 未確認は読込拒否・高さ区分 measured/estimated/unverified/unknown・診断レコード除外・別 Group/別ピック）。
- テスト: `tests/supplement-layer.test.js`（**未実行**。fetch/メッシュ生成は注入モックの合成入力）。
- 接続案: `docs/supplement/proposed-integration/PR68-connection-snippet.md`。**本体HTML・PR#68 は未接続/未変更**。
- 未確認: PR#68 実ビューアの座標変換・色・高さ単位・ピック。THREE メッシュ生成（`createThreeMeshBuilder`）は実ブラウザ/実ビューアで未検証。
