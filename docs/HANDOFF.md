# HANDOFF — 現在の状態と次の一手（GitHub正本）

> 最終更新: 2026-11-13（Mission 218 / Issue #64）。会話（Chat）をまたぐ引き継ぎの**唯一の正本**はこのリポジトリ。
> Chat の記憶・要約は正本ではない。矛盾したらここと、ここからリンクされた証拠（PR/Issue/Actions run/commit）を優先する。

## 0. 再開時 READ-FIRST ゲート（作業開始前に必ずこの順で）

1. `docs/HANDOFF.md`（本書）
2. `docs/ASSET_REGISTRY.md`（既存資産の所在・再利用可否）
3. `docs/DEVELOPMENT_STATUS.md`（機能別の状態語彙）
4. 関連 PR / Issue（下記リンク）
5. 実コミット（`git log` / `git ls-tree`。ドキュメントより実物が優先）
6. CI（Actions の該当 run）

ルール:
- 「見当たらない」≠「存在しない」。確認できないものは `unknown` と書く。断定しない。
- 再取得・再生成の**前に**、既存資産の場所（ASSET_REGISTRY）と再利用可否を確認する。
- **24区版を2区（住吉区系）スタンドアロンに置き換えない。**
- 状態語彙は `verified` / `implemented_unverified` / `blocked` / `missing` / `unknown` のみ。証拠のない完了を宣言しない。

## 1. 現在の状態（Issue #64 本文に記載の事実。以後の更新は再確認すること）

| 項目 | 内容 | 状態 | 根拠 |
|---|---|---|---|
| 24区取得・組立・北/中央LOD2 merge・実Chrome静的検証 | private data repo から24区取得、統合24区 942.2MiB、missingContent=0 | verified（当該 run 時点） | Actions run 43425976639 https://github.com/masamasa26346497-eng/livecity/actions/runs/43425976639 |
| 5地点 実クリックQA | 全FAIL。原因: `window.__mission37g.drillIds` が undefined | blocked | 同 run 43425976639 |
| 公開URLへの配信 | 未配信 | missing | Issue #64 |
| 以後の更新（run 43425976639 以降） | 未確認 | unknown | 要再確認 |

## 1b. クリックQA失敗の原因調査結果（2026-11-13・実コード確認）

- 原因: QA スクリプトが存在しない `window.__mission37g.drillIds` を呼んでいた。実際の pick フックは `window.__mission37dQA`（`public/mission37g-osaka-24ward-mvp.html` 内。`localhost` かつ `?qa=1` のときだけ公開）。`__mission37g` は stats オブジェクトで `drillIds` を持たない。
- 修正は**既に別ブランチにある**: `origin/mission152-lod2-parallel` の commit `cbd5353`（Mission 217）が QA を `__mission37dQA` 呼び出しへ修正、回帰テスト `tests/mission217-click-qa-api.test.mjs` あり。SHA固定の push-once QA テンプレートは `cf66614`。状態: implemented_unverified（修正後の実ブラウザ run は未確認）。
- 本ブランチ（main 由来）は 24区ビューア・QA ツールを含まないため、ここで再実装はしていない（二重修正を避けた）。
- 次の一手: `mission152-lod2-parallel` のテンプレート（`.github/workflows` 配置はオーナー操作が必要。Claude は workflow ファイルを変更できない）で実マウスクリックQAを走らせ、結果を §7 に追記。
- Preview: `vercel.json` は `/` → `/mission37g-osaka-24ward-mvp.html`（24区）。ただし Vercel project の存在・認証・24区データ(942MiB)の配信可否・PLATEAU 権利は未確認＝unknown。**開けるURLは現時点でなし（ブロッカー）**。無断公開になる配信は行っていない。

## 2. 次の一手

1. 実クリックQA失敗の原因修正（`window.__mission37g.drillIds` が定義されない件）。まず実コードで `__mission37g` の定義箇所を grep し、PR#50 系の統合で脱落したかを確認する。
2. 修正後に同じ run 構成で5地点クリックQAを再実行し、結果をここと DEVELOPMENT_STATUS に WRITE-BACK。
3. 配信（main/本番/公開）は**オーナーの事前承認後のみ**。

## 3. ブロッカー

- 5地点実クリックQA全FAIL（上記）。
- `.github/workflows` は Claude の GitHub App では書き込み不可。workflow 変更はオーナーが適用する。
- 進行中の Mission217 を妨げない（このドキュメント群は docs/ とテストのみ追加）。

## 4. リンク

- PR#24: 過去の24区・データ検証（内容は本書作成時点でこの checkout からは未確認 → unknown）
- PR#50: 新LOD2と統合（同上）
- PR#62: クラウド workflow（同上）
- Issue #64: 本ミッション
- 既存の経緯: `MAP24_PROGRESS.md`、`MISSION*_REPORT.md`、`MISSION36K_IMPLEMENTATION_STATUS.md`

## 5. 優先順位と約束

優先順位（上ほど先）:
1. 3D表示 / LOD2
2. クリック（建物選択・情報表示）
3. 駅・地名
4. 写真
5. 経路検索

方針:
- **観光優先**。**不動産機能は後回し**。
- **LOD1の色とLOD2の色を一致**させる。
- **24区を維持**する（2区版へ戻さない）。
- 事前承認が必要なもの（オーナー承認なしに行わない）: main への merge、本番反映、外部公開、有料API利用、ライセンス上の取り込み。
- 秘密情報（トークン・secret の値）はリポジトリ・Issue・PR に書かない。secret **名**のみ可。
- データ実体には触れない（本ドキュメント群はデータを変更しない）。

## 6. 終了時 WRITE-BACK（作業の最後に必ず）

次を `docs/HANDOFF.md`（§7 履歴に追記）と必要なら `docs/DEVELOPMENT_STATUS.md` に記録する:
- 変更した commit / PR（SHA・URL）
- 実行したテスト run（コマンド・結果・run URL）と**検証条件**
- 未検証の事項
- 障害
- 次の一手

最新状態が一意に分かるよう §1/§2 を更新し、**過去の情報は消さず**、§7 に証拠リンク付きで残す。

## 7. 履歴（新しいものを上に追記・削除しない）

- 2026-11-13 閲覧復旧依頼(Issue #64 コメント): drillIds undefined の原因を特定し、修正が `mission152-lod2-parallel` cbd5353 に既存と確認（§1b）。Actions/Vercel はこの環境から実行・確認不可（unknown）。

- 2026-11-13 Mission 218: 引き継ぎドキュメント一式と検証 `tools/validate/handoff-docs.js` を追加（Issue #64）。上記 §1 の事実は Issue 本文由来で、この checkout では run の結果を再確認していない。
